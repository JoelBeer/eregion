import { usageLimitDetail, usageLimitMessage } from '@shared/agent'
import type { Environment } from '@shared/environment'
import { branchName, type Project, type Repo } from '@shared/model'
import { parseBuildNotes, parseFixes, parsePlan, parseReview, planApprovalBlockers, type ParsedBuildNotes, type ParsedPlan, type Review } from '@shared/outputs'
import { isGenericStage, nextStage, readsVerdict, sendBackTarget, stageAccess, stageById, verdictFile, type StageConfig, type StageKind } from '@shared/pipeline'
import { composePrompt } from '@shared/prompts'
import type { CrewMember } from '@shared/runs'
import { nextFreeSlot } from '@shared/slots'
import { render } from '@shared/template'
import { stageLoops, type StopReason, type Ticket, type WaitingFor } from '@shared/tickets'
import type { RunTooling } from '@shared/tooling'
import type { CrewStore } from '../agents/crew'
import type { AgentManager, RunNotice } from '../agents/manager'
import type { PermissionProfile, SessionOutcome } from '../agents/session'
import { runnerForRuntimeId } from '../projects/detect'
import type { ProjectStore } from '../projects/store'
import type { Runner } from '../runner'
import type { RunnerFor } from '../runner/types'
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
  runnerFor?: RunnerFor
  /** The MCP servers and skill rules each run gets (Settings › MCP servers and Skills). */
  tooling?: (project: Project, repoPaths: Record<string, string>, values: Record<string, string>) => Promise<RunTooling>
}

/** Where an earlier copy of an output file is kept: review.json for loop 2 is history/review-2.json. */
function historyName(file: string, suffix: string): string {
  const dot = file.lastIndexOf('.')
  return dot > 0 ? `${file.slice(0, dot)}-${suffix}${file.slice(dot)}` : `${file}-${suffix}`
}

/** What a resumed run is told: it's the same conversation, so this is all it needs. */
export const RESUME_MESSAGE = 'You were paused. Carry on from where you stopped: the files you wrote are still there.'

/** The message Eregion sends when a stage's output file doesn't pass its checks. */
export function formatFixMessage(file: string, problems: string[]): string {
  return `${file} isn't valid: ${problems.join('; ')}. Fix the file and don't change anything else.`
}

/**
 * Moves tickets through their pipeline: starts each stage's run, checks what it wrote, commits and
 * pushes its work, loops failed work back to an earlier stage, and stops a ticket with a reason when it needs you.
 * Everything that matters is saved on the ticket, so the board survives restarts.
 */
export class PipelineEngine {
  private readonly handlers = new Map<StageKind, StageHandler>()
  private readonly fixRequested = new Set<number>()
  /** Tickets whose next run carries on a paused conversation, by ticket id: the session to resume. */
  private readonly resuming = new Map<number, string>()
  private readonly locks = new Map<number, Promise<unknown>>()
  private readonly runnerFor: RunnerFor

  constructor(readonly deps: EngineDeps) {
    this.runnerFor = deps.runnerFor ?? runnerForRuntimeId
    this.handlers.set('plan', (ticket, stage, note) => this.runPlan(ticket, stage, note))
    // Every other stage runs from its fields (runStage); PR and Watch CI register their own.
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
    // A stage pinned to someone who has since left the crew falls back to its role.
    const pinned = stage.crewId ? crew.list().find((item) => item.id === stage.crewId) : undefined
    const member = pinned ?? (stage.crewRole ? crew.byRole(stage.crewRole) : undefined)
    const fallback = member ?? crew.list()[0]
    if (!fallback) throw new Error(`Nobody can run ${stage.name}: add a crew member first`)
    return fallback
  }

  /** The runner agents, git and gh use, as the project's GitHub account. A project's repos must share one runtime for agents to see them together. */
  runner(project: Project): Runner {
    const runtimes = new Set(project.repos.map((repo) => repo.runtime))
    if (runtimes.size === 0) throw new Error('This project has no repos')
    if (runtimes.size > 1) throw new Error("This project's repos run in different runtimes, so one agent can't work on them together")
    return this.runnerFor(project.repos[0].runtime, project)
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
    options: { cwd: string; prompt: string; profile: PermissionProfile; crew: CrewMember; note?: string; repoPaths?: Record<string, string> },
    onTurnEnd: (ticket: Ticket, runId: number) => Promise<void>
  ): Promise<number> {
    const project = this.project(ticket)
    const outputs = await this.outputsDir(ticket)
    const runner = this.runner(project)
    await runner.exec(['mkdir', '-p', outputs])
    // A repo's MCP servers run against this run's own copy of the repo: the ticket's worktrees, or the plan checkout.
    const environment = this.deps.workspaces.get(this.environmentKey(ticket))
    const repoPaths = options.repoPaths ?? (environment ? this.worktreePaths(environment) : {})
    const tooling = this.deps.tooling ? await this.deps.tooling(project, repoPaths, { ...(environment?.values ?? {}), 'ticket.key': ticket.key }) : null
    // A resumed run is the same conversation: it gets one message saying to carry on, not the stage prompt again.
    const resume = this.resuming.get(ticket.id)
    this.resuming.delete(ticket.id)
    const { runId, done } = this.deps.agents.start({
      ticketId: ticket.id,
      stage: stage.id,
      loop: ticket.loop,
      crew: options.crew,
      runner,
      cwd: options.cwd,
      prompt: resume ? `${options.note ?? RESUME_MESSAGE}\nOutputs folder: ${outputs}` : options.prompt,
      resume,
      profile: options.profile,
      addDirs: [outputs],
      mcpConfig: tooling?.mcpConfig,
      allowedTools: tooling?.allowedTools,
      deniedTools: tooling?.deniedTools,
      settings: tooling?.settings,
      conversational: true
    })
    this.update(ticket.id, { currentRunId: runId, status: 'running', waitingFor: null, stopReason: null, stopDetail: null }, resume ? `${stage.name} resumed with ${options.crew.name} (run ${runId})` : `${stage.name} started with ${options.crew.name} (run ${runId})`)
    if (options.note && !resume) this.deps.agents.send(runId, options.note, 'now')

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
    // An agent that can't carry on a conversation can't be asked to fix its file: the ticket stops instead.
    if (!this.deps.agents.canFollowUp(runId)) return false
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
        loops: {},
        returnedFrom: null,
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
      this.deps.tickets.log(ticket.id, 'warning', `Couldn't update the tracker: ${(error as Error).message}`)
    }
    await this.runHandler(entered, stage, note)
  }

  /** Runs the stage's handler: Plan, PR and Watch CI have their own, every other stage runs from its fields. */
  private async runHandler(ticket: Ticket, stage: StageConfig, note?: string): Promise<void> {
    const handler = this.handlers.get(stage.kind) ?? (isGenericStage(stage) ? (current: Ticket, config: StageConfig, text?: string) => this.runStage(current, config, text) : undefined)
    if (!handler) {
      this.stop(ticket, 'stuck', `${stage.name} can't run yet in this version of Eregion`)
      return
    }
    try {
      await handler(ticket, stage, note)
    } catch (error) {
      // A resume that never got as far as its run mustn't turn a later fresh start into one.
      this.resuming.delete(ticket.id)
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
    await this.startRun(ticket, stage, { cwd: checkout.path, prompt, profile: 'plan', crew, note, repoPaths: paths }, async (current, runId) => {
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

  // ---------- Generic stages ----------

  /** The stage whose failed work this one has to answer: the ticket came back here from it. */
  private failedVerdict(ticket: Ticket, stage: StageConfig): StageConfig | null {
    const from = ticket.returnedFrom ? stageById(this.stages(ticket), ticket.returnedFrom) : undefined
    return from && from.onFailure?.returnTo === stage.id && verdictFile(from) ? from : null
  }

  /** The issue ids of a failed verdict, which fixes.json has to answer. */
  private async verdictIssues(ticket: Ticket, verdictStage: StageConfig): Promise<{ text: string; issueIds: string[] } | null> {
    const file = verdictFile(verdictStage)
    const text = file ? await this.readOutput(ticket, file) : null
    if (!text) return null
    try {
      const verdict = JSON.parse(text) as { verdict?: string; issues?: { id?: string }[] }
      if (verdict.verdict !== 'fail') return null
      return { text, issueIds: (verdict.issues ?? []).map((issue) => String(issue.id)) }
    } catch {
      return null
    }
  }

  /**
   * Runs any stage that isn't Plan, PR or Watch CI, entirely from its fields: where it works, whether it may
   * change files, what it must write, how it's done, and where it goes when its work fails. Output files are
   * read by name: build-notes.md can stop the ticket as Blocked and gives the commit its summary, the stage's
   * verdict file says pass or fail, and fixes.json answers the verdict that sent the work back here.
   */
  private async runStage(ticket: Ticket, stage: StageConfig, note?: string): Promise<void> {
    const project = this.project(ticket)
    const crew = this.crewFor(stage)
    const access = stageAccess(stage)
    let cwd: string
    let repoPaths: Record<string, string>
    let environment: Environment | null = null
    let repos: string
    if (stage.workspace === 'ticket-worktrees') {
      environment = await this.ensureEnvironment(ticket)
      if (!environment) return
      ticket = this.deps.tickets.get(ticket.id)
      cwd = await this.deps.workspaces.ticketFolder(project, project.repos[0], ticket.key)
      repoPaths = this.worktreePaths(environment)
      repos = this.repoLines(project, repoPaths, (repo) =>
        access === 'changes' && ticket.affectedRepos.includes(repo.name) ? 'changes' : ticket.affectedRepos.includes(repo.name) ? 'read-only' : `read-only, detached at ${repo.defaultBranch}`
      )
    } else {
      const checkout = await this.deps.workspaces.refreshPlanCheckout(project)
      cwd = checkout.path
      repoPaths = Object.fromEntries(checkout.repos.map((repo) => [repo.name, repo.path]))
      repos = this.repoLines(project, repoPaths, () => 'read-only')
    }

    const answering = this.failedVerdict(ticket, stage)
    const previous = answering ? await this.verdictIssues(ticket, answering) : null
    const ownVerdict = verdictFile(stage)
    const recheck = ownVerdict !== null && (ticket.loops[stage.id]?.failures ?? 0) > 0
    const firstAffected = project.repos.find((repo) => ticket.affectedRepos.includes(repo.name)) ?? project.repos[0]
    const prompt = await this.promptFor(ticket, stage, crew, {
      'workspace.repos': repos,
      'base.ref': `origin/${firstAffected.defaultBranch}`,
      'env.summary': this.envSummary(environment ?? undefined),
      'outputs.plan': (await this.readOutput(ticket, 'plan.md')) ?? '',
      'outputs.build_notes': (await this.readOutput(ticket, 'build-notes.md')) ?? '',
      'review.previous': previous?.text ?? (recheck && ownVerdict ? ((await this.readOutput(ticket, ownVerdict)) ?? '') : ''),
      'fixes.current': recheck ? ((await this.readOutput(ticket, 'fixes.json')) ?? '') : ''
    })
    if (!this.isResuming(ticket.id)) {
      if (recheck && ownVerdict) await this.keepHistory(ticket, ownVerdict, historyName(ownVerdict, `before-${ticket.loop}`))
      for (const output of stage.outputs) await this.removeOutput(ticket, output)
      if (previous) await this.removeOutput(ticket, 'fixes.json')
    }

    await this.startRun(ticket, stage, { cwd, prompt, profile: access === 'changes' ? 'build' : 'review', crew, note, repoPaths }, async (current, runId) => {
      const problems: { file: string; problems: string[] }[] = []
      let notes: ParsedBuildNotes | null = null
      let verdict: Review | null = null
      for (const output of stage.outputs) {
        const text = await this.readOutput(current, output)
        if (text === null) {
          problems.push({ file: output, problems: [`${output} wasn't written`] })
        } else if (output === 'build-notes.md') {
          notes = parseBuildNotes(text)
          if (notes.problems.length > 0) problems.push({ file: output, problems: notes.problems })
        } else if (output === ownVerdict) {
          const parsed = parseReview(text, project.repos.map((repo) => repo.name))
          verdict = parsed.review
          if (!parsed.review) problems.push({ file: output, problems: parsed.problems })
        }
      }
      if (notes?.blocked) {
        this.endRun(current)
        this.stop(this.deps.tickets.get(current.id), 'blocked', notes.blocked)
        return
      }
      if (previous) {
        const fixesText = await this.readOutput(current, 'fixes.json')
        const fixes = fixesText === null ? ["fixes.json wasn't written"] : parseFixes(fixesText, previous.issueIds).problems
        if (fixes.length > 0) problems.push({ file: 'fixes.json', problems: fixes })
      }
      if (problems.length > 0) {
        if (this.requestFix(runId, problems[0].file, problems[0].problems)) return
        this.endRun(current)
        this.stop(this.deps.tickets.get(current.id), 'stuck', `${problems[0].file} isn't valid after one fix request: ${problems[0].problems.join('; ')}`)
        return
      }
      if (stage.doneWhen === 'approval') {
        this.needsYou(current, 'approval', `${stage.name} is ready for your approval`)
        return
      }
      let ended = this.endRun(current)
      if (notes?.blockedNote) this.deps.tickets.log(ended.id, 'note', `${crew.name}: ${notes.blockedNote}`)
      for (const output of [...stage.outputs, ...(previous ? ['fixes.json'] : [])]) await this.keepHistory(ended, output, historyName(output, String(ended.loop)))

      if (environment && access === 'read-only') await this.discardStageChanges(ended, environment, crew)
      if (environment && access === 'changes' && !(await this.commitAndPush(ended, stage, notes?.summary ?? '', environment))) return

      if (stage.doneWhen === 'command' && stage.doneCommand) {
        const runner = this.runner(project)
        const result = await runner.exec(runner.shell(stage.doneCommand), { cwd, timeoutMs: 15 * 60_000 })
        if (result.code !== 0) {
          await this.failed(ended, stage, `${stage.doneCommand} failed: ${(result.stderr || result.stdout).trim().slice(-500)}`)
          return
        }
      }
      if (readsVerdict(stage) && (verdict as Review | null)?.verdict !== 'pass') {
        await this.failed(ended, stage, `${stage.name} failed`)
        return
      }
      if (ended.returnedFrom === stage.id) ended = this.update(ended.id, { returnedFrom: null })
      await this.runActions(ended, stage.after)
      if (stage.doneWhen === 'review-pass') {
        this.needsYou(ended, 'manual-review', `${stage.name} passed. Your turn to check it.`)
        return
      }
      await this.advance(this.deps.tickets.get(ended.id))
    })
  }

  /** A read-only stage changed files: throw the changes away and say so. */
  private async discardStageChanges(ticket: Ticket, environment: Environment, crew: CrewMember): Promise<void> {
    const runner = this.runner(this.project(ticket))
    for (const repo of environment.repos) {
      const changed = await changedFiles(runner, repo.path)
      if (changed.length > 0) {
        await discardChanges(runner, repo.path)
        this.deps.tickets.log(ticket.id, 'warning', `${crew.name} changed files in ${repo.name} during ${this.stage(ticket)?.name ?? 'a read-only stage'}; Eregion discarded them: ${changed.map((line) => line.replace(/^.. /, '')).join(', ')}`)
      }
    }
  }

  /** Commits and pushes the stage's work when its after-actions say so. Returns false when the ticket stopped. */
  private async commitAndPush(ticket: Ticket, stage: StageConfig, summary: string, environment: Environment): Promise<boolean> {
    const runner = this.runner(this.project(ticket))
    if (stage.after.some((action) => action.type === 'commit')) {
      const commits: string[] = []
      for (const repo of environment.repos.filter((item) => item.branch !== null)) {
        const sha = await commitAll(runner, repo.path, `${ticket.key}: ${ticket.title} (${stage.name.toLowerCase()} pass ${ticket.loop})`, summary)
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
          return false
        }
      }
    }
    return true
  }

  /**
   * The stage's work failed (a fail verdict, or its done command failing). With an on-fail loop it goes back
   * to that stage until the limit, then stops at the loop limit; without one it stops and asks you.
   */
  private async failed(ticket: Ticket, stage: StageConfig, detail: string): Promise<void> {
    const returnTo = stage.onFailure ? stageById(this.stages(ticket), stage.onFailure.returnTo) : undefined
    if (!stage.onFailure || !returnTo) {
      this.stop(ticket, 'stuck', `${detail}. Fix it and start the stage again, or go back to Plan.`)
      return
    }
    const { failures, allowed } = stageLoops(ticket, stage.id, stage.onFailure.maxLoops)
    const loops = { ...ticket.loops, [stage.id]: { failures: failures + 1, extra: ticket.loops[stage.id]?.extra ?? 0 } }
    if (failures + 1 < allowed) {
      const next = this.update(ticket.id, { loops, returnedFrom: stage.id, loop: ticket.loop + 1 }, `${stage.name} failed (loop ${failures + 1} of ${allowed}). Back to ${returnTo.name}.`)
      await this.enter(next, returnTo)
    } else {
      const stopped = this.update(ticket.id, { loops, returnedFrom: stage.id })
      this.stop(stopped, 'loop_limit', `${stage.name} failed on loop ${failures + 1} of ${allowed}. Allow one more loop, or go back to Plan.`)
    }
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

  /** You checked a stage whose verdict passed: carry on. */
  approveReview(ticketId: number): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      if (ticket.waitingFor !== 'manual-review') throw new Error(`${ticket.key} isn't waiting for your check`)
      await this.advance(this.update(ticketId, { status: 'running', waitingFor: null }, `You approved ${this.stage(ticket)?.name ?? 'the stage'}`))
    })
  }

  /**
   * You checked a stage and want more work: back to where its failed work would go (or the nearest earlier
   * stage that changes files), with your note. It doesn't use up a loop.
   */
  sendBack(ticketId: number, note: string): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      if (ticket.waitingFor !== 'manual-review' && ticket.waitingFor !== 'approval') throw new Error(`${ticket.key} isn't waiting for you to check it`)
      const target = sendBackTarget(this.stages(ticket), ticket.stage)
      if (!target) throw new Error('There is no earlier stage that changes files')
      const next = this.update(this.endRun(ticket).id, { loop: ticket.loop + 1 }, `You sent it back to ${target.name}`)
      await this.enter(next, target, note.trim() || undefined)
    })
  }

  /** Approves a stage that waits for your approval, then commits and pushes its work as its after-actions say. */
  approveStage(ticketId: number): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      const stage = this.stage(ticket)
      if (ticket.waitingFor !== 'approval' || !stage || !isGenericStage(stage)) throw new Error('Nothing is waiting for approval')
      const ended = this.endRun(ticket)
      const environment = stage.workspace === 'ticket-worktrees' ? this.deps.workspaces.get(this.environmentKey(ended)) : undefined
      if (environment && stageAccess(stage) === 'read-only') await this.discardStageChanges(ended, environment, this.crewFor(stage))
      if (environment && stageAccess(stage) === 'changes') {
        const notes = stage.outputs.includes('build-notes.md') ? await this.readOutput(ended, 'build-notes.md') : null
        if (!(await this.commitAndPush(ended, stage, notes ? parseBuildNotes(notes).summary : '', environment))) return
      }
      await this.runActions(ended, stage.after)
      await this.advance(this.update(ticketId, { status: 'running', waitingFor: null }, `You approved ${stage.name}`))
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
      const stage = this.stage(ticket)
      const returnTo = stage?.onFailure ? stageById(this.stages(ticket), stage.onFailure.returnTo) : undefined
      if (!stage || !returnTo) throw new Error(`${stage?.name ?? 'This stage'} has nowhere to go back to`)
      const entry = ticket.loops[stage.id] ?? { failures: 0, extra: 0 }
      const loops = { ...ticket.loops, [stage.id]: { ...entry, extra: entry.extra + 1 } }
      await this.enter(this.update(ticketId, { loops, loop: ticket.loop + 1 }, 'You allowed one more loop'), returnTo)
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

  /**
   * Pauses the running stage: the agent stops, but its conversation and what it wrote are kept, so Resume
   * carries on where it was. The environment keeps running.
   */
  pause(ticketId: number): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      const stage = this.stage(ticket)
      if (ticket.currentRunId === null || !this.deps.agents.liveState(ticket.currentRunId) || !stage) throw new Error(`Nothing is running on ${ticket.key}`)
      const runId = ticket.currentRunId
      this.update(ticketId, { currentRunId: null, status: 'stopped', waitingFor: null, stopReason: null, stopDetail: null }, `Paused ${stage.name}`)
      await this.deps.agents.stop(runId)
    })
  }

  /**
   * Carries on a paused stage in the same conversation, when its agent can carry one on (otherwise the stage
   * starts again). Plan and the stages that run from their fields resume; PR and Watch CI start again.
   */
  resume(ticketId: number): Promise<void> {
    return this.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      const stage = this.stage(ticket)
      if (ticket.status !== 'stopped' || !stage) throw new Error(`${ticket.key} isn't paused`)
      const session = stage.kind === 'plan' || isGenericStage(stage) ? this.deps.agents.resumable(ticketId, stage.id) : null
      if (!session) {
        await this.enter(this.update(ticketId, {}, `Starting ${stage.name} again: its conversation can't be carried on`), stage)
        return
      }
      this.resuming.set(ticketId, session.sessionId)
      await this.runHandler(this.update(ticketId, { status: 'running', stopDetail: null }, `Resuming ${stage.name}`), stage)
    })
  }

  /** Whether the ticket's next run carries on a paused conversation (so the stage keeps what it already wrote). */
  isResuming(ticketId: number): boolean {
    return this.resuming.has(ticketId)
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
        { stage: 'backlog', status: 'idle', stopReason: null, stopDetail: null, waitingFor: null, loop: 1, loops: {}, returnedFrom: null, affectedRepos: [], planApprovedAt: null, pipelineVersion: null },
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
