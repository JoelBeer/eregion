/** One agent CLI's stream, normalised so every stage and screen handles Claude Code and Cursor alike. */

export type AdapterId = 'claude-code' | 'cursor'

export interface Usage {
  /** Input tokens billed at full price, including cache writes. */
  input: number
  output: number
  /** Input tokens read from the prompt cache. */
  cached: number
}

export type AgentEvent =
  | { kind: 'init'; sessionId: string; model: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; summary: string }
  | { kind: 'tool-result'; id: string; ok: boolean; output: string }
  | { kind: 'user'; text: string; dictated?: boolean; delivery?: 'now' | 'queue' }
  | { kind: 'result'; ok: boolean; text: string; costUsd: number | null; usage: Usage | null; turns: number }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string }

export const ADAPTER_LABELS: Record<AdapterId, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor CLI'
}

/** The first sentence of an agent message, cut to 80 characters: what the board's speech bubble shows. */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const match = flat.match(/^.*?[.!?](?=\s|$)/)
  const sentence = match ? match[0] : flat
  return sentence.length > 80 ? `${sentence.slice(0, 79).trimEnd()}…` : sentence
}

/** One line describing a tool call, the way the session panel shows it. */
export function summariseTool(name: string, input: Record<string, unknown>): string {
  const str = (key: string): string => (typeof input[key] === 'string' ? (input[key] as string) : '')
  switch (name) {
    case 'Bash':
      return `$ ${str('command').split('\n')[0]}`
    case 'Edit':
    case 'MultiEdit':
      return `edited ${str('file_path')}`
    case 'Write':
      return `wrote ${str('file_path')}`
    case 'Read':
      return `read ${str('file_path')}`
    case 'Grep':
      return `searched for ${str('pattern')}${str('path') ? ` in ${str('path')}` : ''}`
    case 'Glob':
      return `listed ${str('pattern')}`
    case 'WebFetch':
      return `fetched ${str('url')}`
    case 'WebSearch':
      return `searched the web for ${str('query')}`
    case 'TodoWrite':
      return 'updated its to-do list'
    case 'Task':
      return `started a helper: ${str('description')}`
    default:
      return name
  }
}
