import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ticket } from '@shared/tickets'
import { createBackend, type Backend } from '../api'
import { openDatabase } from '../db'
import { FakeGitHub } from '../testing/fake-github'
import { git, makeRepo } from '../testing/git'
import { ticketContext } from '../ticketContext'
import { checkChanges } from './ciWatch'
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
  it('opens draft PRs, watches CI on them, re-runs a failed check, fixes it, is marked ready once CI is complete, and finishes on merge', async () => {
    const script = join(await mkdtemp(join(tmpdir(), 'eregion-script-')), 'script.json')
    await writeFile(
      script,
      JSON.stringify([
        { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan, '{outputs}/spec.md': HINT_SPEC }, reply: 'Ready.' },
        { when: 'Stage: Build', write: { '{cwd}/app/hint.txt': 'h\n', '{outputs}/build-notes.md': notes }, reply: 'Built.' },
        { when: 'Stage: Review', write: { '{outputs}/review.json': JSON.stringify({ loop: 1, verdict: 'pass', summary: 'Good.', issues: [], spec: HINT_SPEC_MET }) }, reply: 'Pass.' },
        { when: 'Stage: PR', write: { '{outputs}/pr-app.md': pr }, reply: 'Wrote pr-app.md.' },
        { when: 'Stage: Watch CI, fix attempt 1', write: { '{cwd}/app/hint.txt': 'H\n', '{outputs}/ci-fix.json': ciFix }, reply: 'Capitalised the hint.' },
        { when: 'Why a capital', reply: 'The test expects one (carried on {resume}).' },
        { when: 'What changed', reply: 'The hint file (new chat {resume}).' }
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

    // A check fails on the Build commit and passes once the fix is pushed. Lint is slower, and coverage, which
    // this ticket ignores, fails and then stays pending.
    let lint: 'pending' | 'pass' = 'pending'
    github.checkResult = (item) => [
      { name: 'tests', workflow: 'CI', bucket: item.headSha === built ? 'fail' : 'pass', link: 'https://github.com/me/app/actions/runs/7/job/9' },
      { name: 'lint', workflow: 'CI', bucket: lint, link: 'https://github.com/me/app/actions/runs/7/job/10' },
      { name: 'codecov/project', workflow: '', bucket: lint === 'pending' ? 'fail' : 'pending', link: 'https://app.codecov.io/gh/me/app/pull/1' }
    ]
    await api.ignoreCheck(ticket.id, 'codecov/project', true)

    await api.approveReview(ticket.id)
    // With Watch CI next, the drafts go straight to it: CI runs on them while they're still drafts.
    let current = await until(backend, ticket.id, (item) => item.stage === 'ci' && item.status === 'idle')
    expect(github.calls).toContain(`create ${current.branch} draft`)
    const [opened] = await api.getTicketPrs(ticket.id)
    expect(opened).toMatchObject({ repo: 'app', number: 1, draft: true, state: 'open', autofix: true })
    expect(github.prs[0].body).toContain('## How to test')
    // The build log covers Build up to the PR, with the review's verdict and the build notes after.
    const log = (await api.getTicketOutputs(ticket.id)).buildLog ?? ''
    expect(log).toMatch(/^# Build log: WM-1 Show a hint after two wrong guesses/)
    expect(log.match(/^## .*/gm)).toEqual(['## Build', '## Review', '## PR', '## Appendix: reviews'])
    expect(log).not.toContain('## Plan')
    expect(log).toContain('**Agent:** Built.')
    expect(log).toContain('### Review\n\n> RESULT: PASS\n\nGood.')
    expect(log).toContain('### Build notes')
    expect(backend.tickets.logEntries(ticket.id).map((entry) => entry.message)).toContain('Wrote the build log (build-log.md)')
    await expect(api.markPrsReady(ticket.id)).rejects.toThrow("CI isn't complete yet")

    // A ticket left waiting in PR from before drafts went to Watch CI moves on at startup, still a draft.
    backend.tickets.update(ticket.id, { stage: 'pr', status: 'needs_you', waitingFor: 'ready-for-review' })
    await backend.prStage.moveWaitingDraftsOn()
    expect(backend.tickets.get(ticket.id)).toMatchObject({ stage: 'ci', status: 'idle', waitingFor: null })
    expect(github.prs[0].draft).toBe(true)

    // Tests failed, but lint is still running: nothing is re-run or handed to you until it finishes.
    await backend.ci.check(ticket.id)
    expect(github.calls).not.toContain('rerun tests')
    expect(backend.tickets.get(ticket.id)).toMatchObject({ stage: 'ci', status: 'idle', stopReason: null })

    // Every counted check has finished (the ignored coverage check doesn't count): re-run once in case it's flaky.
    lint = 'pass'
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

    // Every counted check has finished green: you mark the drafts ready, and Watch CI keeps watching until the merge.
    await api.markPrsReady(ticket.id)
    expect(github.prs[0].draft).toBe(false)
    expect(backend.tickets.get(ticket.id)).toMatchObject({ stage: 'ci', status: 'idle', waitingFor: null })
    await expect(api.markPrsReady(ticket.id)).rejects.toThrow('has no draft PRs')

    // Merged on GitHub: teardown, and the ticket is done.
    github.prs[0].state = 'merged'
    github.prs[0].mergedAt = '2026-10-20T08:05:34Z'
    await backend.ci.check(ticket.id)
    current = await until(backend, ticket.id, (item) => item.stage === 'done')
    expect(current).toMatchObject({ status: 'done', slot: null })
    const [merged] = await api.getTicketPrs(ticket.id)
    expect(merged).toMatchObject({ state: 'merged', mergedAt: '2026-10-20T08:05:34Z', checksScope: 'all' })
    expect(merged.checkedAt).toBeTruthy()
    expect(backend.tickets.logEntries(ticket.id).map((entry) => entry.message)).toEqual(expect.arrayContaining(['app #1: tests failed, lint started, codecov/project failed', 'app #1: tests passed']))

    // Done, the fixer's conversation carries on as a read-only talk: the ticket stays as it is.
    const fixer = (await api.getTicket(ticket.id)).runs.at(-1)
    expect(fixer?.stage).toBe('ci')
    await api.continueTicketConversation(ticket.id, 'Why a capital?', false)
    const talked = await until(backend, ticket.id, () => backend.agents.ticketRuns(ticket.id).at(-1)?.events.some((event) => event.kind === 'text') === true)
    expect(talked).toMatchObject({ stage: 'done', status: 'done', currentRunId: null })
    const talk = backend.agents.ticketRuns(ticket.id).at(-1)
    expect(talk?.run).toMatchObject({ stage: 'ci', crewId: fixer?.crewId })
    expect(talk?.events.filter((event) => event.kind === 'user' || event.kind === 'text').map((event) => (event as { text: string }).text)).toEqual(['Why a capital?', `The test expects one (carried on ${fixer?.sessionId}).`])

    // Send to Forge: a chat about the ticket with whoever ran the run you're looking at, reading its outputs and diff.
    const chat = await api.sendTicketToForge(ticket.id, fixer?.id ?? null)
    expect(chat).toMatchObject({ ticketId: ticket.id, crewId: fixer?.crewId, title: 'WM-1: Show a hint after two wrong guesses' })
    const { runId: chatRun } = await api.sendToChat(chat.id, 'What changed?', false)
    const deadline = Date.now() + 10_000
    while (!backend.agents.view(chatRun).events.some((event) => event.kind === 'text') && Date.now() < deadline) await new Promise((wait) => setTimeout(wait, 50))
    expect(backend.agents.view(chatRun).events.find((event) => event.kind === 'text')).toMatchObject({ text: 'The hint file (new chat new).' })
    expect((await api.listChats(project.id)).find((item) => item.id === chat.id)?.title).toBe('WM-1: Show a hint after two wrong guesses')
    // What the chat is told: the environment is gone, so it reads the outputs and the branch's diff.
    const context = await ticketContext(backend, ticket.id, await mkdtemp(join(tmpdir(), 'eregion-context-')))
    expect(context.repoPaths).toEqual({})
    expect(context.text).toContain('ticket WM-1, "Show a hint after two wrong guesses", which is finished')
    expect(context.text).toContain('- app #1, merged, checks passed: ')
    expect(context.text).toMatch(/hint\.txt +\| +1 \+/)
    const diff = context.text.match(/- app: (.+changes-app\.diff)/)?.[1] as string
    expect(await readFile(diff, 'utf8')).toContain('+H')
    await backend.shutdown()
  }, 120_000)

  it('stops with CI needs you when the fixer says the cause is not in the ticket, then carries on as you say', async () => {
    const script = join(await mkdtemp(join(tmpdir(), 'eregion-script-')), 'script.json')
    await writeFile(
      script,
      JSON.stringify([
        { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan, '{outputs}/spec.md': HINT_SPEC }, reply: 'Ready.' },
        { when: 'Stage: Build', write: { '{cwd}/app/hint.txt': 'h\n', '{outputs}/build-notes.md': notes }, reply: 'Built.' },
        { when: 'Stage: Review', write: { '{outputs}/review.json': JSON.stringify({ loop: 1, verdict: 'pass', summary: 'Good.', issues: [], spec: HINT_SPEC_MET }) }, reply: 'Pass.' },
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

    // CI's linter pushes a commit of its own to the branch, so the worktree is behind GitHub.
    const linter = join(repo.root, 'linter')
    git(repo.root, 'clone', '--quiet', '--branch', fixed.branch as string, repo.origin, linter)
    await writeFile(join(linter, 'lint.txt'), 'tidied\n')
    git(linter, 'add', '-A')
    git(linter, 'commit', '-m', 'Lint')
    git(linter, 'push', '--quiet')

    // Something in the PR you don't want: back to Build with a note, from Watch CI.
    await api.sendBack(ticket.id, 'Drop the hint file, we only need the guess counter')
    await until(backend, ticket.id, (item) => item.stage === 'build')
    expect(backend.tickets.logEntries(ticket.id).map((entry) => entry.message)).toEqual(expect.arrayContaining(['Watching CI again', 'You sent it back to Build']))

    // Build starts from GitHub's tip, so its push goes on top of the linter's commit instead of being rejected.
    await until(backend, ticket.id, (item) => item.stage !== 'build')
    const messages = backend.tickets.logEntries(ticket.id).map((entry) => entry.message)
    expect(messages).toContain(`app: pulled 1 commit from origin/${fixed.branch}`)
    expect(messages.filter((message) => message === `Pushed ${fixed.branch} in app`)).toHaveLength(2)
    const pushed = git(repo.origin, 'log', '-3', '--format=%s', `refs/heads/${fixed.branch}`).split('\n')
    expect(pushed[0]).toMatch(/^WM-1: Hints \(build pass \d+\)$/)
    expect(pushed[1]).toBe('Lint')
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
