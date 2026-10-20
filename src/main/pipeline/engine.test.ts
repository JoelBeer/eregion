import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultPipeline, stageFromTemplate, type StageConfig } from '@shared/pipeline'
import type { Ticket } from '@shared/tickets'
import { CrewStore } from '../agents/crew'
import { AgentManager } from '../agents/manager'
import { RunStore } from '../agents/runs'
import { openDatabase } from '../db'
import { ProjectStore } from '../projects/store'
import { ServiceManager } from '../recipe/services'
import { git, makeRepo } from '../testing/git'
import { Workspaces } from '../workspace/workspaces'
import { PipelineEngine } from './engine'
import { PipelineStore, TicketStore } from './stores'

const FAKE = ['node', resolve('src/main/testing/fake-claude.mjs')]

const plan = (answered: boolean) => `# WM-1 · Hints

Hints appear after two wrong tries.

## Affected repos
- app: changes · hint logic

## Steps
1. [app] Add hint.txt

## Open questions
- [${answered ? 'x' : ' '}] Show the first letter?

## Decided while planning
- First letter

## Done when
- hint.txt exists
`

const notes = (pass: number, blocked = 'None') =>
  `# Build notes · WM-1 · pass ${pass}\n\n## Summary\nPass ${pass} work.\n\n## Changes\n### app\n- hint.txt: added\n\n## Checks run\n- cat hint.txt: ok\n\n## Decisions\n- None\n\n## Deviations from the plan\n- None\n\n## Blocked\n${blocked}\n`

const failedReview = JSON.stringify({ loop: 1, verdict: 'fail', summary: 'Missing test.', issues: [{ id: 'r1-1', severity: 'medium', repo: 'app', file: 'hint.txt', line: null, problem: 'No test.', fix: 'Add one.' }] })
const passedReview = JSON.stringify({ loop: 2, verdict: 'pass', summary: 'Good.', issues: [] })

async function setup(rules: unknown[]) {
  const scriptDir = await mkdtemp(join(tmpdir(), 'eregion-script-'))
  const script = join(scriptDir, 'script.json')
  await writeFile(script, JSON.stringify(rules))
  process.env.EREGION_FAKE_SCRIPT = script

  const db = openDatabase(':memory:')
  const projects = new ProjectStore(db)
  const tickets = new TicketStore(db)
  const pipelines = new PipelineStore(db)
  const crew = new CrewStore(db)
  crew.ensureDefaults('claude-code')
  const runs = new RunStore(db)
  const agents = new AgentManager(runs, () => undefined, () => FAKE)
  const root = await mkdtemp(join(tmpdir(), 'eregion-engine-'))
  const workspaces = new Workspaces(projects, new ServiceManager(), () => undefined, undefined, root)
  const repo = await makeRepo({ 'README.md': 'app' })
  const project = projects.create('Word Magic')
  projects.addRepo(project.id, { name: 'app', path: repo.clone, runtime: 'native', defaultBranch: 'main' })
  projects.update(project.id, { liveSlots: 1 })
  const changes: Ticket[] = []
  const notices: string[] = []
  const engine = new PipelineEngine({
    projects,
    tickets,
    pipelines,
    crew,
    agents,
    workspaces,
    settings: { userName: () => 'Joel', houseRules: () => '' },
    integrations: { notify: (title) => notices.push(title) },
    onTicketChanged: (ticket) => changes.push(ticket)
  })
  const ticket = tickets.create({ projectId: project.id, key: 'WM-1', title: 'Hints' })
  return { engine, tickets, runs, agents, ticket, repo, root, changes, notices, workspaces, pipelines }
}

/** Waits until the ticket matches, checking as it changes. */
async function until(tickets: TicketStore, id: number, check: (ticket: Ticket) => boolean, timeoutMs = 20_000): Promise<Ticket> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ticket = tickets.get(id)
    if (check(ticket)) return ticket
    await new Promise((wait) => setTimeout(wait, 50))
  }
  throw new Error(`Timed out. Ticket is ${JSON.stringify(tickets.get(id))}`)
}

afterEach(() => {
  delete process.env.EREGION_FAKE_SCRIPT
})

describe.skipIf(process.platform === 'win32')('PipelineEngine', () => {
  it('takes a ticket from Plan through a failed review, a second Build, and a passing review', async () => {
    const { engine, tickets, runs, ticket, repo, notices } = await setup([
      { when: 'Stage: Plan', once: true, write: { '{outputs}/plan.md': plan(false) }, reply: 'One question before I finish: show the first letter?' },
      { when: 'Yes, the first letter', once: true, write: { '{outputs}/plan.md': plan(true) }, reply: 'The plan is ready for approval.' },
      { when: 'Stage: Build, pass 1', once: true, write: { '{cwd}/app/hint.txt': 'h', '{outputs}/build-notes.md': notes(1) }, reply: 'Added the hint.' },
      { when: 'Stage: Review, loop 1', once: true, write: { '{outputs}/review.json': failedReview }, reply: 'Fail: missing test.' },
      { when: 'Stage: Build, pass 2', once: true, write: { '{cwd}/app/hint.test': 't', '{outputs}/build-notes.md': notes(2), '{outputs}/fixes.json': JSON.stringify({ loop: 2, fixes: [{ issueId: 'r1-1', fixed: true, files: ['app/hint.test'], note: '' }] }) }, reply: 'Added the test.' },
      { when: 'Stage: Review, loop 2', once: true, write: { '{outputs}/review.json': passedReview }, reply: 'Pass.' }
    ])

    await engine.start(ticket.id)
    let current = await until(tickets, ticket.id, (item) => item.waitingFor === 'answers')
    expect(current).toMatchObject({ stage: 'plan', status: 'needs_you', pipelineVersion: 1, branch: 'wm-1-hints' })
    await expect(engine.approvePlan(ticket.id)).rejects.toThrow('1 open question still needs an answer')

    // Answer the question in the plan conversation.
    const planRun = current.currentRunId as number
    expect(() => (engine as unknown as { deps: { agents: AgentManager } }).deps.agents.send(planRun, 'Yes, the first letter', 'now')).not.toThrow()
    current = await until(tickets, ticket.id, (item) => item.waitingFor === 'approval')
    await engine.approvePlan(ticket.id)

    current = await until(tickets, ticket.id, (item) => item.stage === 'review' && item.waitingFor === 'manual-review', 30_000)
    expect(current).toMatchObject({ status: 'needs_you', loop: 2, loops: { review: { failures: 1, extra: 0 } }, returnedFrom: null, affectedRepos: ['app'], slot: 1 })
    expect(current.planApprovedAt).not.toBeNull()

    // Eregion committed each Build pass on the ticket branch and pushed it to origin.
    expect(git(repo.clone, 'log', '--format=%s', 'wm-1-hints', '-3').split('\n')).toEqual(['WM-1: Hints (build pass 2)', 'WM-1: Hints (build pass 1)', 'Initial commit'])
    expect(git(repo.origin, 'branch', '--list', 'wm-1-hints')).toContain('wm-1-hints')
    expect(runs.forTicket(ticket.id).map((run) => [run.stage, run.loop, run.result])).toEqual([
      ['plan', 1, 'done'],
      ['build', 1, 'done'],
      ['review', 1, 'done'],
      ['build', 2, 'done'],
      ['review', 2, 'done']
    ])
    expect(notices.length).toBeGreaterThan(0)
  }, 60_000)

  it('asks once for a broken output file, then stops the ticket as stuck', async () => {
    const { engine, tickets, ticket, root } = await setup([
      { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan(true) }, reply: 'Ready.' },
      { when: 'Stage: Build', write: { '{outputs}/build-notes.md': '## Summary\nonly this' }, reply: 'Done.' },
      { when: "build-notes.md isn't valid", reply: 'I tried.' }
    ])
    await engine.start(ticket.id)
    await until(tickets, ticket.id, (item) => item.waitingFor === 'approval')
    await engine.approvePlan(ticket.id)
    const stuck = await until(tickets, ticket.id, (item) => item.stopReason === 'stuck')
    expect(stuck.stopDetail).toContain("build-notes.md isn't valid after one fix request")
    expect(stuck.stage).toBe('build')
    expect(root).toBeTruthy()
  }, 60_000)

  it('stops as Blocked without committing, and goes back to Plan with the reason', async () => {
    const { engine, tickets, ticket, repo } = await setup([
      { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan(true) }, reply: 'Ready.' },
      { when: 'Stage: Build', once: true, write: { '{cwd}/app/half.txt': 'x', '{outputs}/build-notes.md': notes(1, 'web needs a change the plan marks as none.') }, reply: 'Blocked.' }
    ])
    await engine.start(ticket.id)
    await until(tickets, ticket.id, (item) => item.waitingFor === 'approval')
    await engine.approvePlan(ticket.id)
    const blocked = await until(tickets, ticket.id, (item) => item.stopReason === 'blocked')
    expect(blocked.stopDetail).toBe('web needs a change the plan marks as none.')
    expect(git(repo.clone, 'log', '--format=%s', 'wm-1-hints', '-1')).toBe('Initial commit')

    await engine.backToPlan(ticket.id, '')
    const replanning = await until(tickets, ticket.id, (item) => item.stage === 'plan' && item.status !== 'running')
    expect(replanning.loop).toBe(2)
  }, 60_000)

  it('stops at the loop limit, and one more loop goes back to Build', async () => {
    const { engine, tickets, ticket } = await setup([
      { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan(true) }, reply: 'Ready.' },
      { when: 'Stage: Build', write: { '{cwd}/app/x.txt': 'x', '{outputs}/build-notes.md': notes(1) }, reply: 'Built.' },
      { when: 'fixes.json', write: { '{outputs}/fixes.json': JSON.stringify({ fixes: [{ issueId: 'r1-1', fixed: false, files: [], note: 'Not needed.' }] }) }, reply: 'Wrote fixes.' },
      { when: 'Stage: Review', write: { '{outputs}/review.json': failedReview }, reply: 'Fail.' }
    ])
    await engine.start(ticket.id)
    await until(tickets, ticket.id, (item) => item.waitingFor === 'approval')
    await engine.approvePlan(ticket.id)
    const limited = await until(tickets, ticket.id, (item) => item.stopReason === 'loop_limit', 40_000)
    expect(limited).toMatchObject({ stage: 'review', loops: { review: { failures: 2, extra: 0 } }, returnedFrom: 'review', loop: 2 })
    expect(limited.stopDetail).toContain('loop 2 of 2')

    await engine.allowOneMoreLoop(ticket.id)
    const again = await until(tickets, ticket.id, (item) => item.stage === 'build' || item.loops.review?.extra === 1)
    expect(again.loops.review?.extra).toBe(1)
    await engine.discard(ticket.id)
    expect(tickets.get(ticket.id)).toMatchObject({ stage: 'backlog', status: 'idle', slot: null })
  }, 60_000)

  it('waits for a free slot and starts when one frees up', async () => {
    const { engine, tickets, ticket, workspaces } = await setup([
      { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan(true) }, reply: 'Ready.' },
      { when: 'Stage: Build', write: { '{outputs}/build-notes.md': notes(1) }, reply: 'Built.' },
      { when: 'Stage: Review', write: { '{outputs}/review.json': passedReview.replace('"loop":2', '"loop":1') }, reply: 'Pass.' }
    ])
    const other = tickets.create({ projectId: ticket.projectId, key: 'WM-2', title: 'Other' })
    tickets.update(other.id, { slot: 1, stage: 'review' })
    await engine.start(ticket.id)
    await until(tickets, ticket.id, (item) => item.waitingFor === 'approval')
    await engine.approvePlan(ticket.id)
    const waiting = await until(tickets, ticket.id, (item) => item.waitingFor === 'slot')
    expect(waiting).toMatchObject({ stage: 'build', status: 'idle', slot: null })

    await engine.discard(other.id)
    const resumed = await until(tickets, ticket.id, (item) => item.waitingFor === 'manual-review', 30_000)
    expect(resumed.slot).toBe(1)
    expect(workspaces.get(`ticket:${ticket.id}`)?.phase).toBe('ready')
  }, 60_000)

  it('stops with the usage limit, without asking for a fix, when the builder runs out before writing its notes', async () => {
    const { engine, tickets, ticket, runs } = await setup([
      { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan(true) }, reply: 'Ready.' },
      { when: 'Stage: Build', limit: true }
    ])
    await engine.start(ticket.id)
    await until(tickets, ticket.id, (item) => item.waitingFor === 'approval')
    await engine.approvePlan(ticket.id)
    const stopped = await until(tickets, ticket.id, (item) => item.stopReason !== null)
    expect(stopped).toMatchObject({ stage: 'build', stopReason: 'stuck' })
    expect(stopped.stopDetail).toBe(`Claude's usage limit was reached ("You've hit your session limit · resets 3:10am (Europe/London)"). Start again once it resets.`)
    const build = runs.forTicket(ticket.id).at(-1)
    expect(build?.endNote).toContain('session limit')
    expect(runs.events(build?.id as number).some((event) => event.kind === 'user')).toBe(false)
  }, 60_000)

  it('carries on when the usage limit hits after the stage wrote everything it needed', async () => {
    const { engine, tickets, ticket } = await setup([
      { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan(true) }, reply: 'Ready.' },
      { when: 'Stage: Build', write: { '{cwd}/app/hint.txt': 'h', '{outputs}/build-notes.md': notes(1) }, limit: true },
      { when: 'Stage: Review', write: { '{outputs}/review.json': passedReview.replace('"loop":2', '"loop":1') }, reply: 'Pass.' }
    ])
    await engine.start(ticket.id)
    await until(tickets, ticket.id, (item) => item.waitingFor === 'approval')
    await engine.approvePlan(ticket.id)
    expect((await until(tickets, ticket.id, (item) => item.waitingFor === 'manual-review' || item.stopReason !== null)).stopReason).toBeNull()
  }, 60_000)

  it('runs a stage you added from its fields: a read-only verdict that sends the work back to Build, then moves on by itself', async () => {
    const failedCheck = JSON.stringify({ loop: 1, verdict: 'fail', summary: 'Needs a hint test.', issues: [{ id: 'c1-1', severity: 'high', repo: 'app', file: 'hint.txt', line: null, problem: 'Untested.', fix: 'Test it.' }] })
    const { engine, tickets, runs, ticket, repo, pipelines } = await setup([
      { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan(true) }, reply: 'Ready.' },
      { when: 'Stage: Build, pass 1', once: true, write: { '{cwd}/app/hint.txt': 'h', '{outputs}/build-notes.md': notes(1) }, reply: 'Built.' },
      { when: 'Stage: Check, loop 1', once: true, write: { '{cwd}/app/stray.txt': 'x', '{outputs}/check.json': failedCheck }, reply: 'Fail.' },
      { when: 'Stage: Build, pass 2', once: true, write: { '{cwd}/app/hint.test': 't', '{outputs}/build-notes.md': notes(2), '{outputs}/fixes.json': JSON.stringify({ loop: 2, fixes: [{ issueId: 'c1-1', fixed: true, files: ['app/hint.test'], note: '' }] }) }, reply: 'Fixed.' },
      { when: 'Stage: Check, loop 2', once: true, write: { '{outputs}/check.json': JSON.stringify({ loop: 2, verdict: 'pass', summary: 'Good.', issues: [] }) }, reply: 'Pass.' }
    ])
    const check: StageConfig = {
      ...stageFromTemplate('custom', defaultPipeline(), 2),
      id: 'check',
      name: 'Check',
      goal: 'Stage: Check, loop {{loop}}. Write your verdict to {{outputs.dir}}/check.json.',
      outputs: ['check.json'],
      doneWhen: 'verdict',
      access: 'read-only',
      onFailure: { returnTo: 'build', maxLoops: 2 }
    }
    pipelines.save(ticket.projectId, [...defaultPipeline().slice(0, 2), check])

    await engine.start(ticket.id)
    await until(tickets, ticket.id, (item) => item.waitingFor === 'approval')
    await engine.approvePlan(ticket.id)
    const done = await until(tickets, ticket.id, (item) => item.status === 'done' || item.stopReason !== null, 40_000)
    expect(done).toMatchObject({ status: 'done', stopReason: null, loops: { check: { failures: 1, extra: 0 } }, returnedFrom: null })
    expect(runs.forTicket(ticket.id).map((run) => [run.stage, run.loop])).toEqual([
      ['plan', 1],
      ['build', 1],
      ['check', 1],
      ['build', 2],
      ['check', 2]
    ])
    // The check was read-only: what it wrote in the worktree was thrown away, not committed.
    expect(git(repo.clone, 'ls-tree', '-r', '--name-only', 'wm-1-hints').split('\n')).toEqual(['README.md', 'hint.test', 'hint.txt'])
    expect(tickets.logEntries(ticket.id).map((entry) => entry.message)).toContain('Rivet changed files in app during Check; Eregion discarded them: stray.txt')
  }, 60_000)

  it("loops back when a stage's done command fails, and moves on once it passes", async () => {
    const { engine, tickets, ticket, repo, pipelines } = await setup([
      { when: 'Stage: Plan', write: { '{outputs}/plan.md': plan(true) }, reply: 'Ready.' },
      { when: 'Stage: Build, pass 1', once: true, write: { '{cwd}/app/hint.txt': 'h', '{outputs}/build-notes.md': notes(1) }, reply: 'Built.' },
      { when: 'Stage: Build, pass 2', once: true, write: { '{cwd}/app/ok.txt': 'ok', '{outputs}/build-notes.md': notes(2) }, reply: 'Fixed.' },
      { when: 'Stage: Tests', reply: 'Ran them.' }
    ])
    const tests: StageConfig = {
      ...stageFromTemplate('custom', defaultPipeline(), 2),
      id: 'tests',
      name: 'Tests',
      goal: 'Stage: Tests, pass {{loop}}. Run the tests.',
      doneWhen: 'command',
      doneCommand: 'test -f app/ok.txt',
      onFailure: { returnTo: 'build', maxLoops: 2 }
    }
    pipelines.save(ticket.projectId, [...defaultPipeline().slice(0, 2), tests])

    await engine.start(ticket.id)
    await until(tickets, ticket.id, (item) => item.waitingFor === 'approval')
    await engine.approvePlan(ticket.id)
    const done = await until(tickets, ticket.id, (item) => item.status === 'done' || item.stopReason !== null, 40_000)
    expect(done).toMatchObject({ status: 'done', loop: 2, loops: { tests: { failures: 1, extra: 0 } }, returnedFrom: null })
    expect(git(repo.clone, 'log', '--format=%s', 'wm-1-hints', '-2').split('\n')).toEqual(['WM-1: Hints (build pass 2)', 'WM-1: Hints (build pass 1)'])
  }, 60_000)

  it('marks running tickets as stuck after a restart', async () => {
    const { engine, tickets, ticket } = await setup([])
    tickets.update(ticket.id, { status: 'running', stage: 'build' })
    engine.recover()
    expect(tickets.get(ticket.id)).toMatchObject({ status: 'needs_you', stopReason: 'stuck' })
    expect(await readFile(resolve('src/main/testing/fake-claude.mjs'), 'utf8')).toContain('EREGION_FAKE_SCRIPT')
  })
})
