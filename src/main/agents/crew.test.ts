import { describe, expect, it } from 'vitest'
import { candidateSeeds, rank } from '@shared/crew'
import { openDatabase } from '../db'
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

  it('offers the same eight candidates for a seed', () => {
    expect(candidateSeeds(7)).toEqual(candidateSeeds(7))
    expect(new Set(candidateSeeds(7)).size).toBe(8)
  })
})
