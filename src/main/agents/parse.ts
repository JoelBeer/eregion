import { summariseTool, type AgentEvent, type Usage } from '@shared/agent'

type Json = Record<string, unknown>

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : []
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  return asArray(content)
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
}

function claudeUsage(usage: Json | undefined): Usage | null {
  if (!usage) return null
  const number = (key: string): number => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
  return {
    input: number('input_tokens') + number('cache_creation_input_tokens'),
    output: number('output_tokens'),
    cached: number('cache_read_input_tokens')
  }
}

/** Turns one line of `claude -p --output-format stream-json --verbose` into zero or more events. */
export function parseClaudeLine(line: string): AgentEvent[] {
  let message: Json
  try {
    message = JSON.parse(line) as Json
  } catch {
    return line.trim() ? [{ kind: 'system', text: line.trim() }] : []
  }
  switch (message.type) {
    case 'system':
      return message.subtype === 'init' ? [{ kind: 'init', sessionId: String(message.session_id ?? ''), model: String(message.model ?? '') }] : []
    case 'assistant': {
      if (message.parent_tool_use_id) return []
      const events: AgentEvent[] = []
      for (const part of asArray((message.message as Json | undefined)?.content)) {
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          events.push({ kind: 'text', text: part.text })
        } else if (part.type === 'tool_use') {
          const name = String(part.name ?? 'tool')
          events.push({ kind: 'tool', id: String(part.id ?? ''), name, summary: summariseTool(name, (part.input as Json) ?? {}) })
        }
      }
      return events
    }
    case 'user': {
      if (message.parent_tool_use_id) return []
      const content = (message.message as Json | undefined)?.content
      if (typeof content === 'string') return [{ kind: 'user', text: content }]
      return asArray(content)
        .filter((part) => part.type === 'tool_result')
        .map((part) => ({ kind: 'tool-result', id: String(part.tool_use_id ?? ''), ok: part.is_error !== true, output: contentText(part.content).slice(0, 4000) }) as AgentEvent)
    }
    case 'result':
      return [
        {
          kind: 'result',
          ok: message.subtype === 'success' && message.is_error !== true,
          text: typeof message.result === 'string' ? message.result : '',
          costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : null,
          usage: claudeUsage(message.usage as Json | undefined),
          turns: typeof message.num_turns === 'number' ? message.num_turns : 0
        }
      ]
    default:
      return []
  }
}

/**
 * Turns one line of `codex exec --json` into events. Codex reports items (messages, commands, file changes,
 * MCP calls) as they start and complete, and each turn's usage when it completes. Its input tokens include
 * the cached ones, so those are taken off to match the other agents.
 */
export function parseCodexLine(line: string): AgentEvent[] {
  let message: Json
  try {
    message = JSON.parse(line) as Json
  } catch {
    return line.trim() ? [{ kind: 'system', text: line.trim() }] : []
  }
  const item = (message.item as Json | undefined) ?? {}
  const id = String(item.id ?? '')
  switch (message.type) {
    case 'thread.started':
      return [{ kind: 'init', sessionId: String(message.thread_id ?? ''), model: '' }]
    case 'item.started':
      if (item.type === 'command_execution') return [{ kind: 'tool', id, name: 'Bash', summary: summariseTool('Bash', { command: item.command }) }]
      if (item.type === 'mcp_tool_call') return [{ kind: 'tool', id, name: `mcp__${String(item.server ?? '')}__${String(item.tool ?? '')}`, summary: `${String(item.server ?? '')} · ${String(item.tool ?? '')}` }]
      if (item.type === 'web_search') return [{ kind: 'tool', id, name: 'WebSearch', summary: `searched ${String(item.query ?? '')}` }]
      return []
    case 'item.completed':
      switch (item.type) {
        case 'agent_message':
          return typeof item.text === 'string' && item.text.trim() ? [{ kind: 'text', text: item.text }] : []
        case 'command_execution':
          return [{ kind: 'tool-result', id, ok: item.status === 'completed' && (item.exit_code === 0 || item.exit_code === undefined), output: String(item.aggregated_output ?? '').slice(0, 4000) }]
        case 'mcp_tool_call':
          return [{ kind: 'tool-result', id, ok: item.status === 'completed', output: JSON.stringify(item.result ?? item.error ?? '').slice(0, 4000) }]
        case 'web_search':
          return [{ kind: 'tool-result', id, ok: true, output: '' }]
        case 'file_change': {
          const paths = asArray(item.changes).map((change) => String(change.path ?? ''))
          return [
            { kind: 'tool', id, name: 'Edit', summary: `edited ${paths.join(', ')}` },
            { kind: 'tool-result', id, ok: item.status === 'completed', output: '' }
          ]
        }
        case 'error':
          return [{ kind: 'system', text: String(item.message ?? '') }]
        default:
          return []
      }
    case 'turn.completed': {
      const usage = (message.usage as Json | undefined) ?? {}
      const number = (key: string): number => (typeof usage[key] === 'number' ? (usage[key] as number) : 0)
      return [{ kind: 'result', ok: true, text: '', costUsd: null, usage: { input: Math.max(0, number('input_tokens') - number('cached_input_tokens')), output: number('output_tokens'), cached: number('cached_input_tokens') }, turns: 1 }]
    }
    case 'turn.failed':
      return [{ kind: 'result', ok: false, text: String(((message.error as Json | undefined) ?? {}).message ?? 'The turn failed'), costUsd: null, usage: null, turns: 1 }]
    case 'error':
      return [{ kind: 'error', text: String(message.message ?? '') }]
    default:
      return []
  }
}

/** A custom agent that prints plain text: every line is something it said. */
export function parseTextLine(line: string): AgentEvent[] {
  return line.trim() ? [{ kind: 'text', text: line }] : []
}

/**
 * Turns one line of `cursor-agent -p --output-format stream-json` into events. Cursor's stream uses
 * `tool_call` events with a started/completed subtype instead of content blocks.
 */
export function parseCursorLine(line: string): AgentEvent[] {
  let message: Json
  try {
    message = JSON.parse(line) as Json
  } catch {
    return line.trim() ? [{ kind: 'system', text: line.trim() }] : []
  }
  switch (message.type) {
    case 'system':
      return message.subtype === 'init' ? [{ kind: 'init', sessionId: String(message.session_id ?? message.chatId ?? ''), model: String(message.model ?? '') }] : []
    case 'assistant': {
      const text = contentText((message.message as Json | undefined)?.content)
      return text.trim() ? [{ kind: 'text', text }] : []
    }
    case 'tool_call': {
      const id = String(message.call_id ?? message.id ?? '')
      const call = (message.tool_call as Json | undefined) ?? {}
      const [key] = Object.keys(call)
      const detail = ((key ? call[key] : undefined) as Json | undefined) ?? {}
      const args = (detail.args as Json | undefined) ?? {}
      const name = key ? key.replace(/ToolCall$/, '') : 'tool'
      const normalised: Record<string, string> = { shell: 'Bash', edit: 'Edit', write: 'Write', read: 'Read', grep: 'Grep', glob: 'Glob', ls: 'Glob' }
      if (message.subtype === 'started') {
        const toolName = normalised[name] ?? name
        const input = toolName === 'Bash' ? { command: args.command } : toolName === 'Grep' ? { pattern: args.pattern, path: args.path } : { file_path: args.path, pattern: args.globPattern ?? args.path }
        return [{ kind: 'tool', id, name: toolName, summary: summariseTool(toolName, input) }]
      }
      if (message.subtype === 'completed') {
        const result = (detail.result as Json | undefined) ?? {}
        const ok = !('error' in result) && !('failure' in result)
        const success = (result.success as Json | undefined) ?? {}
        const output = typeof success.stdout === 'string' ? success.stdout : typeof success.content === 'string' ? success.content : ''
        return [{ kind: 'tool-result', id, ok, output: output.slice(0, 4000) }]
      }
      return []
    }
    case 'result': {
      const usage = (message.usage as Json | undefined) ?? undefined
      const number = (key: string): number => (usage && typeof usage[key] === 'number' ? (usage[key] as number) : 0)
      return [
        {
          kind: 'result',
          ok: message.subtype === 'success' && message.is_error !== true,
          text: typeof message.result === 'string' ? message.result : '',
          costUsd: null,
          usage: usage ? { input: number('inputTokens') + number('input_tokens'), output: number('outputTokens') + number('output_tokens'), cached: number('cacheReadTokens') + number('cache_read_input_tokens') } : null,
          turns: 1
        }
      ]
    }
    default:
      return []
  }
}
