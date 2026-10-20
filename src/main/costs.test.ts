import { describe, expect, it } from 'vitest'
import { formatTokens, formatUsd } from '@shared/costs'
import { costReport, usageSummary } from './costs'
import { openDatabase } from './db'
import { RunStore } from './agents/runs'
import { CrewStore } from './agents/crew'
import { TicketStore } from './pipeline/stores'
import { ProjectStore } from './projects/store'

describe('costReport', () => {
  it('adds up each ticket and Forge chat from what its runs reported, most expensive first', () => {
    const db = openDatabase(':memory:')
    const projects = new ProjectStore(db)
    const tickets = new TicketStore(db)
    const crew = new CrewStore(db)
    crew.ensureDefaults('claude-code')
    const runs = new RunStore(db)
    const project = projects.create('Word Magic')
    const other = projects.create('Perch Peak')
    const cheap = tickets.create({ projectId: project.id, key: 'WM-1', title: 'Cheap' })
    const dear = tickets.create({ projectId: project.id, key: 'WM-2', title: 'Dear' })
    const elsewhere = tickets.create({ projectId: other.id, key: 'PP-1', title: 'Other project' })
    const [member] = crew.list()

    const run = (ticketId: number | null, chatId: number | null, cost: number | null, tokens: [number, number, number], adapter = 'claude-code') => {
      const created = runs.create({ ticketId, chatId, stage: ticketId ? 'build' : 'forge', crewId: member.id, adapter: adapter as 'claude-code', model: 'claude-sonnet-5-5' })
      db.prepare('UPDATE runs SET cost_usd = ?, tokens_in = ?, tokens_out = ?, tokens_cached = ?, result = ? WHERE id = ?').run(cost, ...tokens, 'done', created.id)
      return created.id
    }
    run(cheap.id, null, 0.1, [100, 10, 1000])
    run(dear.id, null, 0.4, [200, 20, 2000])
    run(dear.id, null, null, [50, 5, 0], 'cursor')
    run(elsewhere.id, null, 9, [1, 1, 1])
    const chat = Number(db.prepare("INSERT INTO chats (project_id, crew_id, model) VALUES (?, ?, 'claude-opus-5-5')").run(project.id, member.id).lastInsertRowid)
    run(null, chat, 0.05, [10, 1, 100])
    db.prepare("UPDATE runs SET started_at = datetime('now', '-40 days') WHERE ticket_id = ?").run(cheap.id)

    const all = costReport(db, project.id, 'all')
    expect(all.tickets.map((ticket) => [ticket.key, ticket.runs.length])).toEqual([
      ['WM-2', 2],
      ['WM-1', 1]
    ])
    expect(all.tickets[0].costUsd).toBeCloseTo(0.4)
    expect(all.tickets[0].tokens).toBe(2275)
    expect(all.tickets[0].runs[1]).toMatchObject({ adapter: 'cursor', costUsd: null })
    expect(all.forge).toMatchObject({ chats: 1, tokens: 111 })
    expect(all.totals.costUsd).toBeCloseTo(0.55)
    expect(all.totals).toMatchObject({ tickets: 2, forgeChats: 1, runs: 4 })

    const recent = costReport(db, project.id, '30d')
    expect(recent.tickets.map((ticket) => ticket.key)).toEqual(['WM-2'])

    // A page at a time, and a search, list fewer tickets but never change the totals.
    const first = costReport(db, project.id, 'all', { limit: 1 })
    expect(first.tickets.map((ticket) => ticket.key)).toEqual(['WM-2'])
    expect(first.matching).toBe(2)
    expect(first.totals).toEqual(all.totals)
    const found = costReport(db, project.id, 'all', { search: 'cheap' })
    expect(found.tickets.map((ticket) => ticket.key)).toEqual(['WM-1'])
    expect(found.matching).toBe(1)
    expect(found.totals).toEqual(all.totals)
  })
})

describe('usageSummary', () => {
  it("adds up today's and this month's runs in local time, Cursor's tokens with no spend", () => {
    const db = openDatabase(':memory:')
    const projects = new ProjectStore(db)
    const tickets = new TicketStore(db)
    const crew = new CrewStore(db)
    crew.ensureDefaults('claude-code')
    const runs = new RunStore(db)
    const project = projects.create('Word Magic')
    const other = projects.create('Perch Peak')
    const ticket = tickets.create({ projectId: project.id, key: 'WM-1', title: 'Hints' })
    const elsewhere = tickets.create({ projectId: other.id, key: 'PP-1', title: 'Other' })
    const [member] = crew.list()
    const now = new Date(2026, 9, 20, 15, 0)
    const at = (date: Date): string => date.toISOString().replace('T', ' ').slice(0, 19)
    const run = (ticketId: number, started: Date, cost: number | null, tokens: number, adapter = 'claude-code') => {
      const created = runs.create({ ticketId, chatId: null, stage: 'build', crewId: member.id, adapter: adapter as 'claude-code', model: 'm' })
      db.prepare('UPDATE runs SET started_at = ?, cost_usd = ?, tokens_in = ?, tokens_out = 0, tokens_cached = 0 WHERE id = ?').run(at(started), cost, tokens, created.id)
    }
    run(ticket.id, new Date(2026, 9, 20, 9, 0), 0.5, 1000)
    run(ticket.id, new Date(2026, 9, 20, 0, 5), null, 300, 'cursor')
    run(ticket.id, new Date(2026, 9, 19, 23, 55), 0.25, 200)
    run(ticket.id, new Date(2026, 8, 30, 12, 0), 9, 9000)
    run(elsewhere.id, new Date(2026, 9, 20, 10, 0), 4, 4000)

    const usage = usageSummary(db, project.id, now)
    expect(usage.today).toEqual({ costUsd: 0.5, tokens: 1300, runs: 2 })
    expect(usage.month.costUsd).toBeCloseTo(0.75)
    expect(usage.month).toMatchObject({ tokens: 1500, runs: 3 })
    expect([formatUsd(usage.today.costUsd), formatUsd(123.4), formatTokens(950), formatTokens(usage.today.tokens), formatTokens(2_278_762)]).toEqual(['$0.50', '$123', '950', '1k', '2.3M'])
  })
})

