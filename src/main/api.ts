import { readFile, writeFile } from 'node:fs/promises'
import type { EregionApi, EregionEvent, VariablePreview } from '@shared/api'
import type { Environment } from '@shared/environment'
import { branchName, type ProjectFile, type Variable } from '@shared/model'
import { nextFreeSlot } from '@shared/slots'
import { resolveVariables } from '@shared/variables'
import type { Db } from './db'
import { detectRepo, detectRepoAt } from './projects/detect'
import { ProjectStore } from './projects/store'
import { ticketBuiltins } from './recipe/context'
import { ServiceManager } from './recipe/services'
import { checkTools } from './tools'
import { Workspaces, type WorkspaceTicket } from './workspace/workspaces'
import { CrewStore } from './agents/crew'
import { AgentManager } from './agents/manager'
import { RunStore } from './agents/runs'
import type { CrewMember } from '@shared/runs'
import type { Ticket } from '@shared/tickets'
import { getSetting, setSetting } from './db'
import { PipelineEngine } from './pipeline/engine'
import { PipelineStore, TicketStore } from './pipeline/stores'
import { backgroundErrorHandler, createTicketsApi } from './ticketsApi'

/** What the API needs from Electron, kept behind an interface so the API can be tested without it. */
export interface Host {
  appVersion: string
  databasePath: string
  pickFolder(): Promise<string | null>
  pickSaveFile(defaultName: string): Promise<string | null>
  pickOpenFile(): Promise<string | null>
  openExternal(url: string): Promise<void>
  emit(event: EregionEvent): void
  /** Shows a desktop notification, where the host supports them. */
  notify?(title: string, body: string): void
  /** The person's name from the operating system, until Linear provides one. */
  userName?: string
}

export function sampleTicket(projectKey: string | null): VariablePreview['sample'] {
  const key = `${projectKey ?? 'TEST'}-1`
  return { key, title: 'Sample ticket', slot: 1, branch: branchName(key, 'Sample ticket') }
}

export interface BackendOptions {
  /** Overrides ~/.eregion for worktrees, for tests. */
  workspaceRoot?: string
  /** Replaces the agent CLI for a crew member, for tests and the web preview. */
  agentCommand?: (crew: CrewMember) => string[] | undefined
}

export interface Backend {
  api: EregionApi
  workspaces: Workspaces
  agents: AgentManager
  crew: CrewStore
  runs: RunStore
  projects: ProjectStore
  engine: PipelineEngine
  tickets: TicketStore
  /** Stops every service Eregion started. Called when the app quits. */
  shutdown(): Promise<void>
}

export function testRunKey(projectId: number): string {
  return `test:${projectId}`
}

export function createApi(db: Db, host: Host, options: BackendOptions = {}): EregionApi {
  return createBackend(db, host, options).api
}

export function createBackend(db: Db, host: Host, options: BackendOptions = {}): Backend {
  const projects = new ProjectStore(db)
  const services = new ServiceManager()
  const runs = new RunStore(db)
  runs.closeAbandoned()
  const crew = new CrewStore(db)
  const agents = new AgentManager(runs, (notice) => host.emit(notice), options.agentCommand)
  const workspaces = new Workspaces(projects, services, (environment) => host.emit({ type: 'environment', environment }), undefined, options.workspaceRoot)
  const changed = (projectId: number): void => {
    host.emit({ type: 'project-changed', projectId })
    host.emit({ type: 'projects-changed' })
  }

  const tickets = new TicketStore(db)
  const pipelines = new PipelineStore(db)
  const ticketChanged = (ticket: Ticket): void => {
    host.emit({ type: 'ticket-changed', ticketId: ticket.id, projectId: ticket.projectId })
    host.emit({ type: 'projects-changed' })
  }
  const engine = new PipelineEngine({
    projects,
    tickets,
    pipelines,
    crew,
    agents,
    workspaces,
    settings: {
      userName: () => getSetting(db, 'user.name', host.userName ?? 'you'),
      houseRules: () => getSetting(db, 'rules.house', '')
    },
    integrations: { notify: (title, body) => host.notify?.(title, body) },
    onTicketChanged: ticketChanged
  })
  engine.recover()
  const ticketsApi = createTicketsApi({ db, projects, tickets, pipelines, crew, runs, agents, workspaces, engine, onBackgroundError: backgroundErrorHandler(tickets, ticketChanged, agents) })

  const usedSlots = (projectId: number): number[] => {
    const rows = db.prepare('SELECT slot FROM tickets WHERE project_id = ? AND slot IS NOT NULL').all(projectId) as { slot: number }[]
    return [...rows.map((row) => row.slot), ...workspaces.liveSlots(projectId)]
  }

  const testTicket = (projectId: number, slot: number): WorkspaceTicket => {
    const project = projects.get(projectId)
    return { key: 'TEST-1', title: 'Test run', slot, branch: 'eregion/test-run', affectedRepoIds: project.repos.map((repo) => repo.id) }
  }

  const api: EregionApi = {
    appInfo: async () => ({ version: host.appVersion, platform: process.platform, databasePath: host.databasePath }),
    checkTools: async () => {
      const checks = await checkTools()
      // First run: create the default crew on whichever agent is installed (Claude Code if both are).
      if (crew.list().length === 0) {
        const found = (tool: string): boolean => checks.some((check) => check.tool === tool && check.found)
        if (found('claude') || found('cursor-agent')) {
          crew.ensureDefaults(found('claude') ? 'claude-code' : 'cursor')
          host.emit({ type: 'crew-changed' })
        }
      }
      return checks
    },

    listProjects: async () => projects.list(),
    getProject: async (id) => projects.get(id),
    createProject: async (name) => {
      const project = projects.create(name)
      changed(project.id)
      return project
    },
    updateProject: async (id, patch) => {
      const project = projects.update(id, patch)
      changed(id)
      return project
    },
    deleteProject: async (id) => {
      projects.delete(id)
      host.emit({ type: 'projects-changed' })
    },
    exportProject: async (id) => {
      const file = projects.export(id)
      const path = await host.pickSaveFile(`${file.project.name.replace(/[^\w-]+/g, '-').toLowerCase()}.eregion.json`)
      if (!path) return null
      await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
      return path
    },
    importProject: async () => {
      const path = await host.pickOpenFile()
      if (!path) return null
      const project = projects.import(JSON.parse(await readFile(path, 'utf8')) as ProjectFile)
      changed(project.id)
      return project
    },

    pickFolder: () => host.pickFolder(),
    detectRepo: (hostPath) => detectRepo(hostPath),
    suggestRecipe: async (repoId) => {
      const repo = projects.repo(repoId)
      return detectRepoAt(repo.runtime, repo.path)
    },
    addRepo: async (projectId, input) => {
      const repo = projects.addRepo(projectId, input)
      changed(projectId)
      return repo
    },
    updateRepo: async (id, patch) => {
      const repo = projects.updateRepo(id, patch)
      changed(repo.projectId)
      return repo
    },
    removeRepo: async (id) => {
      const repo = projects.repo(id)
      projects.removeRepo(id)
      changed(repo.projectId)
    },
    reorderRepos: async (projectId, repoIds) => {
      const repos = projects.reorderRepos(projectId, repoIds)
      changed(projectId)
      return repos
    },

    getRecipe: async (projectId) =>
      projects.repos(projectId).map((repo) => ({
        repo,
        setup: projects.steps(repo.id, 'setup'),
        teardown: projects.steps(repo.id, 'teardown'),
        services: projects.services(repo.id)
      })),
    saveSteps: async (repoId, phase, steps) => {
      const saved = projects.saveSteps(repoId, phase, steps)
      changed(projects.repo(repoId).projectId)
      return saved
    },
    saveServices: async (repoId, services) => {
      const saved = projects.saveServices(repoId, services)
      changed(projects.repo(repoId).projectId)
      return saved
    },
    previewVariables: async (projectId, variables?: Variable[]) => {
      const project = projects.get(projectId)
      const sample = sampleTicket(project.linear.teamKey ?? project.initials)
      const resolved = resolveVariables(variables ?? project.variables, ticketBuiltins(sample))
      return { sample, ...resolved }
    },

    startTestRun: async (projectId) => {
      const key = testRunKey(projectId)
      const existing = workspaces.get(key)
      if (existing && existing.phase !== 'torn-down') {
        throw new Error('A test run is already going. Tear it down first.')
      }
      const project = projects.get(projectId)
      if (project.repos.length === 0) throw new Error('Add a repo first')
      const slot = nextFreeSlot(usedSlots(projectId), project.liveSlots)
      if (slot === null) throw new Error(`All ${project.liveSlots} live slots are in use. Free one, or raise the cap in Variables.`)
      // Runs in the background; progress arrives as environment events.
      void workspaces.create(key, project, testTicket(projectId, slot)).catch((error: Error) => {
        host.emit({ type: 'environment', environment: { ...(workspaces.get(key) as Environment), phase: 'failed', error: error.message } })
      })
      await new Promise((resolve) => setImmediate(resolve))
      return workspaces.get(key) as Environment
    },
    tearDownTestRun: async (projectId) => {
      const key = testRunKey(projectId)
      const environment = workspaces.get(key)
      if (!environment) return null
      return workspaces.teardown(key, projects.get(projectId), testTicket(projectId, environment.slot), { deleteBranch: true })
    },
    getEnvironment: async (key) => workspaces.get(key) ?? null,
    finishSetup: async (projectId) => {
      const project = projects.update(projectId, { setupStep: 8 })
      changed(projectId)
      return project
    },

    ...ticketsApi,
    getSetting: async (key, fallback) => getSetting(db, key, fallback),
    setSetting: async (key, value) => setSetting(db, key, value),

    listCrew: async () => crew.list(),
    getRun: async (runId) => agents.view(runId),
    sendToRun: async (runId, text, delivery, dictated) => agents.send(runId, text, delivery, dictated),
    stopRun: (runId) => agents.stop(runId),

    openExternal: (url) => host.openExternal(url)
  }

  return {
    api,
    workspaces,
    agents,
    crew,
    runs,
    projects,
    engine,
    tickets,
    shutdown: async () => {
      await agents.stopAll()
      await services.stopAll()
    }
  }
}
