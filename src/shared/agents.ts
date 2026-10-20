import type { AgentConnector } from './connectors'
import type { ToolCheck } from './types'

export interface ModelOption {
  id: string
  label: string
  /** Added by you in Settings › Agents rather than built in. */
  custom: boolean
}

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

/** An agent connector, as Settings › Agents shows it: where it's installed, its models and its last test. */
export interface AgentInfo extends Omit<AgentConnector, 'models'> {
  /** The CLI as found in each runtime. */
  checks: ToolCheck[]
  models: ModelOption[]
  tests: AgentTest[]
  /** Where each project's agents run: its repos' runtime. */
  projects: { name: string; runtime: string }[]
}
