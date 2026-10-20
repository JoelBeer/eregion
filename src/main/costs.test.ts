import { describe, expect, it } from 'vitest'
import { costReport } from './costs'
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
  })
})
