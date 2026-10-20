import type { AdapterId } from './agent'

export type CostPeriod = '7d' | '30d' | 'all'

export const COST_PERIODS: { id: CostPeriod; label: string }[] = [
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'all', label: 'All time' }
]

export interface CostRun {
  id: number
  stage: string
  crewId: number | null
  adapter: AdapterId
  model: string
  loop: number
  startedAt: string
  result: string
  tokens: number
  /** What Claude Code reported for the run; null for Cursor runs and runs that reported nothing. */
  costUsd: number | null
}

export interface TicketCost {
  ticketId: number
  key: string
  title: string
  stage: string
  costUsd: number
  tokens: number
  runs: CostRun[]
}

/** Which tickets to list: the totals always cover the whole period. */
export interface CostListing {
  /** Matches the ticket key or title. */
  search?: string
  /** How many tickets to list; the screen asks for more as you scroll. */
  limit?: number
}

/** Tickets listed at a time on the Costs screen. */
export const COST_PAGE = 25

export interface CostReport {
  period: CostPeriod
  totals: { costUsd: number; tokens: number; tickets: number; forgeChats: number; runs: number }
  /** Most expensive first, up to the listing's limit. */
  tickets: TicketCost[]
  /** How many tickets match the search, listed or not. */
  matching: number
  forge: { chats: number; costUsd: number; tokens: number }
}

/** Every run's tokens, counting the cached input it read. */
export function runTokens(run: { tokensIn: number | null; tokensOut: number | null; tokensCached: number | null }): number {
  return (run.tokensIn ?? 0) + (run.tokensOut ?? 0) + (run.tokensCached ?? 0)
}
