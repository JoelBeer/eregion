import { usageLimitDetail, usageLimitMessage } from '@shared/agent'
import type { Environment } from '@shared/environment'
import { branchName, type Project, type Repo } from '@shared/model'
import { parseBuildNotes, parseFixes, parsePlan, parseReview, planApprovalBlockers, type ParsedPlan } from '@shared/outputs'
import { nextStage, stageById, type StageConfig, type StageKind } from '@shared/pipeline'
import { composePrompt } from '@shared/prompts'
import type { CrewMember } from '@shared/runs'
import { nextFreeSlot } from '@shared/slots'
import { render } from '@shared/template'
import type { StopReason, Ticket, WaitingFor } from '@shared/tickets'
import type { CrewStore } from '../agents/crew'
import type { AgentManager, RunNotice } from '../agents/manager'
import type { PermissionProfile, SessionOutcome } from '../agents/session'
import { runnerForRuntimeId } from '../projects/detect'
import type { ProjectStore } from '../projects/store'
import type { Runner } from '../runner'
import { changedFiles, commitAll, discardChanges, hasOrigin, pushBranch } from '../workspace/git'
import type { Workspaces } from '../workspace/workspaces'
import type { PipelineStore, TicketPatch, TicketStore } from './stores'

export interface EngineSettings {
  userName(): string
  /** Eregion's rules plus the project's, added to every stage prompt. */
  houseRules(project: Project): string
}

/** Hooks into Linear, GitHub and notifications. Every hook is optional and failures are only logged. */
export interface Integrations {
  stageEntered?(ticket: Ticket, stage: StageConfig, project: Project): Promise<void>
  planApproved?(ticket: Ticket, planMarkdown: string, project: Project): Promise<void>
  prsOpened?(ticket: Ticket, prs: { repo: string; number: number; url: string; title: string }[], project: Project): Promise<void>
  ticketDone?(ticket: Ticket, project: Project): Promise<void>
  notify?(title: string, body: string): void
}

export type StageHandler = (ticket: Ticket, stage: StageConfig, note?: string) => Promise<void>

export interface EngineDeps {
  projects: ProjectStore
  tickets: TicketStore
  pipelines: PipelineStore
  crew: CrewStore
  agents: AgentManager
  workspaces: Workspaces
  settings: EngineSettings
  integrations?: Integrations
  onTicketChanged(ticket: Ticket): void
  runnerFor?: (runtime: string) => Runner
}

/** The message Eregion sends when a stage's output file doesn't pass its checks. */
export function formatFixMessage(file: string, problems: string[]): string {
  return `${file} isn't valid: ${problems.join('; ')}. Fix the file and don't change anything else.`
}

/**
 * Moves tickets through their pipeline: starts each stage's run, checks what it wrote, commits and
 * pushes Build's work, loops Review back to Build, and stops a ticket with a reason when it needs you.
 * Everything that matters is saved on the ticket, so the board survives restarts.
 */
export class PipelineEngine {
  private readonly handlers = new Map<StageKind, StageHandler>()
  private readonly fixRequested = new Set<number>()
  private readonly locks = new Map<number, Promise<unknown>>()
  private readonly runnerFor: (runtime: string) => Runner

  constructor(readonly deps: EngineDeps) {
    this.runnerFor = deps.runnerFor ?? runnerForRuntimeId
    this.handlers.set('plan', (ticket, stage, note) => this.runPlan(ticket, stage, note))
    this.handlers.set('build', (ticket, stage, note) => this.runBuild(ticket, stage, note))
    this.handlers.set('review', (ticket, stage) => this.runReview(ticket, stage))
    this.handlers.set('custom', (ticket, stage, note) => this.runCustom(ticket, stage, note))
  }

  /** Lets later modules add stages such as PR and Watch CI. */
  registerStage(kind: StageKind, handler: StageHandler): void {
    this.handlers.set(kind, handler)
  }

  // ---------- Helpers ----------

  serial<T>(ticketId: number, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(ticketId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.locks.set(
      ticketId,
      next.catch(() => undefined)
    )
    return next
  }

  project(ticket: Ticket): Project {
    return this.deps.projects.get(ticket.projectId)
  }

  stages(ticket: Ticket): StageConfig[] {
    const { pipelines } = this.deps
    return ticket.pipelineVersion ? pipelines.get(ticket.projectId, ticket.pipelineVersion).stages : pipelines.latest(ticket.projectId).stages
  }

  stage(ticket: Ticket): StageConfig | undefined {
    return stageById(this.stages(ticket), ticket.stage)
  }

  crewFor(stage: StageConfig): CrewMember {
    const { crew } = this.deps
    const member = stage.crewId ? crew.get(stage.crewId) : stage.crewRole ? crew.byRole(stage.crewRole) : undefined
    const fallback = member ?? crew.list()[0]
    if (!fallback) throw new Error(`Nobody can run ${stage.name}: add a crew member first`)
    return fallback
  }

  /** The runner agents use. A project's repos must share one runtime for agents to see them together. */
  runner(project: Project): Runner {
    const runtimes = new Set(project.repos.map((repo) => repo.runtime))
    if (runtimes.size === 0) throw new Error('This project has no repos')
    if (runtimes.size > 1) throw new Error("This project's repos run in different runtimes, so one agent can't work on them together")
    return this.runnerFor(project.repos[0].runtime)
  }

  async outputsDir(ticket: Ticket): Promise<string> {
    return this.deps.workspaces.outputsFolder(this.project(ticket), ticket.key)
  }

  async readOutput(ticket: Ticket, name: string): Promise<string | null> {
    const project = this.project(ticket)
    const runner = this.runner(project)
    return runner.readFile(runner.join(await this.outputsDir(ticket), name))
  }

  async keepHistory(ticket: Ticket, name: string, copyAs: string): Promise<void> {
    const project = this.project(ticket)
    const runner = this.runner(project)
    const dir = await this.outputsDir(ticket)
    const content = await runner.readFile(runner.join(dir, name))
    if (content !== null) await runner.writeFile(runner.join(dir, 'history', copyAs), content)
  }

  async removeOutput(ticket: Ticket, name: string): Promise<void> {
    const project = this.project(ticket)
    const runner = this.runner(project)
    await runner.exec(['rm', '-f', runner.join(await this.outputsDir(ticket), name)])
  }

  plan(ticket: Ticket, markdown: string): ParsedPlan {
    return parsePlan(markdown, this.project(ticket).repos.map((repo) => repo.name))
  }

  update(ticketId: number, patch: TicketPatch, log?: string): Ticket {
    const ticket = this.deps.tickets.update(ticketId, patch)
    if (log) this.deps.tickets.log(ticketId, 'pipeline', log)
    this.deps.onTicketChanged(ticket)
    return ticket
  }

  stop(ticket: Ticket, reason: StopReason, detail: string): Ticket {
    const stopped = this.update(ticket.id, { status: 'needs_you', stopReason: reason, stopDetail: detail, waitingFor: null, currentRunId: null }, `Stopped (${reason}): ${detail}`)
    this.deps.integrations?.notify?.(`${ticket.key} needs you`, detail)
    return stopped
  }

  needsYou(ticket: Ticket, waitingFor: WaitingFor, message: string): Ticket {
    const updated = this.update(ticket.id, { status: 'needs_you', waitingFor, stopReason: null, stopDetail: null }, message)
    if (ticket.status !== 'needs_you' || ticket.waitingFor !== waitingFor) this.deps.integrations?.notify?.(`${ticket.key} needs you`, message)
    return updated
  }

  repoLines(project: Project, paths: Record<string, string>, access: (repo: Repo) => string): string {
    return project.repos.map((repo) => `- ${repo.name}: ${paths[repo.name]} (${access(repo)})`).join('\n')
  }

  envSummary(environment: Environment | undefined): string {
    if (!environment) return 'Not running.'
    const services = environment.services.map((service) => `- ${service.name} (${service.repoName}): ${service.state}${service.openUrl ? ` at ${service.openUrl}` : ''}`)
    const values = Object.entries(environment.values).map(([name, value]) => `- ${name} = ${value}`)
    return [...services, ...values].join('\n') || 'No services.'
  }

  async promptFor(ticket: Ticket, stage: StageConfig, crew: CrewMember, values: Record<string, string>): Promise<string> {
    const project = this.project(ticket)
    const comments = (ticket.linear.comments ?? []).map((comment) => `${comment.author} (${comment.createdAt}): ${comment.body}`).join('\n\n')
    const labels = [ticket.linear.priority ? `Priority: ${ticket.linear.priority}` : null, ticket.linear.estimate ? `Estimate: ${ticket.linear.estimate}` : null, ...(ticket.linear.labels ?? [])]
      .filter(Boolean)
      .join(', ')
    const all: Record<string, string> = {
      'crew.name': crew.name,
      'user.name': this.deps.settings.userName(),
      'ticket.key': ticket.key,
      'ticket.title': ticket.title,
      'ticket.url': ticket.url ?? '',
      'ticket.description': ticket.description || '(No description in Linear.)',
      'ticket.comments': comments,
      'ticket.labels': labels,
      'project.name': project.name,
      'outputs.dir': await this.outputsDir(ticket),
      loop: String(ticket.loop),
      branch: ticket.branch ?? '',
      ...values
    }
    return render(composePrompt(stage.goal, this.deps.settings.houseRules(project)), (name) => all[name] ?? '').text
  }

  /**
   * Starts a stage run and wires up what happens when a turn ends and when the run ends. Runs are
   * always conversational underneath so Eregion can ask for a fix in the same session.
   */
  async startRun(
    ticket: Ticket,
    stage: StageConfig,
    options: { cwd: string; prompt: string; profile: PermissionProfile; crew: CrewMember; note?: string },
    onTurnEnd: (ticket: Ticket, runId: number) => Promise<void>
  ): Promise<number> {
    const project = this.project(ticket)
    const outputs = await this.outputsDir(ticket)
    const runner = this.runner(project)
    await runner.exec(['mkdir', '-p', outputs])
    const { runId, done } = this.deps.agents.start({
      ticketId: ticket.id,
      stage: stage.id,
      loop: ticket.loop,
      crew: options.crew,
      runner,
      cwd: options.cwd,
      prompt: options.prompt,
      profile: options.profile,
      addDirs: [outputs],
      conversational: true
    })
    this.update(ticket.id, { currentRunId: runId, status: 'running', waitingFor: null, stopReason: null, stopDetail: null }, `${stage.name} started with ${options.crew.name} (run ${runId})`)
    if (options.note) this.deps.agents.send(runId, options.note, 'now')

    const unsubscribe = this.deps.agents.observe(runId, (notice: RunNotice) => {
      if (notice.type !== 'run-state') return
      if (notice.state === 'waiting') {
        void this.serial(ticket.id, async () => {
          const current = this.deps.tickets.get(ticket.id)
          if (current.currentRunId !== runId) return
          try {
            await onTurnEnd(current, runId)
          } catch (error) {
            this.deps.agents.end(runId)
            this.stop(this.deps.tickets.get(ticket.id), 'stuck', (error as Error).message)
          }
        })
      } else if (notice.state === 'running') {
        const current = this.deps.tickets.get(ticket.id)
        if (current.currentRunId === runId && current.status !== 'running') this.update(ticket.id, { status: 'running', waitingFor: null })
      }
    })
    void done.then((outcome: SessionOutcome) =>
      this.serial(ticket.id, async () => {
        unsubscribe()
        const current = this.deps.tickets.get(ticket.id)
        // The engine clears currentRunId before ending a run on purpose; anything else is a stop or a crash.
        if (current.currentRunId !== runId) return
        const limit = usageLimitMessage(outcome.error)
        const detail =
          outcome.state === 'stopped' ? 'You stopped the run. Start it again when you are ready.' : limit ? usageLimitDetail(limit) : `The agent stopped: ${outcome.error ?? 'no reason given'}`
        this.stop(current, 'stuck', detail)
      })
    )
    return runId
  }

  /** Ends the current run deliberately: the done handler sees currentRunId changed and does nothing. */
  endRun(ticket: Ticket): Ticket {
    const runId = ticket.currentRunId
    const updated = this.deps.tickets.update(ticket.id, { currentRunId: null })
    if (runId !== null) this.deps.agents.end(runId)
    return updated
  }

  /** The usage-limit message the run's last turn ended on, if it ran out of usage. */
  limitReached(runId: number): string | null {
    const last = this.deps.agents
      .view(runId)
      .events.filter((event) => event.kind === 'result')
      .at(-1)
    return last && last.kind === 'result' && !last.ok ? usageLimitMessage(last.text) : null
  }

  /**
   * Asks for a fixed output file once; returns false when it already asked and the file is still
   * wrong. Throws when the agent ran out of usage, since it can't fix anything until that resets.
   */
  requestFix(runId: number, file: string, problems: string[]): boolean {
    const limit = this.limitReached(runId)
    if (limit) throw new Error(usageLimitDetail(limit))
    if (this.fixRequested.has(runId)) return false
    this.fixRequested.add(runId)
    this.deps.agents.send(runId, formatFixMessage(file, problems), 'now')
    return true
  }

  // ---------- Moving between stages ----------

  /** Starts a backlog ticket at the first stage of the project's latest pipeline. */
  start(ticketId: number): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      if (ticket.stage !== 'backlog') throw new Error(`${ticket.key} has already started`)
      const pipeline = this.deps.pipelines.latest(ticket.projectId)
      const updated = this.update(ticketId, {
        pipelineVersion: pipeline.version,
        branch: ticket.branch ?? branchName(ticket.key, ticket.title),
        loop: 1,
        reviewFailures: 0,
        extraLoops: 0,
        linear: { ...ticket.linear, isNew: false }
      })
      const first = nextStage(pipeline.stages, '')
      if (!first) throw new Error('The pipeline has no stages')
      await this.enter(updated, first)
    })
  }

  private async enter(ticket: Ticket, stage: StageConfig, note?: string): Promise<void> {
    const entered = this.update(ticket.id, { stage: stage.id, status: 'running', waitingFor: null, stopReason: null, stopDetail: null }, `Entered ${stage.name}`)
    try {
      await this.deps.integrations?.stageEntered?.(entered, stage, this.project(entered))
    } catch (error) {
      this.deps.tickets.log(ticket.id, 'warning', `Couldn't update Linear: ${(error as Error).message}`)
    }
    const handler = this.handlers.get(stage.kind)
    if (!handler) {
      this.stop(entered, 'stuck', `${stage.name} can't run yet in this version of Eregion`)
      return
    }
    try {
      await handler(entered, stage, note)
    } catch (error) {
      this.stop(this.deps.tickets.get(ticket.id), 'stuck', (error as Error).message)
    }
  }

  /** Moves to the next stage, or finishes the ticket after the last one. */
  async advance(ticket: Ticket): Promise<void> {
    const next = nextStage(this.stages(ticket), ticket.stage)
    if (next) await this.enter(ticket, next)
    else await this.finish(ticket)
  }

  /** Tears down the environment and marks the ticket done. */
  async finish(ticket: Ticket): Promise<void> {
    await this.teardown(ticket)
    const done = this.update(ticket.id, { stage: 'done', status: 'done', waitingFor: null, stopReason: null, stopDetail: null, currentRunId: null }, 'Done')
    try {
      await this.deps.integrations?.ticketDone?.(done, this.project(done))
    } catch (error) {
      this.deps.tickets.log(ticket.id, 'warning', `Couldn't update Linear: ${(error as Error).message}`)
    }
  }

  async teardown(ticket: Ticket): Promise<void> {
    if (ticket.slot === null) return
    const project = this.project(ticket)
    const affectedRepoIds = project.repos.filter((repo) => ticket.affectedRepos.includes(repo.name)).map((repo) => repo.id)
    await this.deps.workspaces.teardown(`ticket:${ticket.id}`, project, { key: ticket.key, title: ticket.title, slot: ticket.slot, branch: ticket.branch ?? '', affectedRepoIds }, { log: (kind, message) => this.deps.tickets.log(ticket.id, kind, message) })
    this.deps.workspaces.forget(`ticket:${ticket.id}`)
    this.update(ticket.id, { slot: null }, 'Environment torn down')
    await this.wakeWaiting(ticket.projectId)
  }

  /** Starts tickets that were waiting for a slot, now that one is free. */
  private async wakeWaiting(projectId: number): Promise<void> {
    for (const ticket of this.deps.tickets.list(projectId).filter((item) => item.waitingFor === 'slot')) {
      const stage = this.stage(ticket)
      if (stage) void this.serial(ticket.id, () => this.enter(this.deps.tickets.get(ticket.id), stage))
    }
  }

  // ---------- Environments ----------

  private environmentKey(ticket: Ticket): string {
    return `ticket:${ticket.id}`
  }

  /** Makes sure the ticket has a slot and a ready environment. Returns null when it has to wait or setup failed. */
  async ensureEnvironment(ticket: Ticket): Promise<Environment | null> {
    const project = this.project(ticket)
    const key = this.environmentKey(ticket)
    let slot = ticket.slot
    if (slot === null) {
      const used = [...this.deps.tickets.usedSlots(project.id), ...this.deps.workspaces.liveSlots(project.id).filter((_, index) => this.deps.workspaces.list(project.id)[index]?.key !== key)]
      slot = nextFreeSlot(used, project.liveSlots)
      if (slot === null) {
        this.update(ticket.id, { status: 'idle', waitingFor: 'slot' }, `Waiting for a free slot (all ${project.liveSlots} in use)`)
        return null
      }
      ticket = this.update(ticket.id, { slot }, `Took slot ${slot}`)
    }
    const affectedRepoIds = project.repos.filter((repo) => ticket.affectedRepos.includes(repo.name)).map((repo) => repo.id)
    const existing = this.deps.workspaces.get(key)
    const sameRepos = existing?.repos.every((repo) => (repo.branch !== null) === affectedRepoIds.includes(repo.repoId))
    if (existing && existing.phase === 'ready' && sameRepos) return existing
    const environment = await this.deps.workspaces.create(
      key,
      project,
      { key: ticket.key, title: ticket.title, description: ticket.description, slot, branch: ticket.branch ?? branchName(ticket.key, ticket.title), affectedRepoIds },
      { log: (kind, message) => this.deps.tickets.log(ticket.id, kind, message) }
    )
    if (environment.phase !== 'ready') {
      this.stop(this.deps.tickets.get(ticket.id), 'setup_failed', environment.error ?? 'Setup failed')
      return null
    }
    return environment
  }

  worktreePaths(environment: Environment): Record<string, string> {
    return Object.fromEntries(environment.repos.map((repo) => [repo.name, repo.path]))
  }

  // ---------- Plan ----------

  private async runPlan(ticket: Ticket, stage: StageConfig, note?: string): Promise<void> {
    const project = this.project(ticket)
    const crew = this.crewFor(stage)
    const checkout = await this.deps.workspaces.refreshPlanCheckout(project)
    const paths = Object.fromEntries(checkout.repos.map((repo) => [repo.name, repo.path]))
    const base = Object.fromEntries(checkout.repos.map((repo) => [repo.name, repo.base]))
    const prompt = await this.promptFor(ticket, stage, crew, {
      'workspace.repos': this.repoLines(project, paths, (repo) => `read-only plan checkout of ${base[repo.name]}`)
    })
    await this.startRun(ticket, stage, { cwd: checkout.path, prompt, profile: 'plan', crew, note }, async (current, runId) => {
      // Out of usage, the planner can't answer you: stop and say so rather than wait for a reply.
      const limit = this.limitReached(runId)
      if (limit) throw new Error(usageLimitDetail(limit))
      const markdown = await this.readOutput(current, 'plan.md')
      if (markdown === null) {
        this.needsYou(current, 'answers', `${crew.name} is waiting for you`)
        return
      }
      const plan = this.plan(current, markdown)
      const open = plan.questions.filter((question) => !question.answered).length
      if (open > 0) this.needsYou(current, 'answers', `${open} ${open === 1 ? 'question' : 'questions'} waiting for you`)
      else this.needsYou(current, 'approval', planApprovalBlockers(plan).length === 0 ? 'The plan is ready for your approval' : 'The plan needs fixing before it can be approved')
    })
  }

  approvePlan(ticketId: number): Promise<void> {
    return this.serial(ticketId, async () => {
      let ticket = this.deps.tickets.get(ticketId)
      const stage = this.stage(ticket)
      if (stage?.kind !== 'plan') throw new Error(`${ticket.key} isn't in Plan`)
      const markdown = await this.readOutput(ticket, 'plan.md')
      if (markdown === null) throw new Error("There's no plan.md yet")
      const plan = this.plan(ticket, markdown)
      const blockers = planApprovalBlockers(plan)
      if (blockers.length > 0) throw new Error(blockers.join('. '))
      ticket = this.endRun(ticket)
      ticket = this.update(
        ticketId,
        { affectedRepos: plan.repos.filter((repo) => repo.changes).map((repo) => repo.name), planApprovedAt: new Date().toISOString(), status: 'running', waitingFor: null },
        `Plan approved. Changes: ${plan.repos.filter((repo) => repo.changes).map((repo) => repo.name).join(', ')}`
      )
      await this.keepHistory(ticket, 'plan.md', `plan-approved-${ticket.loop}.md`)
      // What goes back to Linear is the project's choice (setup step 6).
      try {
        await this.deps.integrations?.planApproved?.(ticket, markdown, this.project(ticket))
      } catch (error) {
        this.deps.tickets.log(ticketId, 'warning', `Couldn't post the plan to Linear: ${(error as Error).message}`)
      }
      await this.advance(ticket)
    })
  }

  // ---------- Build ----------

  private async runBuild(ticket: Ticket, stage: StageConfig, note?: string): Promise<void> {
    const environment = await this.ensureEnvironment(ticket)
    if (!environment) return
    ticket = this.deps.tickets.get(ticket.id)
    const project = this.project(ticket)
    const crew = this.crewFor(stage)
    const previousReview = await this.failedReview(ticket)
    await this.removeOutput(ticket, 'build-notes.md')
    await this.removeOutput(ticket, 'fixes.json')
    const firstAffected = project.repos.find((repo) => ticket.affectedRepos.includes(repo.name)) ?? project.repos[0]
    const prompt = await this.promptFor(ticket, stage, crew, {
      'workspace.repos': this.repoLines(project, this.worktreePaths(environment), (repo) => (ticket.affectedRepos.includes(repo.name) ? 'changes' : `read-only, detached at ${repo.defaultBranch}`)),
      'base.ref': `origin/${firstAffected.defaultBranch}`,
      'env.summary': this.envSummary(environment),
      'outputs.plan': (await this.readOutput(ticket, 'plan.md')) ?? '',
      'review.previous': previousReview?.text ?? ''
    })
    const cwd = await this.deps.workspaces.ticketFolder(project, project.repos[0], ticket.key)
    await this.startRun(ticket, stage, { cwd, prompt, profile: 'build', crew, note }, async (current, runId) => {
      const notesText = await this.readOutput(current, 'build-notes.md')
      const notes = notesText === null ? null : parseBuildNotes(notesText)
      const problems = notes ? [...notes.problems] : ["build-notes.md wasn't written"]
      if (notes?.blocked) {
        this.endRun(current)
        this.stop(this.deps.tickets.get(current.id), 'blocked', notes.blocked)
        return
      }
      let fixesProblems: string[] = []
      if (previousReview) {
        const fixesText = await this.readOutput(current, 'fixes.json')
        fixesProblems = fixesText === null ? ["fixes.json wasn't written"] : parseFixes(fixesText, previousReview.issueIds).problems
      }
      if (problems.length > 0 || fixesProblems.length > 0) {
        const file = problems.length > 0 ? 'build-notes.md' : 'fixes.json'
        if (this.requestFix(runId, file, problems.length > 0 ? problems : fixesProblems)) return
        this.endRun(current)
        this.stop(this.deps.tickets.get(current.id), 'stuck', `${file} isn't valid after one fix request: ${(problems.length > 0 ? problems : fixesProblems).join('; ')}`)
        return
      }
      const ended = this.endRun(current)
      if (notes?.blockedNote) this.deps.tickets.log(ended.id, 'note', `${crew.name}: ${notes.blockedNote}`)
      await this.keepHistory(ended, 'build-notes.md', `build-notes-${ended.loop}.md`)
      if (previousReview) await this.keepHistory(ended, 'fixes.json', `fixes-${ended.loop}.json`)
      await this.afterBuild(ended, stage, notes?.summary ?? '', environment)
    })
  }

  /** The review the next Build pass must answer, when the last review failed. */
  private async failedReview(ticket: Ticket): Promise<{ text: string; issueIds: string[] } | null> {
    if (ticket.reviewFailures === 0) return null
    const text = await this.readOutput(ticket, 'review.json')
    if (!text) return null
    try {
      const review = JSON.parse(text) as { verdict?: string; issues?: { id?: string }[] }
      if (review.verdict !== 'fail') return null
      return { text, issueIds: (review.issues ?? []).map((issue) => String(issue.id)) }
    } catch {
      return null
    }
  }

  private async afterBuild(ticket: Ticket, stage: StageConfig, summary: string, environment: Environment): Promise<void> {
    const project = this.project(ticket)
    const runner = this.runner(project)
    const commits: string[] = []
    if (stage.after.some((action) => action.type === 'commit')) {
      for (const repo of environment.repos.filter((item) => item.branch !== null)) {
        const sha = await commitAll(runner, repo.path, `${ticket.key}: ${ticket.title} (build pass ${ticket.loop})`, summary)
        if (sha) commits.push(`${repo.name} ${sha}`)
      }
      this.deps.tickets.log(ticket.id, 'git', commits.length ? `Committed ${commits.join(', ')}` : 'Nothing to commit')
    }
    if (stage.after.some((action) => action.type === 'push')) {
      for (const repo of environment.repos.filter((item) => item.branch !== null)) {
        if (!(await hasOrigin(runner, repo.path))) continue
        try {
          await pushBranch(runner, repo.path, repo.branch as string)
          this.deps.tickets.log(ticket.id, 'git', `Pushed ${repo.branch} in ${repo.name}`)
        } catch (error) {
          this.stop(ticket, 'stuck', `Couldn't push ${repo.name}: ${(error as Error).message}`)
          return
        }
      }
    }
    await this.runActions(ticket, stage.after.filter((action) => action.type === 'run' || action.type === 'notify'))
    await this.advance(this.deps.tickets.get(ticket.id))
  }

  async runActions(ticket: Ticket, actions: StageConfig['after']): Promise<void> {
    for (const action of actions) {
      if (action.type === 'notify') this.deps.integrations?.notify?.(`${ticket.key}: ${ticket.title}`, `${this.stage(ticket)?.name ?? 'Stage'} finished`)
      if (action.type === 'run') {
        const project = this.project(ticket)
        const runner = this.runner(project)
        const cwd = await this.deps.workspaces.ticketFolder(project, project.repos[0], ticket.key)
        const result = await runner.exec(runner.shell(action.command), { cwd, timeoutMs: 15 * 60_000 })
        this.deps.tickets.log(ticket.id, result.code === 0 ? 'action' : 'warning', `${action.command}: exit ${result.code}`)
      }
    }
  }

  // ---------- Review ----------

  private async runReview(ticket: Ticket, stage: StageConfig): Promise<void> {
    const environment = await this.ensureEnvironment(ticket)
    if (!environment) return
    ticket = this.deps.tickets.get(ticket.id)
    const project = this.project(ticket)
    const crew = this.crewFor(stage)
    const reReview = ticket.reviewFailures > 0
    const firstAffected = project.repos.find((repo) => ticket.affectedRepos.includes(repo.name)) ?? project.repos[0]
    const prompt = await this.promptFor(ticket, stage, crew, {
      'workspace.repos': this.repoLines(project, this.worktreePaths(environment), (repo) => (ticket.affectedRepos.includes(repo.name) ? 'changes' : `read-only, detached at ${repo.defaultBranch}`)),
      'base.ref': `origin/${firstAffected.defaultBranch}`,
      'env.summary': this.envSummary(environment),
      'outputs.plan': (await this.readOutput(ticket, 'plan.md')) ?? '',
      'outputs.build_notes': (await this.readOutput(ticket, 'build-notes.md')) ?? '',
      'review.previous': reReview ? ((await this.readOutput(ticket, 'review.json')) ?? '') : '',
      'fixes.current': reReview ? ((await this.readOutput(ticket, 'fixes.json')) ?? '') : ''
    })
    if (reReview) await this.keepHistory(ticket, 'review.json', `review-before-${ticket.loop}.json`)
    await this.removeOutput(ticket, 'review.json')
    const cwd = await this.deps.workspaces.ticketFolder(project, project.repos[0], ticket.key)
    await this.startRun(ticket, stage, { cwd, prompt, profile: 'review', crew }, async (current, runId) => {
      const text = await this.readOutput(current, 'review.json')
      const { review, problems } = text === null ? { review: null, problems: ["review.json wasn't written"] } : parseReview(text, project.repos.map((repo) => repo.name))
      if (!review) {
        if (this.requestFix(runId, 'review.json', problems)) return
        this.endRun(current)
        this.stop(this.deps.tickets.get(current.id), 'stuck', `review.json isn't valid after one fix request: ${problems.join('; ')}`)
        return
      }
      const runner = this.runner(project)
      for (const repo of environment.repos) {
        const changed = await changedFiles(runner, repo.path)
        if (changed.length > 0) {
          await discardChanges(runner, repo.path)
          this.deps.tickets.log(current.id, 'warning', `${crew.name} changed files in ${repo.name} during review; Eregion discarded them: ${changed.join(', ')}`)
        }
      }
      const ended = this.endRun(current)
      await this.keepHistory(ended, 'review.json', `review-${ended.loop}.json`)
      if (review.verdict === 'pass') {
        await this.runActions(ended, stage.after)
        this.needsYou(ended, 'manual-review', 'AI review passed. Your turn to check it.')
        return
      }
      const failures = ended.reviewFailures + 1
      const allowed = (stage.onFailure?.maxLoops ?? 2) + ended.extraLoops
      const returnTo = stageById(this.stages(ended), stage.onFailure?.returnTo ?? 'build')
      if (failures < allowed && returnTo) {
        const next = this.update(ended.id, { reviewFailures: failures, loop: ended.loop + 1 }, `Review failed (loop ${failures} of ${allowed}). Back to ${returnTo.name}.`)
        await this.enter(next, returnTo)
      } else {
        const stopped = this.update(ended.id, { reviewFailures: failures })
        this.stop(stopped, 'loop_limit', `Review failed on loop ${failures} of ${allowed}. Allow one more loop, or go back to Plan.`)
      }
    })
  }

  approveReview(ticketId: number): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      if (ticket.waitingFor !== 'manual-review') throw new Error(`${ticket.key} isn't waiting for your review`)
      await this.advance(this.update(ticketId, { status: 'running', waitingFor: null }, 'You approved the review'))
    })
  }

  sendBackToBuild(ticketId: number, note: string): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      if (ticket.waitingFor !== 'manual-review') throw new Error(`${ticket.key} isn't waiting for your review`)
      const build = this.stages(ticket).find((stage) => stage.kind === 'build')
      if (!build) throw new Error('This pipeline has no Build stage')
      const next = this.update(ticketId, { loop: ticket.loop + 1 }, 'You sent it back to Build')
      await this.enter(next, build, note.trim() || undefined)
    })
  }

  // ---------- Custom stages ----------

  private async runCustom(ticket: Ticket, stage: StageConfig, note?: string): Promise<void> {
    const project = this.project(ticket)
    const crew = this.crewFor(stage)
    let cwd: string
    let repos: string
    if (stage.workspace === 'ticket-worktrees') {
      const environment = await this.ensureEnvironment(ticket)
      if (!environment) return
      cwd = await this.deps.workspaces.ticketFolder(project, project.repos[0], ticket.key)
      repos = this.repoLines(project, this.worktreePaths(environment), (repo) => (ticket.affectedRepos.includes(repo.name) ? 'changes' : 'read-only'))
    } else {
      const checkout = await this.deps.workspaces.refreshPlanCheckout(project)
      cwd = checkout.path
      repos = this.repoLines(project, Object.fromEntries(checkout.repos.map((repo) => [repo.name, repo.path])), () => 'read-only')
    }
    const prompt = await this.promptFor(ticket, stage, crew, { 'workspace.repos': repos, 'outputs.plan': (await this.readOutput(ticket, 'plan.md')) ?? '' })
    await this.startRun(ticket, stage, { cwd, prompt, profile: 'build', crew, note }, async (current, runId) => {
      const missing: string[] = []
      for (const output of stage.outputs) {
        if ((await this.readOutput(current, output)) === null) missing.push(output)
      }
      if (missing.length > 0) {
        if (this.requestFix(runId, missing[0], [`${missing.join(', ')} wasn't written`])) return
        this.endRun(current)
        this.stop(this.deps.tickets.get(current.id), 'stuck', `${missing.join(', ')} still missing after one request`)
        return
      }
      if (stage.doneWhen === 'approval') {
        this.needsYou(current, 'approval', `${stage.name} is ready for your approval`)
        return
      }
      const ended = this.endRun(current)
      if (stage.doneWhen === 'command' && stage.doneCommand) {
        const runner = this.runner(project)
        const result = await runner.exec(runner.shell(stage.doneCommand), { cwd, timeoutMs: 15 * 60_000 })
        if (result.code !== 0) {
          this.stop(ended, 'stuck', `${stage.doneCommand} failed: ${(result.stderr || result.stdout).trim().slice(-500)}`)
          return
        }
      }
      await this.runActions(ended, stage.after)
      await this.advance(ended)
    })
  }

  /** Approves a custom stage that waits for your approval. */
  approveStage(ticketId: number): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      if (ticket.waitingFor !== 'approval' || this.stage(ticket)?.kind !== 'custom') throw new Error('Nothing is waiting for approval')
      await this.advance(this.endRun(ticket))
    })
  }

  // ---------- When a ticket stops ----------

  /** Starts the current stage again with a fresh run. */
  retry(ticketId: number, note?: string): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      const stage = this.stage(ticket)
      if (!stage) throw new Error(`${ticket.key} isn't in a stage`)
      if (ticket.currentRunId !== null && this.deps.agents.liveState(ticket.currentRunId)) throw new Error('A run is still going')
      await this.enter(ticket, stage, note)
    })
  }

  backToPlan(ticketId: number, note: string): Promise<void> {
    return this.serial(ticketId, async () => {
      let ticket = this.deps.tickets.get(ticketId)
      if (ticket.currentRunId !== null) {
        const runId = ticket.currentRunId
        ticket = this.deps.tickets.update(ticketId, { currentRunId: null })
        await this.deps.agents.stop(runId)
      }
      const plan = this.stages(ticket).find((stage) => stage.kind === 'plan')
      if (!plan) throw new Error('This pipeline has no Plan stage')
      const reason = ticket.stopReason === 'blocked' && ticket.stopDetail ? `Build stopped because the plan doesn't cover this:\n${ticket.stopDetail}` : ''
      const message = [reason, note.trim()].filter(Boolean).join('\n\n') || 'Please revise the plan.'
      await this.enter(this.update(ticketId, { loop: ticket.loop + 1, planApprovedAt: null }, 'Back to Plan'), plan, message)
    })
  }

  allowOneMoreLoop(ticketId: number): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      if (ticket.stopReason !== 'loop_limit') throw new Error(`${ticket.key} hasn't hit the loop limit`)
      const review = this.stage(ticket)
      const returnTo = stageById(this.stages(ticket), review?.onFailure?.returnTo ?? 'build')
      if (!returnTo) throw new Error('This pipeline has no Build stage')
      await this.enter(this.update(ticketId, { extraLoops: ticket.extraLoops + 1, loop: ticket.loop + 1 }, 'You allowed one more loop'), returnTo)
    })
  }

  releaseSlot(ticketId: number): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      await this.teardown(ticket)
      this.update(ticketId, { stopDetail: `${ticket.stopDetail ?? 'Stopped'} The slot was released; retry setup when you're ready.` })
    })
  }

  /**
   * Merges the latest base branch into the ticket's worktrees and sets the environment up again,
   * for when a fix lands on main after the ticket's branch was cut.
   */
  updateFromBase(ticketId: number): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      if (ticket.slot === null) throw new Error(`${ticket.key} doesn't have an environment yet`)
      if (ticket.currentRunId !== null && this.deps.agents.liveState(ticket.currentRunId)) throw new Error('An agent is working in the worktree. Stop the run first.')
      const project = this.project(ticket)
      const affectedRepoIds = project.repos.filter((repo) => ticket.affectedRepos.includes(repo.name)).map((repo) => repo.id)
      const environment = await this.deps.workspaces.updateFromBase(
        this.environmentKey(ticket),
        project,
        { key: ticket.key, title: ticket.title, description: ticket.description, slot: ticket.slot, branch: ticket.branch ?? branchName(ticket.key, ticket.title), affectedRepoIds },
        { log: (kind, message) => this.deps.tickets.log(ticketId, kind, message) }
      )
      const current = this.deps.tickets.get(ticketId)
      if (environment.phase !== 'ready') {
        this.stop(current, 'setup_failed', environment.error ?? 'Setup failed')
      } else if (current.stopReason === 'setup_failed') {
        this.update(ticketId, { stopDetail: 'Updated from the base branch and set up again. Start again to carry on.' }, 'Environment ready after updating from the base branch')
      } else {
        this.update(ticketId, {}, 'Environment ready after updating from the base branch')
      }
    })
  }

  stopRun(ticketId: number): Promise<void> {
    const ticket = this.deps.tickets.get(ticketId)
    if (ticket.currentRunId === null) return Promise.resolve()
    return this.deps.agents.stop(ticket.currentRunId)
  }

  /** Puts a ticket back in the Backlog: stops its run, tears down its environment, keeps its branch. */
  discard(ticketId: number): Promise<void> {
    return this.serial(ticketId, async () => {
      let ticket = this.deps.tickets.get(ticketId)
      if (ticket.currentRunId !== null) {
        const runId = ticket.currentRunId
        ticket = this.deps.tickets.update(ticketId, { currentRunId: null })
        await this.deps.agents.stop(runId)
      }
      await this.teardown(ticket)
      this.update(
        ticketId,
        { stage: 'backlog', status: 'idle', stopReason: null, stopDetail: null, waitingFor: null, loop: 1, reviewFailures: 0, extraLoops: 0, affectedRepos: [], planApprovedAt: null, pipelineVersion: null },
        'Moved back to Backlog'
      )
    })
  }

  /** After a restart no agent run is live: tickets that were running need you to start them again. */
  recover(): void {
    for (const ticket of this.deps.tickets.active()) {
      if (ticket.status === 'running') this.stop(ticket, 'stuck', 'Eregion was closed while this was running. Start it again to carry on.')
    }
  }
}
