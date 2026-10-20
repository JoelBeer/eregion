import type { AdapterId } from './agent'
import type { ToolCheck } from './types'

export interface ModelOption {
  id: string
  label: string
  /** Added by you in Settings › Agents rather than built in. */
  custom: boolean
}

/** The Claude models Eregion offers out of the box. Cursor's come from what you add. */
export const BUILT_IN_MODELS: Record<AdapterId, { id: string; label: string }[]> = {
  'claude-code': [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1' }
  ],
  cursor: [{ id: 'auto', label: 'Auto (Cursor picks)' }]
}

/** The cheapest model each agent is tested with. */
export const TEST_MODEL: Record<AdapterId, string> = { 'claude-code': 'claude-haiku-5-5', cursor: 'auto' }

export const TEST_PROMPT = 'Reply with the single word: ok'

export interface AgentTest {
  runtime: string
  at: string
  ok: boolean
  /** How long the reply took, start to finish. */
  ms: number
  signedIn: boolean
  usageReported: boolean
  costUsd: number | null
  /** The reply, or what went wrong. */
  detail: string
}

export interface AgentInfo {
  id: AdapterId
  name: string
  command: string
  /** The CLI as found in each runtime. */
  checks: ToolCheck[]
  models: ModelOption[]
  tests: AgentTest[]
  /** Where each project's agents run: its repos' runtime. */
  projects: { name: string; runtime: string }[]
  note: string
}

/**
 * Reads the JSON a headless test run prints. Claude Code prints one result object; anything else
 * (a sign-in prompt, a crash) is reported as it came.
 */
export function parseTestOutput(stdout: string, stderr: string, code: number): Omit<AgentTest, 'runtime' | 'at' | 'ms'> {
  const text = stdout.trim()
  const lastLine = text.split('\n').filter(Boolean).at(-1) ?? ''
  try {
    const result = JSON.parse(lastLine.startsWith('{') ? lastLine : text) as { is_error?: boolean; result?: string; total_cost_usd?: number; usage?: unknown }
    const reply = String(result.result ?? '').trim()
    const signedOut = /log ?in|logged out|invalid api key|authenticat/i.test(reply)
    return {
      ok: result.is_error !== true && /\bok\b/i.test(reply),
      signedIn: !signedOut,
      usageReported: typeof result.usage === 'object' && result.usage !== null,
      costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null,
      detail: reply || '(no reply)'
    }
  } catch {
    const detail = (stderr || stdout).trim().split('\n').slice(-3).join(' ') || `exited with code ${code}`
    return { ok: false, signedIn: !/log ?in|logged out|authenticat/i.test(detail), usageReported: false, costUsd: null, detail }
  }
}
