import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ticket } from '@shared/tickets'
import { createBackend, type Backend } from '../api'
import { openDatabase } from '../db'
import { FakeGitHub } from '../testing/fake-github'
import { git, makeRepo } from '../testing/git'
import { HINT_SPEC, HINT_SPEC_MET } from '../testing/spec'

const FAKE = ['node', resolve('src/main/testing/fake-claude.mjs')]

const plan = `# Plan · WM-1 · Hints

## Summary
Hints.

## Affected repos
- app: changes · hints

## Steps
1. [app] Add hint.txt

## Open questions
- None

## Decided while planning
- None

## Done when
- hint.txt exists
`
const notes = `# Build notes · WM-1 · pass 1\n\n## Summary\nAdded the hint.\n\n## Changes\n### app\n- hint.txt: added\n\n## Checks run\n- None\n\n## Decisions\n- None\n\n## Deviations from the plan\n- None\n\n## Blocked\nNone\n`

async function until(backend: Backend, id: number, check: (ticket: Ticket) => boolean, timeoutMs = 30_000): Promise<Ticket> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ticket = backend.tickets.get(id)
    if (check(ticket)) return ticket
    await new Promise((wait) => setTimeout(wait, 50))
  }
  throw new Error(`Timed out. Ticket is ${JSON.stringify(backend.tickets.get(id))}\n${backend.tickets.logEntries(id).map((entry) => entry.message).join('\n')}`)
}

afterEach(() => {
  delete process.env.EREGION_FAKE_SCRIPT
})

describe.skipIf(process.platform === 'win32')('Reset to Plan', () => {
  it('removes the runs, log, outputs and branch since the plan was approved, and waits for approval again', async () => {
    const script = join(await mkdtemp(join(tmpdir(), 'eregion-script-')), 'script.json')
    await writeFile(
      script,
      JSON.stringify([
        { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan, '{outputs}/spec.md': HINT_SPEC }, reply: 'Ready.' },
        { when: 'Stage: Build', write: { '{cwd}/app/hint.txt': 'h\n', '{outputs}/build-notes.md': notes }, reply: 'Built.' },
        { when: 'Stage: Review', write: { '{outputs}/review.json': JSON.stringify({ loop: 1, verdict: 'pass', summary: 'Good.', issues: [], spec: HINT_SPEC_MET }) }, reply: 'Pass.' },
        { when: 'Split step 1', write: { '{outputs}/plan.md': plan.replace('1. [app] Add hint.txt', '1. [app] Add hint.txt\n2. [app] Test it') }, reply: 'Split it ({resume}).' }
      ])
    )
    process.env.EREGION_FAKE_SCRIPT = script
    const db = openDatabase(':memory:')
    const github = new FakeGitHub()
    const backend = createBackend(
      db,
      { appVersion: '0.1.0', databasePath: ':memory:', pickFolder: async () => null, pickSaveFile: async () => null, pickOpenFile: async () => null, openExternal: async () => undefined, emit: () => undefined, notify: () => undefined },
      { agentCommand: () => FAKE, workspaceRoot: await mkdtemp(join(tmpdir(), 'eregion-reset-')), github }
    )
    const { api } = backend
    await api.checkTools()
    const repo = await makeRepo({ 'README.md': 'app' })
    const project = await api.createProject('Word Magic')
    await api.addRepo(project.id, { name: 'app', path: repo.clone, runtime: 'native', defaultBranch: 'main' })
    const ticket = await api.createTicket(project.id, 'Show a hint after two wrong guesses', '')

    await expect(api.resetToPlan(ticket.id)).rejects.toThrow("isn't past Plan")
    await api.startTicket(ticket.id)
    await until(backend, ticket.id, (item) => item.waitingFor === 'approval')
    await api.approvePlan(ticket.id)
    const built = await until(backend, ticket.id, (item) => item.waitingFor === 'manual-review')
    const branch = built.branch as string
    expect(git(repo.origin, 'branch', '--list', branch)).toContain(branch)
    const before = await api.getTicket(ticket.id)
    expect(before.runs.map((run) => run.stage)).toEqual(['plan', 'build', 'review'])

    await api.resetToPlan(ticket.id)
    const reset = backend.tickets.get(ticket.id)
    expect(reset).toMatchObject({ stage: 'plan', status: 'needs_you', waitingFor: 'approval', planApprovedAt: null, slot: null, currentRunId: null, stopReason: null })
    const after = await api.getTicket(ticket.id)
    expect(after.runs.map((run) => run.stage)).toEqual(['plan'])
    // Taken off the ticket, but still there for Costs.
    expect((db.prepare('SELECT COUNT(*) AS n FROM runs WHERE ticket_id = ? AND reset_at IS NOT NULL').get(ticket.id) as { n: number }).n).toBe(2)
    const log = after.log.map((entry) => entry.message)
    expect(log).not.toContain('Entered Build')
    expect(log.some((message) => message.startsWith('Plan approved'))).toBe(false)
    expect(log.at(-1)).toBe('Reset to Plan: removed 1 Build run, 1 Review run and their changes. Approve the plan to build again.')
    expect(git(repo.clone, 'branch', '--list', branch)).toBe('')
    expect(git(repo.origin, 'branch', '--list', branch)).toBe('')
    const outputs = await api.getTicketOutputs(ticket.id)
    expect(outputs.plan).not.toBeNull()
    expect(outputs.buildNotes).toBeNull()
    expect(outputs.review).toBeNull()
    // The plan and spec stay, with their approved copies.
    expect(outputs.history.sort()).toEqual(['plan-approved-1.md', 'spec-approved-1.md'])
    expect(existsSync(join(outputs.dir, 'plan.md'))).toBe(true)
    expect(outputs.spec?.parsed.behaviours.map((behaviour) => behaviour.id)).toEqual(['S1'])

    // The plan's conversation has ended; carrying it on resumes Plan in the same conversation, and the
    // revised plan waits for approval again.
    const planner = (await api.getTicket(ticket.id)).runs.at(-1)
    await api.continueTicketConversation(ticket.id, 'Split step 1 in two', false)
    const revised = await until(backend, ticket.id, (item) => item.waitingFor === 'approval' && item.status === 'needs_you')
    expect(revised.stage).toBe('plan')
    const replanned = backend.agents.ticketRuns(ticket.id)
    expect(replanned.map((item) => item.run.stage)).toEqual(['plan', 'plan'])
    expect(replanned[1].events.filter((event) => event.kind === 'user' || event.kind === 'text').map((event) => (event as { text: string }).text)).toEqual(['Split step 1 in two', `Split it (${planner?.sessionId}).`])
    expect((await api.getTicketOutputs(ticket.id)).plan?.markdown).toContain('2. [app] Test it')
    expect((await api.getTicket(ticket.id)).log.map((entry) => entry.message)).toEqual(expect.arrayContaining([expect.stringMatching(/^You carried on .*'s conversation in Plan$/)]))

    // Approving again builds afresh from the base branch.
    await api.approvePlan(ticket.id)
    await until(backend, ticket.id, (item) => item.waitingFor === 'manual-review')
    expect((await api.getTicket(ticket.id)).runs.map((run) => run.stage)).toEqual(['plan', 'plan', 'build', 'review'])
    expect(git(repo.origin, 'log', '--format=%s', `refs/heads/${branch}`).split('\n')).toHaveLength(2)

    // Once a PR exists, the work is for reviewers to see: no reset.
    backend.prs.save(ticket.id, (await api.getProject(project.id)).repos[0].id, { id: 'pr-1', number: 1, url: 'https://github.com/me/app/pull/1', title: 'WM-1', draft: true, state: 'open', base: 'main', branch, headSha: 'abc', additions: 1, deletions: 0, changedFiles: 1, mergedAt: null }, true)
    await expect(api.resetToPlan(ticket.id)).rejects.toThrow('can no longer be reset')
  })
})
