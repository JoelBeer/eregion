import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ticket } from '@shared/tickets'
import { createBackend, type Backend } from './api'
import { openDatabase } from './db'
import { makeRepo } from './testing/git'

const FAKE = ['node', resolve('src/main/testing/fake-claude.mjs')]

const plan = `# Plan · WM-1 · Hints

## Summary
Hints.

## Affected repos
- app: changes · hints

## Steps
1. [app] Add HINTS.md

## Open questions
- None

## Decided while planning
- None

## Done when
- HINTS.md exists
`
const notes = (pass: number) =>
  `# Build notes · WM-1 · pass ${pass}\n\n## Summary\nPass ${pass}.\n\n## Changes\n### app\n- HINTS.md: added\n\n## Checks run\n- None\n\n## Decisions\n- None\n\n## Deviations from the plan\n- None\n\n## Blocked\nNone\n`
const failed = JSON.stringify({
  loop: 1,
  verdict: 'fail',
  summary: 'Thin.',
  issues: [
    { id: 'r1-1', severity: 'high', repo: 'app', file: 'HINTS.md', line: null, problem: 'Empty.', fix: 'Fill it.' },
    { id: 'r1-2', severity: 'low', repo: 'app', file: 'HINTS.md', line: null, problem: 'Wordy.', fix: 'Trim.' }
  ]
})
const fixes = JSON.stringify({
  loop: 2,
  fixes: [
    { issueId: 'r1-1', fixed: true, files: ['HINTS.md'], note: '' },
    { issueId: 'r1-2', fixed: false, files: [], note: 'Already short.' }
  ]
})

async function until(backend: Backend, id: number, check: (ticket: Ticket) => boolean, timeoutMs = 30_000): Promise<Ticket> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ticket = backend.tickets.get(id)
    if (check(ticket)) return ticket
    await new Promise((wait) => setTimeout(wait, 50))
  }
  throw new Error(`Timed out. Ticket is ${JSON.stringify(backend.tickets.get(id))}`)
}

afterEach(() => {
  delete process.env.EREGION_FAKE_SCRIPT
})

describe.skipIf(process.platform === 'win32')('ticket outputs and diff', () => {
  it('keeps fixes from Build pass 2 after the next review, and tags the files they changed', async () => {
    const script = join(await mkdtemp(join(tmpdir(), 'eregion-script-')), 'script.json')
    await writeFile(
      script,
      JSON.stringify([
        { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan }, reply: 'Ready.' },
        { when: 'Stage: Build, pass 1', write: { '{cwd}/app/HINTS.md': '', '{outputs}/build-notes.md': notes(1) }, reply: 'Built.' },
        { when: 'Stage: Review, loop 1', write: { '{outputs}/review.json': failed }, reply: 'Fail.' },
        { when: 'Stage: Build, pass 2', write: { '{cwd}/app/HINTS.md': 'First letter.\n', '{outputs}/build-notes.md': notes(2), '{outputs}/fixes.json': fixes }, reply: 'Fixed.' },
        { when: 'Stage: Review, loop 2', write: { '{outputs}/review.json': JSON.stringify({ loop: 2, verdict: 'pass', summary: 'Good.', issues: [] }) }, reply: 'Pass.' }
      ])
    )
    process.env.EREGION_FAKE_SCRIPT = script

    const backend = createBackend(
      openDatabase(':memory:'),
      { appVersion: '0.1.0', databasePath: ':memory:', pickFolder: async () => null, pickSaveFile: async () => null, pickOpenFile: async () => null, openExternal: async () => undefined, emit: () => undefined },
      { agentCommand: () => FAKE, workspaceRoot: await mkdtemp(join(tmpdir(), 'eregion-api-')) }
    )
    const { api } = backend
    await api.checkTools()
    const repo = await makeRepo({ 'README.md': 'app' })
    const project = await api.createProject('Word Magic')
    await api.addRepo(project.id, { name: 'app', path: repo.clone, runtime: 'native', defaultBranch: 'main' })
    const ticket = await api.createTicket(project.id, 'Hints', 'Show a hint.')

    await api.startTicket(ticket.id)
    await until(backend, ticket.id, (item) => item.waitingFor === 'approval')
    await api.approvePlan(ticket.id)
    await until(backend, ticket.id, (item) => item.waitingFor === 'manual-review')

    const outputs = await api.getTicketOutputs(ticket.id)
    expect(outputs.review?.review?.verdict).toBe('pass')
    expect(outputs.fixes?.problems).toEqual([])
    expect(outputs.fixes?.fixes?.map((fix) => fix.issueId)).toEqual(['r1-1', 'r1-2'])
    expect(outputs.history).toEqual(expect.arrayContaining(['review-1.json', 'review-2.json']))

    const [diff] = await api.getTicketDiff(ticket.id)
    expect(diff.files.map((file) => file.path)).toEqual(['HINTS.md'])
    expect(diff.files[0].fixes).toEqual([{ issueId: 'r1-1', severity: 'high' }])

    await api.discardTicket(ticket.id)
    await backend.shutdown()
  }, 90_000)
})
