import type { AgentEvent } from './agent'

/** One tool call and, once it's back, its result. */
export interface ToolCall {
  id: string
  name: string
  summary: string
  /** Its place in the events, so a view can tell an earlier run's calls from the current run's. */
  index: number
  result: { ok: boolean; output: string } | null
}

/**
 * The conversation as a session panel shows it: each thing the agent says, with the tool calls it made
 * before saying anything else folded under it, and the lines from you and from Eregion in between.
 */
export type ConversationBlock =
  | { kind: 'say'; key: string; text: string; tools: ToolCall[] }
  | { kind: 'tools'; key: string; tools: ToolCall[] }
  | { kind: 'user'; key: string; text: string; dictated?: boolean; delivery?: 'now' | 'queue' }
  | { kind: 'system' | 'error'; key: string; text: string }

export function conversationBlocks(events: AgentEvent[]): ConversationBlock[] {
  const results = new Map<string, { ok: boolean; output: string }>()
  for (const event of events) if (event.kind === 'tool-result') results.set(event.id, { ok: event.ok, output: event.output })
  const blocks: ConversationBlock[] = []
  events.forEach((event, index) => {
    const key = String(index)
    switch (event.kind) {
      case 'tool': {
        const call: ToolCall = { id: event.id, name: event.name, summary: event.summary, index, result: results.get(event.id) ?? null }
        const last = blocks.at(-1)
        if (last && (last.kind === 'say' || last.kind === 'tools')) last.tools.push(call)
        else blocks.push({ kind: 'tools', key, tools: [call] })
        return
      }
      case 'text':
        blocks.push({ kind: 'say', key, text: event.text, tools: [] })
        return
      case 'user':
        blocks.push({ kind: 'user', key, text: event.text, dictated: event.dictated, delivery: event.delivery })
        return
      case 'result':
        if (!event.ok) blocks.push({ kind: 'error', key, text: event.text || 'The agent stopped with an error.' })
        return
      case 'system':
      case 'error':
        blocks.push({ kind: event.kind, key, text: event.text })
    }
  })
  return blocks
}

type ToolKind = 'command' | 'read' | 'edit' | 'search' | 'web' | 'other'

export function toolKind(name: string): ToolKind {
  if (/^(bash|shell|command|exec)/i.test(name)) return 'command'
  if (/^(read|notebookread|view)$/i.test(name)) return 'read'
  if (/^(edit|multiedit|write|notebookedit|apply_patch)$/i.test(name)) return 'edit'
  if (/^(grep|glob|ls|search|find)$/i.test(name)) return 'search'
  if (/^(webfetch|websearch|web_search)$/i.test(name)) return 'web'
  return 'other'
}

const WORDS: Record<ToolKind, (n: number) => string> = {
  command: (n) => `ran ${n} ${n === 1 ? 'command' : 'commands'}`,
  read: (n) => `read ${n} ${n === 1 ? 'file' : 'files'}`,
  edit: (n) => `edited ${n} ${n === 1 ? 'file' : 'files'}`,
  search: (n) => `searched ${n} ${n === 1 ? 'time' : 'times'}`,
  web: (n) => `looked up ${n} ${n === 1 ? 'page' : 'pages'}`,
  other: (n) => `used ${n} ${n === 1 ? 'tool' : 'tools'}`
}

/** What a burst of tool calls did, in a few words: "Ran 3 commands, read 2 files". */
export function describeTools(tools: Pick<ToolCall, 'name'>[]): string {
  const counts = new Map<ToolKind, number>()
  for (const tool of tools) counts.set(toolKind(tool.name), (counts.get(toolKind(tool.name)) ?? 0) + 1)
  const order: ToolKind[] = ['command', 'read', 'edit', 'search', 'web', 'other']
  const text = order
    .filter((kind) => counts.has(kind))
    .map((kind) => WORDS[kind](counts.get(kind) as number))
    .join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
