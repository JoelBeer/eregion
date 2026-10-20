import { COST_PAGE, runTokens, type CostListing, type CostPeriod, type CostReport, type CostRun, type TicketCost } from '@shared/costs'
import type { Db } from './db'

interface Row {
  id: number
  ticket_id: number | null
  chat_id: number | null
  key: string | null
  title: string | null
  ticket_stage: string | null
  stage: string
  crew_id: number | null
  adapter: CostRun['adapter']
  model: string
  loop: number
  started_at: string
  result: string
  tokens_in: number | null
  tokens_out: number | null
  tokens_cached: number | null
  cost_usd: number | null
}

const SINCE: Record<CostPeriod, string | null> = { '7d': '-7 days', '30d': '-30 days', all: null }

/** What a project's tickets and Forge chats cost over a period, from the usage each run reported. */
export function costReport(db: Db, projectId: number, period: CostPeriod, listing: CostListing = {}): CostReport {
  const since = SINCE[period]
  const rows = db
    .prepare(
      `SELECT r.id, r.ticket_id, r.chat_id, t.key, t.title, t.stage AS ticket_stage, r.stage, r.crew_id, r.adapter, r.model, r.loop,
              r.started_at, r.result, r.tokens_in, r.tokens_out, r.tokens_cached, r.cost_usd
       FROM runs r
       LEFT JOIN tickets t ON t.id = r.ticket_id
       LEFT JOIN chats c ON c.id = r.chat_id
       WHERE (t.project_id = @projectId OR c.project_id = @projectId)
         AND (@since IS NULL OR r.started_at >= datetime('now', @since))
       ORDER BY r.id`
    )
    .all({ projectId, since }) as Row[]

  const tickets = new Map<number, TicketCost>()
  const chats = new Set<number>()
  const forge = { chats: 0, costUsd: 0, tokens: 0 }
  for (const row of rows) {
    const run: CostRun = {
      id: row.id,
      stage: row.stage,
      crewId: row.crew_id,
      adapter: row.adapter,
      model: row.model,
      loop: row.loop,
      startedAt: row.started_at,
      result: row.result,
      tokens: runTokens({ tokensIn: row.tokens_in, tokensOut: row.tokens_out, tokensCached: row.tokens_cached }),
      costUsd: row.cost_usd
    }
    if (row.ticket_id !== null) {
      const ticket = tickets.get(row.ticket_id) ?? { ticketId: row.ticket_id, key: row.key ?? '', title: row.title ?? '', stage: row.ticket_stage ?? '', costUsd: 0, tokens: 0, runs: [] }
      ticket.runs.push(run)
      ticket.costUsd += run.costUsd ?? 0
      ticket.tokens += run.tokens
      tickets.set(row.ticket_id, ticket)
    } else if (row.chat_id !== null) {
      chats.add(row.chat_id)
      forge.costUsd += run.costUsd ?? 0
      forge.tokens += run.tokens
    }
  }
  forge.chats = chats.size
  const list = [...tickets.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens)
  const search = listing.search?.trim().toLowerCase() ?? ''
  const matching = search ? list.filter((ticket) => ticket.key.toLowerCase().includes(search) || ticket.title.toLowerCase().includes(search)) : list
  return {
    period,
    totals: {
      costUsd: list.reduce((sum, ticket) => sum + ticket.costUsd, 0) + forge.costUsd,
      tokens: list.reduce((sum, ticket) => sum + ticket.tokens, 0) + forge.tokens,
      tickets: list.length,
      forgeChats: forge.chats,
      runs: rows.length
    },
    tickets: matching.slice(0, Math.max(1, listing.limit ?? COST_PAGE)),
    matching: matching.length,
    forge
  }
}
