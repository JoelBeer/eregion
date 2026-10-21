import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ticket } from '@shared/tickets'
import { createBackend, type Backend } from '../api'
import { openDatabase } from '../db'
import { FakeGitHub } from '../testing/fake-github'
import { git, makeRepo } from '../testing/git'
import { checkChanges } from './ciWatch'

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
const pr = `# WM-1: Show a hint after two wrong guesses

## Summary
Shows the first letter after two misses.

## Changes
- hint.txt: the hint

## How to test
- Guess wrong twice

## Linked
- Linear: none
`
const ciFix = JSON.stringify({ pr: 'app #1', check: 'tests', attempt: 1, result: 'fixed', cause: 'The hint test expected a capital letter.', files: ['app/hint.txt'], note: 'Capitalised the hint.' })

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

describe.skipIf(process.platform === 'win32')('PR and Watch CI', () => {
  it('opens draft PRs, waits to be marked ready, re-runs a failed check, fixes it, and finishes on merge', async () => {
    const script = join(await mkdtemp(join(tmpdir(), 'eregion-script-')), 'script.json')
    await writeFile(
      script,
      JSON.stringify([
        { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan }, reply: 'Ready.' },
        { when: 'Stage: Build', write: { '{cwd}/app/hint.txt': 'h\n', '{outputs}/build-notes.md': notes }, reply: 'Built.' },
        { when: 'Stage: Review', write: { '{outputs}/review.json': JSON.stringify({ loop: 1, verdict: 'pass', summary: 'Good.', issues: [] }) }, reply: 'Pass.' },
        { when: 'Stage: PR', write: { '{outputs}/pr-app.md': pr }, reply: 'Wrote pr-app.md.' },
        { when: 'Stage: Watch CI, fix attempt 1', write: { '{cwd}/app/hint.txt': 'H\n', '{outputs}/ci-fix.json': ciFix }, reply: 'Capitalised the hint.' }
      ])
    )
    process.env.EREGION_FAKE_SCRIPT = script
    const github = new FakeGitHub()
    const notices: string[] = []
    const backend = createBackend(
      openDatabase(':memory:'),
      { appVersion: '0.1.0', databasePath: ':memory:', pickFolder: async () => null, pickSaveFile: async () => null, pickOpenFile: async () => null, openExternal: async () => undefined, emit: () => undefined, notify: (title) => notices.push(title) },
      { agentCommand: () => FAKE, workspaceRoot: await mkdtemp(join(tmpdir(), 'eregion-ship-')), github }
    )
    const { api } = backend
    await api.checkTools()
    const repo = await makeRepo({ 'README.md': 'app' })
    const project = await api.createProject('Word Magic')
    await api.addRepo(project.id, { name: 'app', path: repo.clone, runtime: 'native', defaultBranch: 'main' })
    const ticket = await api.createTicket(project.id, 'Show a hint after two wrong guesses', '')

    await api.startTicket(ticket.id)
    await until(backend, ticket.id, (item) => item.waitingFor === 'approval')
    await api.approvePlan(ticket.id)
    await until(backend, ticket.id, (item) => item.waitingFor === 'manual-review')
    const built = git(repo.origin, 'rev-parse', `refs/heads/${backend.tickets.get(ticket.id).branch}`)

    // A check fails on the Build commit and passes once the fix is pushed.
    github.checkResult = (item) => [{ name: 'tests', workflow: 'CI', bucket: item.headSha === built ? 'fail' : 'pass', link: 'https://github.com/me/app/actions/runs/7/job/9' }]

    await api.approveReview(ticket.id)
    let current = await until(backend, ticket.id, (item) => item.waitingFor === 'ready-for-review')
    expect(github.calls).toContain(`create ${current.branch} draft`)
    const [opened] = await api.getTicketPrs(ticket.id)
    expect(opened).toMatchObject({ repo: 'app', number: 1, draft: true, state: 'open', autofix: true })
    expect(github.prs[0].body).toContain('## How to test')

    await api.markPrsReady(ticket.id)
    current = await until(backend, ticket.id, (item) => item.stage === 'ci' && item.status === 'idle')
    expect(github.prs[0].draft).toBe(false)

    // First failure: re-run once in case it's flaky.
    await backend.ci.check(ticket.id)
    expect(github.calls).toContain('rerun tests')
    // Still failing on the same commit: the fixer runs, and Eregion commits and pushes its fix.
    await backend.ci.check(ticket.id)
    current = await until(backend, ticket.id, (item) => item.status === 'idle' && item.currentRunId === null && backend.prs.attempts(opened.id).some((attempt) => attempt.result === 'fixed'))
    const fixed = git(repo.origin, 'rev-parse', `refs/heads/${current.branch}`)
    expect(fixed).not.toBe(built)
    expect(git(repo.origin, 'log', '-1', '--format=%s', fixed)).toBe('WM-1: fix tests (CI attempt 1)')

    await backend.ci.check(ticket.id)
    expect((await api.getTicketPrs(ticket.id))[0].checks[0].bucket).toBe('pass')
    expect(backend.tickets.get(ticket.id).stage).toBe('ci')

    // Merged on GitHub: teardown, and the ticket is done.
    github.prs[0].state = 'merged'
    github.prs[0].mergedAt = '2026-10-20T08:05:34Z'
    await backend.ci.check(ticket.id)
    current = await until(backend, ticket.id, (item) => item.stage === 'done')
    expect(current).toMatchObject({ status: 'done', slot: null })
    const [merged] = await api.getTicketPrs(ticket.id)
    expect(merged).toMatchObject({ state: 'merged', mergedAt: '2026-10-20T08:05:34Z', checksScope: 'all' })
    expect(merged.checkedAt).toBeTruthy()
    expect(backend.tickets.logEntries(ticket.id).map((entry) => entry.message)).toEqual(expect.arrayContaining(['app #1: tests failed', 'app #1: tests passed']))
    await backend.shutdown()
  }, 120_000)

  it('stops with CI needs you when the fixer says the cause is not in the ticket, then carries on as you say', async () => {
    const script = join(await mkdtemp(join(tmpdir(), 'eregion-script-')), 'script.json')
    await writeFile(
      script,
      JSON.stringify([
        { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan }, reply: 'Ready.' },
        { when: 'Stage: Build', write: { '{cwd}/app/hint.txt': 'h\n', '{outputs}/build-notes.md': notes }, reply: 'Built.' },
        { when: 'Stage: Review', write: { '{outputs}/review.json': JSON.stringify({ loop: 1, verdict: 'pass', summary: 'Good.', issues: [] }) }, reply: 'Pass.' },
        { when: 'Stage: PR', write: { '{outputs}/pr-app.md': pr }, reply: 'Done.' },
        {
          when: 'skip the database tests',
          write: { '{cwd}/app/hint.txt': 'H\n', '{outputs}/ci-fix.json': JSON.stringify({ pr: 'app #1', check: 'tests', attempt: 2, result: 'fixed', cause: 'The database tests need a secret CI lacks.', files: ['app/hint.txt'], note: 'Skipped them in CI as asked.' }) },
          reply: 'Skipped them.'
        },
        {
          when: 'Stage: Watch CI',
          write: { '{outputs}/ci-fix.json': JSON.stringify({ pr: 'app #1', check: 'tests', attempt: 1, result: 'needs-you', cause: 'The CI database secret is missing.', files: [], note: '' }) },
          reply: 'Not mine to fix.'
        }
      ])
    )
    process.env.EREGION_FAKE_SCRIPT = script
    const github = new FakeGitHub()
    github.checkResult = () => [{ name: 'tests', workflow: 'CI', bucket: 'fail', link: 'https://github.com/me/app/actions/runs/7/job/9' }]
    const backend = createBackend(
      openDatabase(':memory:'),
      { appVersion: '0.1.0', databasePath: ':memory:', pickFolder: async () => null, pickSaveFile: async () => null, pickOpenFile: async () => null, openExternal: async () => undefined, emit: () => undefined },
      { agentCommand: () => FAKE, workspaceRoot: await mkdtemp(join(tmpdir(), 'eregion-ship-')), github }
    )
    const { api } = backend
    await api.checkTools()
    const repo = await makeRepo({ 'README.md': 'app' })
    const project = await api.createProject('Word Magic')
    await api.addRepo(project.id, { name: 'app', path: repo.clone, runtime: 'native', defaultBranch: 'main' })
    await api.updateProject(project.id, { github: { draft: false } })
    const ticket = await api.createTicket(project.id, 'Hints', '')
    await api.startTicket(ticket.id)
    await until(backend, ticket.id, (item) => item.waitingFor === 'approval')
    await api.approvePlan(ticket.id)
    await until(backend, ticket.id, (item) => item.waitingFor === 'manual-review')
    await api.approveReview(ticket.id)
    // No drafts: the PR stage hands straight over to Watch CI.
    await until(backend, ticket.id, (item) => item.stage === 'ci' && item.status === 'idle')
    await backend.ci.check(ticket.id)
    await backend.ci.check(ticket.id)
    const stopped = await until(backend, ticket.id, (item) => item.stopReason === 'ci_needs_you')
    expect(stopped.stopDetail).toBe('tests on app #1: The CI database secret is missing.')
    const [watched] = await api.getTicketPrs(ticket.id)

    // Check now carries on watching, without trying the same commit again.
    await api.checkCiNow(ticket.id)
    expect(backend.tickets.get(ticket.id)).toMatchObject({ stage: 'ci', status: 'idle', stopReason: null })
    expect(backend.prs.attempts(watched.id)).toHaveLength(1)

    // An ignored check leaves nothing to fix; counted again, you can ask for a fix with a note.
    await api.ignoreCheck(ticket.id, 'tests', true)
    expect(backend.tickets.get(ticket.id).ignoredChecks).toEqual(['tests'])
    await expect(api.fixCiNow(ticket.id, 'skip the database tests')).rejects.toThrow('No check is failing right now')
    await api.ignoreCheck(ticket.id, 'tests', false)
    await api.fixCiNow(ticket.id, 'skip the database tests')
    const fixed = await until(backend, ticket.id, (item) => item.currentRunId === null && backend.prs.attempts(watched.id).some((attempt) => attempt.result === 'fixed'))
    expect(git(repo.origin, 'log', '-1', '--format=%s', `refs/heads/${fixed.branch}`)).toBe('WM-1: fix tests (CI attempt 2)')

    // Something in the PR you don't want: back to Build with a note, from Watch CI.
    await api.sendBack(ticket.id, 'Drop the hint file, we only need the guess counter')
    await until(backend, ticket.id, (item) => item.stage === 'build')
    expect(backend.tickets.logEntries(ticket.id).map((entry) => entry.message)).toEqual(expect.arrayContaining(['Watching CI again', 'You sent it back to Build']))
    await backend.shutdown()
  }, 120_000)
})

describe('checkChanges', () => {
  const check = (name: string, bucket: 'pass' | 'fail' | 'pending') => ({ name, workflow: 'CI', bucket, link: '' })
  it('says which checks changed state, and nothing when none did', () => {
    expect(checkChanges([], [check('lint', 'pending'), check('tests', 'pending')])).toBe('lint started, tests started')
    expect(checkChanges([check('lint', 'pending'), check('tests', 'pending')], [check('lint', 'pass'), check('tests', 'fail')])).toBe('lint passed, tests failed')
    expect(checkChanges([check('lint', 'pass')], [check('lint', 'pass')])).toBeNull()
  })
})
