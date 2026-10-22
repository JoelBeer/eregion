/**
 * Cursor's CLI reports tokens but no cost (prices live on Cursor's servers), so a Cursor run's cost comes from
 * the Admin API's usage events afterwards: what Cursor charged for each request, aggregated hourly.
 */

/** One usage event from POST /teams/filtered-usage-events, as much of it as Eregion uses. */
export interface CursorUsageEvent {
  /** Epoch milliseconds. */
  timestamp: number
  conversationId?: string
  /** True for requests with no connected client, such as the CLI; false for the editor. */
  isHeadless?: boolean
  /** What Cursor charged for the request, in cents. */
  chargedCents: number
}

/** A Cursor run, as the matching needs it. */
export interface CursorRunWindow {
  id: number
  sessionId: string | null
  startedMs: number
  endedMs: number
  /** Its tokens, to split an event between runs that overlap. */
  tokens: number
}

/** How long after a run ends its cost is final: Cursor aggregates usage hourly. */
export const CURSOR_SETTLE_MS = 2 * 60 * 60 * 1000

/**
 * What each run cost, in cents. An event whose conversation is a run's session belongs to that run. Any other
 * headless event belongs to the runs going at the time; when several overlap, it's split by their tokens.
 * Editor requests (not headless) and events outside every run are left out.
 */
export function attributeCursorCosts(runs: CursorRunWindow[], events: CursorUsageEvent[], slackMs = 60_000): Map<number, number> {
  const cents = new Map(runs.map((run) => [run.id, 0]))
  const bySession = new Map(runs.filter((run) => run.sessionId).map((run) => [run.sessionId as string, run]))
  for (const event of events) {
    const own = event.conversationId ? bySession.get(event.conversationId) : undefined
    if (own) {
      cents.set(own.id, (cents.get(own.id) ?? 0) + event.chargedCents)
      continue
    }
    if (event.isHeadless === false) continue
    const going = runs.filter((run) => event.timestamp >= run.startedMs - slackMs && event.timestamp <= run.endedMs + slackMs)
    if (going.length === 0) continue
    const total = going.reduce((sum, run) => sum + run.tokens, 0)
    for (const run of going) {
      const share = total > 0 ? run.tokens / total : 1 / going.length
      cents.set(run.id, (cents.get(run.id) ?? 0) + event.chargedCents * share)
    }
  }
  return cents
}

/** SQLite's datetime('now') text, which is UTC, as epoch milliseconds. */
export function sqliteUtcMs(text: string): number {
  return Date.parse(`${text.replace(' ', 'T')}Z`)
}
