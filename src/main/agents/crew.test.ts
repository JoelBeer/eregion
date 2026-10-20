import { describe, expect, it } from 'vitest'
import { candidateSeeds, rank } from '@shared/crew'
import Database from 'better-sqlite3'
import { migrate, openDatabase } from '../db'
import { migrations } from '../db/schema'
import { TicketStore } from '../pipeline/stores'
import { ProjectStore } from '../projects/store'
import { CrewStore, crewStats } from './crew'
import { RunStore } from './runs'

describe('crew', () => {
  it('keeps hand-picked parts over the seed, and counts what each member shipped', () => {
    const db = openDatabase(':memory:')
    const crew = new CrewStore(db)
    const [ember, rivet] = crew.ensureDefaults('claude-code')
    const flux = crew.create({ name: 'Flux', role: 'Builder', adapter: 'claude-code', model: 'claude-haiku-5-5', seed: 42, parts: { eyes: 'visor', accessory: 'goggles' } })
    expect(crew.get(flux.id).parts).toEqual({ eyes: 'visor', accessory: 'goggles' })
    expect(crew.get(ember.id).parts).toBeUndefined()
    expect(crew.update(flux.id, { parts: {} }).parts).toBeUndefined()

    const project = new ProjectStore(db).create('Word Magic')
    const tickets = new TicketStore(db)
    const runs = new RunStore(db)
    const done = tickets.create({ projectId: project.id, key: 'WM-1', title: 'Shipped' })
    tickets.update(done.id, { stage: 'done', status: 'done' })
    const open = tickets.create({ projectId: project.id, key: 'WM-2', title: 'Open' })
    for (const [ticketId, crewId] of [
      [done.id, rivet.id],
      [done.id, rivet.id],
      [open.id, rivet.id],
      [done.id, ember.id]
    ]) {
      runs.create({ ticketId, stage: 'build', crewId, adapter: 'claude-code', model: 'm' })
    }
    expect(crewStats(db).find((stats) => stats.crewId === rivet.id)).toMatchObject({ shipped: 1, runs: 3 })
    expect(rank(0)).toBe('New hand')
    expect(rank(3)).toBe('Journeyman')
  })

  it('lets a crew member use any agent after migration 10, keeping the crew and what points at it', () => {
    // A database from before agent connectors: crew.adapter could only be claude-code or cursor.
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const migration of migrations.slice(0, 9)) db.exec(migration)
    db.pragma('user_version = 9')
    db.prepare("INSERT INTO crew (id, name, role, adapter, model, seed, parts) VALUES (7, 'Rivet', 'Builder', 'claude-code', 'claude-sonnet-5-5', 3, '{}')").run()
    expect(() => db.prepare("INSERT INTO crew (name, role, adapter, model, seed) VALUES ('Codey', 'Builder', 'codex', 'default', 4)").run()).toThrow()
    // Projects and tickets don't change in migration 10, so today's stores can fill them in.
    const project = new ProjectStore(db).create('Word Magic').id
    const ticket = new TicketStore(db).create({ projectId: project, key: 'WM-1', title: 'Hints' }).id
    db.prepare("INSERT INTO runs (ticket_id, stage, crew_id, adapter, model) VALUES (?, 'build', 7, 'claude-code', 'm')").run(ticket)
    db.prepare("INSERT INTO chats (project_id, crew_id, model) VALUES (?, 7, 'm')").run(project)

    migrate(db)
    expect(db.pragma('user_version', { simple: true })).toBe(migrations.length)
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
    const crew = new CrewStore(db)
    expect(crew.get(7)).toMatchObject({ name: 'Rivet', adapter: 'claude-code' })
    expect(db.prepare('SELECT crew_id FROM runs').get()).toEqual({ crew_id: 7 })
    expect(db.prepare('SELECT crew_id FROM chats').get()).toEqual({ crew_id: 7 })
    expect(crew.create({ name: 'Codey', role: 'Builder', adapter: 'codex', model: 'default', seed: 4 }).adapter).toBe('codex')
    // Foreign keys still work on the rebuilt table.
    crew.delete(7)
    expect(db.prepare('SELECT crew_id FROM runs').get()).toEqual({ crew_id: null })
  })

  it('offers the same eight candidates for a seed', () => {
    expect(candidateSeeds(7)).toEqual(candidateSeeds(7))
    expect(new Set(candidateSeeds(7)).size).toBe(8)
  })
})
