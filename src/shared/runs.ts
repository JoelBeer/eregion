import type { AdapterId, AgentEvent } from './agent'

export interface RunSummary {
  id: number
  ticketId: number | null
  chatId: number | null
  stage: string
  crewId: number | null
  adapter: AdapterId
  model: string
  loop: number
  sessionId: string | null
  startedAt: string
  endedAt: string | null
  /** The agent's last message when the run ended badly, such as a usage-limit notice. */
  endNote: string | null
  result: 'running' | 'done' | 'failed' | 'stopped'
  tokensIn: number | null
  tokensOut: number | null
  tokensCached: number | null
  costUsd: number | null
}

/** A run as a screen shows it: its record, live state, and everything it has done so far. */
export interface RunView {
  run: RunSummary
  /** `waiting` means a conversation is waiting for your reply. */
  state: 'running' | 'waiting' | 'done' | 'failed' | 'stopped'
  events: AgentEvent[]
  queued: number
  /** Whether "send now" reaches this agent before its turn ends (Claude Code yes, Cursor no). */
  takesMessagesMidRun: boolean
}

export interface CrewMember {
  id: number
  name: string
  role: 'Planner' | 'Builder' | 'Reviewer' | 'Shipper' | 'Forge only'
  adapter: AdapterId
  model: string
  seed: number
}
