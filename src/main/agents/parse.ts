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
