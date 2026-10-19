import type { Mood } from './robot'

export interface LinearComment {
  author: string
  body: string
  createdAt: string
}

/** What came in from Linear, refreshed on each poll. */
export interface LinearData {
  state?: string
  priority?: string
  estimate?: number | null
  labels?: string[]
  comments?: LinearComment[]
  assignee?: string | null
  /** Imported by a sync and not started yet: the card shows "New". */
  isNew?: boolean
  /** Assigned to someone else in Linear after work started here. */
  reassigned?: boolean
  pulledAt?: string
}

export type TicketStatus = 'idle' | 'running' | 'needs_you' | 'stopped' | 'done'
export type StopReason = 'blocked' | 'stuck' | 'setup_failed' | 'loop_limit' | 'ci_needs_you'
/** What a ticket that needs you is waiting for, when it isn't stopped. */
export type WaitingFor = 'answers' | 'approval' | 'manual-review' | 'ready-for-review' | 'slot'

export interface Ticket {
  id: number
  projectId: number
  linearId: string | null
  key: string
  title: string
  url: string | null
  description: string
  linear: LinearData
  pipelineVersion: number | null
  /** A stage id from the ticket's pipeline, or 'backlog' / 'done'. */
  stage: string
  status: TicketStatus
  stopReason: StopReason | null
  stopDetail: string | null
  waitingFor: WaitingFor | null
  /** Build pass number: 1 the first time. */
  loop: number
  reviewFailures: number
  extraLoops: number
  slot: number | null
  branch: string | null
  affectedRepos: string[]
  currentRunId: number | null
  planApprovedAt: string | null
  createdAt: string
  updatedAt: string
}

export const STOP_LABELS: Record<StopReason, string> = {
  blocked: 'Blocked',
  stuck: 'Stuck',
  setup_failed: 'Setup failed',
  loop_limit: 'Loop limit',
  ci_needs_you: 'CI needs you'
}

/** A ticket as the board shows it. */
export interface TicketCard {
  ticket: Ticket
  crewId: number | null
  pill: { status: 'running' | 'needsYou' | 'failed' | 'passed' | 'idle' | 'backlog' | 'neutral' | 'fixing' | 'waiting'; label: string } | null
  mood: Mood
  bubble: string | null
  tags: string[]
  links: { label: string; url: string }[]
  openUrl: string | null
}
