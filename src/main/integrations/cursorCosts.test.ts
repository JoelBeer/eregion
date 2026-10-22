import { describe, expect, it } from 'vitest'
import { costReport } from '../costs'
import { openDatabase, type Db } from '../db'
import { CursorCosts, parseCursorEmail } from './cursorCosts'
import type { FetchLike } from './linear'
import { PLAIN_CODEC } from './linearAuth'

const NOW = Date.UTC(2026, 9, 21, 18, 0, 0)
const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * 3_600_000).toISOString().replace('T', ' ').slice(0, 19)

function setup(events: unknown[], status = 200) {
  const db: Db = openDatabase(':memory:')
  const project = db.prepare("INSERT INTO projects (name, initials, color) VALUES ('Word Magic', 'WM', '#000')").run().lastInsertRowid
  const chat = db.prepare("INSERT INTO chats (project_id, model, adapter) VALUES (?, 'auto', 'cursor')").run(project).lastInsertRowid
  const run = db.prepare('INSERT INTO runs (chat_id, stage, adapter, model, session_id, started_at, ended_at, result, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  const settled = run.run(chat, 'chat', 'cursor', 'auto', 'chat-a', at(4), at(3), 'done', 900, 100).lastInsertRowid
  const recent = run.run(chat, 'chat', 'cursor', 'auto', 'chat-b', at(1), at(0.5), 'done', 900, 100).lastInsertRowid
  run.run(chat, 'chat', 'claude-code', 'claude-sonnet-5-5', 'claude-c', at(4), at(3), 'done', 900, 100)
  const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
    return { ok: status === 200, status, json: async () => ({ usageEvents: events, pagination: { hasNextPage: false } }), text: async () => 'nope' }
  }
  const costs = new CursorCosts(db, PLAIN_CODEC, async () => 'joel@example.com', fetchImpl, () => NOW)
  return { db, costs, calls, settled, recent, project: Number(project) }
}

describe('CursorCosts', () => {
  it("fills in what Cursor charged once a run has settled, and leaves newer runs pending", async () => {
    const { db, costs, calls, settled, recent, project } = setup([
      { timestamp: String(NOW - 3.5 * 3_600_000), conversationId: 'chat-a', isHeadless: true, chargedCents: 123 },
      { timestamp: String(NOW - 0.75 * 3_600_000), isHeadless: true, chargedCents: 40 },
      { timestamp: String(NOW - 0.75 * 3_600_000), isHeadless: false, chargedCents: 999 }
    ])
    const status = await costs.saveKey('  key_abc  ')
    expect(calls[0].url).toBe('https://api.cursor.com/teams/filtered-usage-events')
    expect(calls[0].headers.authorization).toBe(`Basic ${Buffer.from('key_abc:').toString('base64')}`)
    expect(calls.at(-1)?.body).toMatchObject({ email: 'joel@example.com', endDate: NOW, page: 1, pageSize: 1000 })
    expect(status).toMatchObject({ configured: true, email: 'joel@example.com', lastError: null, pending: 1 })

    const row = (id: number | bigint) => db.prepare('SELECT cost_usd, cost_source FROM runs WHERE id = ?').get(id)
    expect(row(settled)).toEqual({ cost_usd: 1.23, cost_source: 'cursor' })
    expect(row(recent)).toEqual({ cost_usd: null, cost_source: null })

    const report = costReport(db, project, 'all', {}, { cursorCosts: costs.configured() })
    expect(report.forge.costUsd).toBeCloseTo(1.23)
  })

  it("doesn't save a key Cursor refuses", async () => {
    const { costs } = setup([], 401)
    await expect(costs.saveKey('bad')).rejects.toThrow("Cursor didn't accept the Admin API key")
    expect(costs.status().configured).toBe(false)
  })

  it('keeps the error to show in Settings when a check fails', async () => {
    const { costs, db } = setup([])
    await costs.saveKey('key_abc')
    db.prepare("UPDATE runs SET cost_source = NULL, cost_usd = NULL WHERE adapter = 'cursor'").run()
    const failing = new CursorCosts(db, PLAIN_CODEC, async () => null, async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'down' }), () => NOW)
    await failing.sync()
    expect(failing.status().lastError).toBe("Cursor's Admin API answered 500: down")
  })
})

it('reads the account from cursor-agent status', () => {
  expect(parseCursorEmail('✓ Logged in as joel@perchpeek.com\nTeam: PerchPeek (id 1)')).toBe('joel@perchpeek.com')
  expect(parseCursorEmail('Not logged in')).toBeNull()
})
