import type { AdapterId, AgentEvent } from '@shared/agent'
import type { RunSummary } from '@shared/runs'
import type { Db } from '../db'
import type { SessionOutcome } from './session'

interface RunRow {
  id: number
  ticket_id: number | null
  chat_id: number | null
  stage: string
  crew_id: number | null
  adapter: AdapterId
  model: string
  loop: number
  session_id: string | null
  started_at: string
  ended_at: string | null
  result: RunSummary['result']
  tokens_in: number | null
  tokens_out: number | null
  tokens_cached: number | null
  cost_usd: number | null
  last_result: string | null
}

/** Each run with its last result event, so a summary can say why a run failed. */
const SELECT_RUN = "SELECT runs.*, (SELECT payload FROM events e WHERE e.run_id = runs.id AND e.type = 'result' ORDER BY e.id DESC LIMIT 1) AS last_result FROM runs"

function endNote(payload: string | null): string | null {
  if (!payload) return null
  const result = JSON.parse(payload) as { ok?: boolean; text?: string }
  return result.ok === false ? result.text || null : null
}

function toSummary(row: RunRow): RunSummary {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    chatId: row.chat_id,
    stage: row.stage,
    crewId: row.crew_id,
    adapter: row.adapter,
    model: row.model,
    loop: row.loop,
    sessionId: row.session_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    result: row.result,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    tokensCached: row.tokens_cached,
    costUsd: row.cost_usd,
    endNote: endNote(row.last_result)
  }
}

export interface NewRun {
  ticketId?: number | null
  chatId?: number | null
  stage: string
  crewId: number | null
  adapter: AdapterId
  model: string
  loop?: number
}

/** Runs, the events each one produced, and the messages you sent it. */
export class RunStore {
  constructor(private readonly db: Db) {}

  create(run: NewRun): RunSummary {
    const result = this.db
      .prepare('INSERT INTO runs (ticket_id, chat_id, stage, crew_id, adapter, model, loop) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(run.ticketId ?? null, run.chatId ?? null, run.stage, run.crewId, run.adapter, run.model, run.loop ?? 1)
    return this.get(Number(result.lastInsertRowid))
  }

  get(id: number): RunSummary {
    const row = this.db.prepare(`${SELECT_RUN} WHERE id = ?`).get(id) as RunRow | undefined
    if (!row) throw new Error(`Run ${id} not found`)
    return toSummary(row)
  }

  forTicket(ticketId: number): RunSummary[] {
    return (this.db.prepare(`${SELECT_RUN} WHERE ticket_id = ? ORDER BY id`).all(ticketId) as RunRow[]).map(toSummary)
  }

  forChat(chatId: number): RunSummary[] {
    return (this.db.prepare(`${SELECT_RUN} WHERE chat_id = ? ORDER BY id`).all(chatId) as RunRow[]).map(toSummary)
  }

  setSession(id: number, sessionId: string): void {
    this.db.prepare('UPDATE runs SET session_id = ? WHERE id = ?').run(sessionId, id)
  }

  addEvent(runId: number, event: AgentEvent): void {
    // A run can be deleted with its Forge chat while its last events are still arriving.
    this.db.prepare('INSERT INTO events (run_id, type, payload) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM runs WHERE id = ?)').run(runId, event.kind, JSON.stringify(event), runId)
  }

  events(runId: number): AgentEvent[] {
    return (this.db.prepare('SELECT payload FROM events WHERE run_id = ? ORDER BY id').all(runId) as { payload: string }[]).map((row) => JSON.parse(row.payload) as AgentEvent)
  }

  addMessage(runId: number, text: string, delivery: 'now' | 'queue', dictated: boolean, status: 'queued' | 'delivered'): number {
    const result = this.db
      .prepare(`INSERT INTO messages (run_id, text, dictated, delivery, status, delivered_at) VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'delivered' THEN datetime('now') END)`)
      .run(runId, text, dictated ? 1 : 0, delivery, status, status)
    return Number(result.lastInsertRowid)
  }

  markDelivered(runId: number): void {
    this.db.prepare("UPDATE messages SET status = 'delivered', delivered_at = datetime('now') WHERE run_id = ? AND status = 'queued'").run(runId)
  }

  queuedCount(runId: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE run_id = ? AND status = 'queued'").get(runId) as { n: number }).n
  }

  /** Records how a run ended. Does nothing if the run was deleted meanwhile (with its Forge chat). */
  finish(id: number, outcome: SessionOutcome): void {
    this.db
      .prepare("UPDATE runs SET ended_at = datetime('now'), result = ?, session_id = COALESCE(?, session_id), tokens_in = ?, tokens_out = ?, tokens_cached = ?, cost_usd = ? WHERE id = ?")
      .run(outcome.state, outcome.sessionId, outcome.usage?.input ?? null, outcome.usage?.output ?? null, outcome.usage?.cached ?? null, outcome.costUsd, id)
  }

  /** Runs left "running" by a previous app session can't be resumed: mark them stopped. */
  closeAbandoned(): number {
    return this.db.prepare("UPDATE runs SET result = 'stopped', ended_at = datetime('now') WHERE result = 'running'").run().changes
  }
}
