import type { Mood } from './robot'

export interface LinearComment {
  author: string
  body: string
  createdAt: string
}

/** What came in from the ticket's tracker (Linear, GitHub, Jira or GitLab), refreshed on each poll. */
export interface LinearData {
  state?: string
  priority?: string
  estimate?: number | null
  labels?: string[]
  comments?: LinearComment[]
  assignee?: string | null
  /** The assignee's id in the tracker, for telling whether it's still assigned to whoever this project imports for. */
  assigneeId?: string | null
  /** Which tracker the issue is in. Tickets from before sources came from Linear. */
  source?: 'linear' | 'github-issues' | 'jira' | 'gitlab-issues'
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

export type StageLoops = Record<string, { failures: number; extra: number }>

/** How many times a stage's work has failed on this ticket, and how many it's allowed. */
export function stageLoops(ticket: Pick<Ticket, 'loops'>, stageId: string, maxLoops: number): { failures: number; allowed: number } {
  const entry = ticket.loops[stageId] ?? { failures: 0, extra: 0 }
  return { failures: entry.failures, allowed: maxLoops + entry.extra }
}

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
  /** Pass number: 1 the first time, one more each time the work goes back round. */
  loop: number
  /** Per stage id: how many times its work failed, and the extra loops you allowed past its limit. */
  loops: StageLoops
  /** The stage whose failed work sent the ticket back, until that stage passes. */
  returnedFrom: string | null
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
