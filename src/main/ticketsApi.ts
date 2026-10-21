import type { PrStore } from './pipeline/prs'
import type { EregionApi } from '@shared/api'
import { ticketCard } from '@shared/cards'
import { parseBuildNotes, parseFixes, parsePlan, parseReview, planApprovalBlockers } from '@shared/outputs'
import { parseDiff, type RepoDiff, type TicketOutputs } from '@shared/ticketDetail'
import type { Ticket, TicketCard } from '@shared/tickets'
import type { Db } from './db'
import type { CrewStore } from './agents/crew'
import type { AgentManager } from './agents/manager'
import type { RunStore } from './agents/runs'
import type { PipelineEngine } from './pipeline/engine'
import type { PipelineStore, TicketStore } from './pipeline/stores'
import type { ProjectStore } from './projects/store'
import { branchDiff, filesToReview } from './workspace/git'
import type { Workspaces } from './workspace/workspaces'
import type { Editors } from './editors'
import type { Runner } from './runner/types'

export type TicketsApi = Pick<
  EregionApi,
  | 'listTickets'
  | 'getTicket'
  | 'getTicketOutputs'
  | 'getTicketDiff'
  | 'createTicket'
  | 'startTicket'
  | 'approvePlan'
  | 'approveReview'
  | 'approveStage'
  | 'sendBack'
  | 'backToPlan'
  | 'retryTicket'
  | 'allowOneMoreLoop'
  | 'releaseSlot'
  | 'stopTicketRun'
  | 'pauseTicket'
  | 'resumeTicket'
  | 'discardTicket'
  | 'startServices'
  | 'stopServices'
  | 'openInEditor'
  | 'getEditor'
  | 'setEditor'
  | 'listEditors'
  | 'updateFromBase'
  | 'getPipeline'
  | 'savePipeline'
  | 'listPipelineVersions'
  | 'getPipelineVersion'
  | 'restorePipelineVersion'
  | 'restorePipelineStage'
>

export interface TicketsApiDeps {
  db: Db
  editors: Editors
  /** The runner for this machine's first runtime, where Settings looks for editors. */
  machineRunner: () => Runner
  projects: ProjectStore
  tickets: TicketStore
  pipelines: PipelineStore
  crew: CrewStore
  runs: RunStore
  agents: AgentManager
  workspaces: Workspaces
  engine: PipelineEngine
  /** The pull requests store, so cards can show Watch CI. */
  prs?: PrStore
  /** Called after work that started in the background fails, so the error is not lost. */
  onBackgroundError(ticketId: number, error: Error): void
}

/** Runs pipeline work in the background: screens follow it through ticket events. */
function background(deps: TicketsApiDeps, ticketId: number, task: () => Promise<void>): Promise<void> {
  void task().catch((error: Error) => deps.onBackgroundError(ticketId, error))
  return Promise.resolve()
}

export function createTicketsApi(deps: TicketsApiDeps): TicketsApi {
  const { db, projects, tickets, pipelines, crew, runs, workspaces, engine } = deps

  const lastAgentText = (ticket: Ticket): string | null => {
    const runId = ticket.currentRunId ?? runs.forTicket(ticket.id).at(-1)?.id
    if (!runId) return null
    const events = runs.events(runId)
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event.kind === 'text') return event.text
    }
    return null
  }

  const prLinks = (ticket: Ticket): { label: string; url: string }[] =>
    (db.prepare('SELECT r.name AS repo, p.number, p.url FROM pull_requests p JOIN repos r ON r.id = p.repo_id WHERE p.ticket_id = ? ORDER BY r.position').all(ticket.id) as { repo: string; number: number; url: string }[]).map(
      (row) => ({ label: `${row.repo} #${row.number}`, url: row.url })
    )

  const openQuestions = async (ticket: Ticket): Promise<number> => {
    if (ticket.waitingFor !== 'answers') return 0
    try {
      const markdown = await engine.readOutput(ticket, 'plan.md')
      return markdown ? engine.plan(ticket, markdown).questions.filter((question) => !question.answered).length : 0
    } catch {
      return 0
    }
  }

  const card = async (ticket: Ticket): Promise<TicketCard> => {
    const stages = engine.stages(ticket)
    const stage = stages.find((item) => item.id === ticket.stage)
    let crewId: number | null = null
    try {
      crewId = stage ? engine.crewFor(stage).id : null
    } catch {
      crewId = null
    }
    return ticketCard({ ticket, stages, crewId, environment: workspaces.get(`ticket:${ticket.id}`), lastAgentText: lastAgentText(ticket), openQuestions: await openQuestions(ticket), prLinks: prLinks(ticket), prs: deps.prs?.forTicket(ticket.id) })
  }

  const readOutputs = async (ticket: Ticket): Promise<TicketOutputs> => {
    const project = projects.get(ticket.projectId)
    const repoNames = project.repos.map((repo) => repo.name)
    const dir = await engine.outputsDir(ticket)
    const read = (name: string): Promise<string | null> => engine.readOutput(ticket, name)
    const [planText, notesText, reviewText, fixesText] = await Promise.all([read('plan.md'), read('build-notes.md'), read('review.json'), read('fixes.json')])
    const plan = planText === null ? null : parsePlan(planText, repoNames)
    const review = reviewText === null ? null : parseReview(reviewText, repoNames)
    const runner = engine.runner(project)
    const listing = await runner.exec(['sh', '-c', 'ls -1 "$1" 2>/dev/null; true', 'sh', runner.join(dir, 'history')])
    // fixes.json answers the review before its Build pass, which is kept in history once a newer review runs.
    const idsIn = (text: string | null): string[] => {
      try {
        return text ? ((JSON.parse(text) as { issues?: { id: string }[] }).issues ?? []).map((issue) => issue.id) : []
      } catch {
        return []
      }
    }
    let answered = reviewText
    try {
      const loop = fixesText ? Number((JSON.parse(fixesText) as { loop?: unknown }).loop) : NaN
      if (Number.isInteger(loop) && loop > 1) answered = (await read(`history/review-${loop - 1}.json`)) ?? reviewText
    } catch {
      answered = reviewText
    }
    const issueIds = idsIn(answered)
    const prDescriptions: Record<string, string> = {}
    for (const name of repoNames) {
      const text = await read(`pr-${name}.md`)
      if (text !== null) prDescriptions[name] = text
    }
    return {
      prDescriptions,
      dir,
      plan: plan && planText !== null ? { markdown: planText, parsed: plan, blockers: planApprovalBlockers(plan) } : null,
      buildNotes: notesText === null ? null : { markdown: notesText, parsed: parseBuildNotes(notesText) },
      review: reviewText === null || !review ? null : { text: reviewText, review: review.review, problems: review.problems },
      fixes: fixesText === null ? null : (() => {
        const parsed = parseFixes(fixesText, issueIds)
        return { text: fixesText, fixes: parsed.fixes, problems: parsed.problems }
      })(),
      history: listing.stdout.split('\n').filter(Boolean)
    }
  }

  return {
    listTickets: async (projectId) => Promise.all(tickets.list(projectId).map(card)),
    getTicket: async (ticketId) => {
      const ticket = tickets.get(ticketId)
      return {
        card: await card(ticket),
        stages: engine.stages(ticket),
        runs: runs.forTicket(ticketId),
        environment: workspaces.get(`ticket:${ticketId}`) ?? null,
        log: tickets.logEntries(ticketId)
      }
    },
    getTicketOutputs: async (ticketId) => readOutputs(tickets.get(ticketId)),
    getTicketDiff: async (ticketId) => {
      const ticket = tickets.get(ticketId)
      const project = projects.get(ticket.projectId)
      const environment = workspaces.get(`ticket:${ticketId}`)
      const outputs = await readOutputs(ticket).catch(() => null)
      const severities = new Map((outputs?.review?.review?.issues ?? []).map((issue) => [issue.id, issue.severity]))
      let previousIssues: Map<string, string> = severities
      try {
        const runner = engine.runner(project)
        const history = outputs?.history.filter((name) => name.startsWith('review-')).sort() ?? []
        for (const name of history) {
          const text = await runner.readFile(runner.join(outputs?.dir ?? '', 'history', name))
          for (const issue of (JSON.parse(text ?? '{}') as { issues?: { id: string; severity: string }[] }).issues ?? []) previousIssues.set(issue.id, issue.severity)
        }
      } catch {
        previousIssues = severities
      }
      const result: RepoDiff[] = []
      for (const repo of project.repos) {
        const state = environment?.repos.find((item) => item.repoId === repo.id)
        const runner = engine.runner(project)
        const path = state?.path ?? (await workspaces.worktreePath(project, repo, ticket.key))
        const base = `origin/${repo.defaultBranch}`
        if (!ticket.affectedRepos.includes(repo.name)) continue
        try {
          const files = parseDiff(await branchDiff(runner, path, base)).map((file) => ({
            ...file,
            fixes: (outputs?.fixes?.fixes ?? [])
              .filter((fix) => fix.fixed && (fix.files.includes(`${repo.name}/${file.path}`) || fix.files.includes(file.path)))
              .map((fix) => ({ issueId: fix.issueId, severity: previousIssues.get(fix.issueId) ?? 'medium' }))
          }))
          result.push({ repo: repo.name, branch: ticket.branch, base, files, error: null })
        } catch (error) {
          result.push({ repo: repo.name, branch: ticket.branch, base, files: [], error: (error as Error).message })
        }
      }
      return result
    },
    createTicket: async (projectId, title, description) => {
      const project = projects.get(projectId)
      if (!title.trim()) throw new Error('Give the ticket a title')
      const count = (db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE project_id = ?').get(projectId) as { n: number }).n
      let number = count + 1
      while (tickets.findByKey(projectId, `${project.initials}-${number}`)) number++
      return tickets.create({ projectId, key: `${project.initials}-${number}`, title: title.trim(), description })
    },
    startTicket: (ticketId) => background(deps, ticketId, () => engine.start(ticketId)),
    approvePlan: (ticketId) => engine.approvePlan(ticketId),
    approveReview: (ticketId) => background(deps, ticketId, () => engine.approveReview(ticketId)),
    approveStage: (ticketId) => background(deps, ticketId, () => engine.approveStage(ticketId)),
    sendBack: (ticketId, note) => background(deps, ticketId, () => engine.sendBack(ticketId, note)),
    backToPlan: (ticketId, note) => background(deps, ticketId, () => engine.backToPlan(ticketId, note)),
    retryTicket: (ticketId, note) => background(deps, ticketId, () => engine.retry(ticketId, note)),
    allowOneMoreLoop: (ticketId) => background(deps, ticketId, () => engine.allowOneMoreLoop(ticketId)),
    releaseSlot: (ticketId) => engine.releaseSlot(ticketId),
    stopTicketRun: (ticketId) => engine.stopRun(ticketId),
    pauseTicket: (ticketId) => engine.pause(ticketId),
    resumeTicket: (ticketId) => background(deps, ticketId, () => engine.resume(ticketId)),
    discardTicket: (ticketId) => engine.discard(ticketId),
    startServices: async (ticketId) => {
      const ticket = tickets.get(ticketId)
      if (ticket.slot === null) throw new Error("This ticket doesn't have an environment")
      const project = projects.get(ticket.projectId)
      if (!workspaces.get(`ticket:${ticketId}`)) {
        await engine.ensureEnvironment(ticket)
        return
      }
      await workspaces.startServices(`ticket:${ticketId}`, project, { key: ticket.key, title: ticket.title, slot: ticket.slot, branch: ticket.branch ?? '' })
    },
    stopServices: (ticketId) => workspaces.stopServices(`ticket:${ticketId}`),
    updateFromBase: (ticketId) => engine.updateFromBase(ticketId),
    openInEditor: async (ticketId, repoName, options = {}) => {
      const ticket = tickets.get(ticketId)
      const project = projects.get(ticket.projectId)
      const repo = project.repos.find((item) => item.name === repoName)
      if (!repo) throw new Error(`No repo called ${repoName}`)
      const path = workspaces.get(`ticket:${ticketId}`)?.repos.find((item) => item.repoId === repo.id)?.path ?? (await workspaces.worktreePath(project, repo, ticket.key))
      const runner = engine.runner(project)
      const files = options.changed ? await filesToReview(runner, path, `origin/${repo.defaultBranch}`) : (options.files ?? [])
      const opened = await deps.editors.open(runner, path, files)
      return { opened, total: files.length }
    },
    getEditor: async () => deps.editors.choice(),
    setEditor: async (choice) => deps.editors.setChoice(choice),
    listEditors: () => deps.editors.list(deps.machineRunner()),
    getPipeline: async (projectId) => {
      const latest = pipelines.latest(projectId)
      return { version: latest.version, stages: latest.stages, olderVersions: pipelines.ticketsOnOlderVersions(projectId) }
    },
    savePipeline: async (projectId, stages) => {
      for (const stage of stages) {
        if (stage.crewId !== null) crew.get(stage.crewId)
      }
      return pipelines.save(projectId, stages).version
    },
    listPipelineVersions: async (projectId) => pipelines.versions(projectId),
    getPipelineVersion: async (projectId, version) => pipelines.get(projectId, version),
    restorePipelineVersion: async (projectId, version) => pipelines.restore(projectId, version).version,
    restorePipelineStage: async (projectId, version, stageId) => pipelines.restoreStage(projectId, version, stageId).version
  }
}

/** Keeps tickets stopped consistently when background work fails. */
export function backgroundErrorHandler(tickets: TicketStore, emit: (ticket: Ticket) => void, agents: AgentManager): (ticketId: number, error: Error) => void {
  return (ticketId, error) => {
    const ticket = tickets.get(ticketId)
    if (ticket.currentRunId !== null && agents.liveState(ticket.currentRunId)) return
    const updated = tickets.update(ticketId, { status: 'needs_you', stopReason: 'stuck', stopDetail: error.message, waitingFor: null })
    tickets.log(ticketId, 'error', error.message)
    emit(updated)
  }
}
