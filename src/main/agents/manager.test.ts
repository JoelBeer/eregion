import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { robotFromSeed } from '@shared/robot'
import { openDatabase } from '../db'
import { NativeRunner } from '../runner/native'
import { CrewStore, seedWithPalette } from './crew'
import { AgentManager, type RunNotice } from './manager'
import { RunStore } from './runs'

const FAKE = ['node', resolve('src/main/testing/fake-claude.mjs')]

describe('CrewStore', () => {
  it('creates the default crew once, on the installed agent, keeping their colours', () => {
    const crew = new CrewStore(openDatabase(':memory:'))
    const members = crew.ensureDefaults('claude-code')
    expect(members.map((member) => [member.name, member.role, member.adapter, member.model])).toEqual([
      ['Ember', 'Planner', 'claude-code', 'claude-opus-5-5'],
      ['Rivet', 'Builder', 'claude-code', 'claude-sonnet-5-5'],
      ['Anvil', 'Reviewer', 'claude-code', 'claude-opus-5-5'],
      ['Ingot', 'Shipper', 'claude-code', 'claude-sonnet-5-5']
    ])
    expect(members.map((member) => robotFromSeed(member.seed).palette)).toEqual(['ember', 'teal', 'periwinkle', 'brass'])
    expect(crew.ensureDefaults('cursor')).toHaveLength(4)
    expect(crew.byRole('Builder')?.name).toBe('Rivet')
  })

  it('finds a seed with the wanted palette', () => {
    expect(robotFromSeed(seedWithPalette('lilac')).palette).toBe('lilac')
  })
})

describe.skipIf(process.platform === 'win32')('AgentManager', () => {
  async function setup() {
    const db = openDatabase(':memory:')
    const runs = new RunStore(db)
    const crew = new CrewStore(db).ensureDefaults('claude-code')
    const notices: RunNotice[] = []
    const manager = new AgentManager(runs, (notice) => notices.push(notice), () => FAKE)
    const project = db.prepare("INSERT INTO projects (name, initials, color) VALUES ('P', 'P', '#000')").run()
    const ticket = db.prepare("INSERT INTO tickets (project_id, key, title) VALUES (?, 'P-1', 'T')").run(project.lastInsertRowid)
    const cwd = await mkdtemp(join(tmpdir(), 'eregion-manager-'))
    return { db, runs, crew, notices, manager, ticketId: Number(ticket.lastInsertRowid), cwd }
  }

  it('saves events, messages and the outcome of a run, and passes events on', async () => {
    const { manager, runs, crew, notices, ticketId, cwd } = await setup()
    const { runId, done } = manager.start({ ticketId, stage: 'build', crew: crew[1], runner: new NativeRunner(), cwd, prompt: 'slow', profile: 'build' })
    await new Promise((wait) => setTimeout(wait, 300))
    expect(manager.send(runId, 'use the existing view', 'queue', true)).toBe('queued')
    expect(manager.view(runId).queued).toBe(1)
    const outcome = await done
    expect(outcome.state).toBe('done')

    const view = manager.view(runId)
    expect(view.state).toBe('done')
    expect(view.queued).toBe(0)
    expect(view.run).toMatchObject({ stage: 'build', adapter: 'claude-code', model: 'claude-sonnet-5-5', result: 'done', sessionId: 'fake-session-1', tokensIn: 210, tokensOut: 40, tokensCached: 100 })
    expect(view.run.costUsd).toBeCloseTo(0.02)
    expect(view.events.filter((event) => event.kind === 'user')).toEqual([{ kind: 'user', text: 'use the existing view', dictated: true, delivery: 'queue' }])
    expect(runs.forTicket(ticketId)).toHaveLength(1)
    expect(notices.some((notice) => notice.type === 'run-event' && notice.event.kind === 'text')).toBe(true)
    expect(notices.at(-1)).toEqual({ type: 'run-state', runId, state: 'done', queued: 0 })
    expect(() => manager.send(runId, 'late', 'now')).toThrow('This run has ended')
  })

  it('marks runs left over from a previous session as stopped', async () => {
    const { runs, ticketId, crew } = await setup()
    const run = runs.create({ ticketId, stage: 'plan', crewId: crew[0].id, adapter: 'claude-code', model: 'm' })
    expect(runs.closeAbandoned()).toBe(1)
    expect(runs.get(run.id).result).toBe('stopped')
  })
})
