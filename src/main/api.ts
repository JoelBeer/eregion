import { readFile, writeFile } from 'node:fs/promises'
import type { EregionApi, EregionEvent, VariablePreview } from '@shared/api'
import type { Environment } from '@shared/environment'
import { branchName, type Project, type ProjectFile, type Variable } from '@shared/model'
import { nextFreeSlot } from '@shared/slots'
import { resolveVariables } from '@shared/variables'
import type { Db } from './db'
import { detectRepo, detectRepoAt, runnerForRuntimeId } from './projects/detect'
import { ProjectStore } from './projects/store'
import { ticketBuiltins } from './recipe/context'
import { ServiceManager } from './recipe/services'
import { checkTools } from './tools'
import { Workspaces, type WorkspaceTicket } from './workspace/workspaces'
import { CrewStore, crewStats } from './agents/crew'
import { AgentManager } from './agents/manager'
import { RunStore } from './agents/runs'
import type { CrewMember } from '@shared/runs'
import type { Ticket } from '@shared/tickets'
import { getSetting, setSetting } from './db'
import { PipelineEngine } from './pipeline/engine'
import { PipelineStore, TicketStore } from './pipeline/stores'
import { backgroundErrorHandler, createTicketsApi } from './ticketsApi'
import { GhCli, readGitHubAccount, type GitHub } from './integrations/github'
import { availableRuntimes, runnerFor, runtimeLabel } from './runner'
import type { RunnerFor } from './runner/types'
import { GitHubAccounts } from './integrations/githubAccounts'
import { Editors } from './editors'
import { LinearClient, type FetchLike } from './integrations/linear'
import { LinearAuth, PLAIN_CODEC, type SecretCodec } from './integrations/linearAuth'
import { Connections } from './integrations/connections'
import { GitHubIssuesSource } from './integrations/githubIssues'
import { CodeHosts, GitLabHost, GitLabIssuesSource, gitlabWhoAmI } from './integrations/gitlab'
import { JiraClient, JiraSource } from './integrations/jira'
import { LinearSource } from './integrations/linearSource'
import { IssueSync, sourceIntegrations } from './integrations/sources'
import { createIntegrationsApi } from './integrationsApi'
import { CiWatcher } from './pipeline/ciWatch'
import { PrStage } from './pipeline/prStage'
import { PrStore } from './pipeline/prs'
import { validatePipeline } from '@shared/pipeline'
import { costReport, usageSummary } from './costs'
import { CursorCosts, parseCursorEmail } from './integrations/cursorCosts'
import { combineRules } from '@shared/rules'
import { AgentsInfo } from './agentsInfo'
import { RulesStore } from './rules'
import { Tooling } from './tooling'
import { Forge } from './forge'
import { ticketContext } from './ticketContext'
import { commitRules } from './workspace/commitRules'

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
  /** Encrypts secrets such as Linear tokens at rest. Without it they're stored as plain text. */
  secrets?: SecretCodec
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
  /** Replaces gh, for tests. */
  github?: GitHub
  /** Replaces fetch for Linear's API, for tests. */
  fetch?: FetchLike
  /** Starts the Linear sync and Watch CI timers. The app does; tests don't. */
  timers?: boolean
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
  prs: PrStore
  prStage: PrStage
  ci: CiWatcher
  /** Brings issues in from each project's tracker. */
  issueSync: IssueSync
  linearAuth: LinearAuth
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
  const agents = new AgentManager(runs, (notice) => host.emit(notice), options.agentCommand, (id) => agentsInfo.connector(id))
  // The GitHub accounts gh is signed in to (Settings › Accounts). A project can act as one of them; otherwise as gh's active account.
  const githubAccounts = new GitHubAccounts(() => runnerFor(availableRuntimes()[0]), () => host.emit({ type: 'github-changed' }))
  const projectRunnerFor: RunnerFor = (runtime, project) => githubAccounts.forProject(runnerForRuntimeId(runtime), project?.github?.account)
  const workspaces = new Workspaces(projects, services, (environment) => host.emit({ type: 'environment', environment }), projectRunnerFor, options.workspaceRoot)
  const changed = (projectId: number): void => {
    host.emit({ type: 'project-changed', projectId })
    host.emit({ type: 'projects-changed' })
  }

  const tickets = new TicketStore(db)
  const pipelines = new PipelineStore(db)
  // A desktop notification, plus a notice for the window (the needs-you chime).
  const notify = (title: string, body: string): void => {
    host.notify?.(title, body)
    host.emit({ type: 'notice', title, body })
  }
  const linearAuth = new LinearAuth(db, host.secrets ?? PLAIN_CODEC, options.fetch)
  const fetchImpl = options.fetch ?? (fetch as unknown as FetchLike)
  // What Cursor charged for each Cursor run, from the team's Admin API; only the CLI's own account counts.
  const cursorCosts = new CursorCosts(
    db,
    host.secrets ?? PLAIN_CODEC,
    async () => {
      const runner = runnerFor(availableRuntimes()[0])
      const result = await runner.exec(runner.shell('cursor-agent status'), { timeoutMs: 20_000 })
      return parseCursorEmail(`${result.stdout}\n${result.stderr}`)
    },
    fetchImpl
  )
  // Jira and GitLab accounts (Settings › Accounts); a test says who each signs in as.
  const connections = new Connections(db, host.secrets ?? PLAIN_CODEC, {
    jira: async (connection, token) => (await new JiraClient(connection, token, fetchImpl).myself()).displayName,
    gitlab: (connection, token) => gitlabWhoAmI(connection, token, fetchImpl),
    linear: async (_connection, token) => {
      const viewer = await new LinearClient({ kind: 'api-key', key: token }, fetchImpl).viewer()
      return `${viewer.name} (${viewer.organization})`
    }
  })
  const linearSource = new LinearSource(linearAuth, connections, fetchImpl)
  const ticketSources = [linearSource, new GitHubIssuesSource(projectRunnerFor), new JiraSource(connections, fetchImpl), new GitLabIssuesSource(connections, fetchImpl)]
  const issueSync = new IssueSync(db, ticketSources, projects, tickets, {
    ticketChanged: (ticket) => ticketChanged(ticket),
    ticketRemoved: (projectId) => {
      host.emit({ type: 'project-changed', projectId })
      host.emit({ type: 'projects-changed' })
    },
    notify,
    statusChanged: () => host.emit({ type: 'linear-changed' })
  })
  const tooling = new Tooling(db, projects)
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
      houseRules: (project) => combineRules(getSetting(db, 'rules.house', ''), getSetting(db, `rules.project.${project.id}`, ''), project.name)
    },
    integrations: sourceIntegrations(issueSync, notify),
    onTicketChanged: ticketChanged,
    tooling: (project, repoPaths, values) => tooling.forRun(project, repoPaths, values),
    runnerFor: projectRunnerFor
  })
  const prs = new PrStore(db)
  const agentsInfo = new AgentsInfo(db, projects)
  // GitHub through gh, or GitLab for repos on one of your GitLab connections.
  const github = options.github ?? new CodeHosts(new GhCli(), new GitLabHost(connections, fetchImpl))
  const rules = new RulesStore(db, projects, github)
  const houseRules = (project: Project): string => combineRules(getSetting(db, 'rules.house', ''), getSetting(db, `rules.project.${project.id}`, ''), project.name)
  const forge = new Forge({
    db,
    projects,
    crew,
    runs,
    agents,
    workspaces,
    userName: () => getSetting(db, 'user.name', host.userName ?? 'you'),
    houseRules,
    tooling: (project, repoPaths) => tooling.forRun(project, repoPaths, {}),
    changed: (projectId) => host.emit({ type: 'forge-changed', projectId }),
    ticketContext: (ticketId, folder) => ticketContext({ engine, tickets, workspaces, prs }, ticketId, folder)
  })
  const prStage = new PrStage(engine, prs, github)
  const ci = new CiWatcher(engine, prs, github)
  engine.recover()
  void prStage.moveWaitingDraftsOn().catch(() => undefined)
  if (options.timers) {
    ci.start()
    issueSync.start()
    cursorCosts.start()
  }
  const ticketsApi = createTicketsApi({
    db,
    editors: new Editors(db),
    machineRunner: () => runnerFor(availableRuntimes()[0]),
    projects,
    tickets,
    pipelines,
    crew,
    runs,
    agents,
    workspaces,
    engine,
    prs,
    onBackgroundError: backgroundErrorHandler(tickets, ticketChanged, agents)
  })
  const integrationsApi = createIntegrationsApi({
    auth: linearAuth,
    sync: issueSync,
    projects,
    tickets,
    prs,
    prStage,
    ci,
    openExternal: (url) => host.openExternal(url),
    linearChanged: () => host.emit({ type: 'linear-changed' }),
    ticketChanged,
    linearConnection: (connectionId) => new LinearClient({ kind: 'api-key', key: connections.token(connectionId) }, fetchImpl),
    createLocalTicket: ticketsApi.createTicket
  })

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
        if (found('claude') || found('cursor-agent') || found('codex')) {
          crew.ensureDefaults(found('claude') ? 'claude-code' : found('codex') ? 'codex' : 'cursor')
          host.emit({ type: 'crew-changed' })
        }
      }
      return checks
    },

    listGitHubAccounts: () => githubAccounts.list(),
    startGitHubSignIn: () => githubAccounts.startSignIn(),
    finishGitHubSignIn: () => githubAccounts.finishSignIn(),
    cancelGitHubSignIn: async () => githubAccounts.cancelSignIn(),
    signOutOfGitHub: (login) => githubAccounts.signOut(login),
    getGitHubAccount: async (login) => {
      // gh's active account in the first runtime where it's signed in (on a Mac or inside WSL there's only one), or the account asked for.
      for (const runtime of availableRuntimes()) {
        const account = await readGitHubAccount(githubAccounts.forProject(runnerFor(runtime), login))
        if (!account) continue
        const usedBy = new Map<string, string[]>()
        for (const summary of projects.list()) {
          for (const repo of projects.get(summary.id).repos) {
            if (repo.githubRepo) usedBy.set(repo.githubRepo.toLowerCase(), [...(usedBy.get(repo.githubRepo.toLowerCase()) ?? []), summary.name])
          }
        }
        return { ...account, runtime: runtimeLabel(runtime), repos: account.repos.map((repo) => ({ ...repo, projects: usedBy.get(repo.name.toLowerCase()) ?? [] })) }
      }
      return null
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
      const file: ProjectFile = { ...projects.export(id), pipeline: pipelines.latest(id).stages.map((stage) => ({ ...stage, crewId: null })) }
      const path = await host.pickSaveFile(`${file.project.name.replace(/[^\w-]+/g, '-').toLowerCase()}.eregion.json`)
      if (!path) return null
      await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
      return path
    },
    importProject: async () => {
      const path = await host.pickOpenFile()
      if (!path) return null
      const file = JSON.parse(await readFile(path, 'utf8')) as ProjectFile
      // Checked before anything is made, so a broken pipeline doesn't leave half a project behind.
      const stages = file.pipeline?.map((stage) => ({ ...stage, crewId: null }))
      const problems = stages ? validatePipeline(stages) : []
      if (problems.length > 0) throw new Error(`The pipeline in that file isn't valid: ${problems.join('. ')}`)
      const project = projects.import(file)
      if (stages) pipelines.save(project.id, stages)
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
    getCommitRules: async (repoId) => {
      const repo = projects.repo(repoId)
      return commitRules(runnerForRuntimeId(repo.runtime), repo)
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
    crewStats: async () => crewStats(db),
    createCrew: async (member) => {
      if (crew.list().some((item) => item.name.toLowerCase() === member.name.trim().toLowerCase())) throw new Error(`There's already a crew member called ${member.name.trim()}`)
      const created = crew.create(member)
      host.emit({ type: 'crew-changed' })
      return created
    },
    updateCrew: async (id, patch) => {
      const updated = crew.update(id, patch)
      host.emit({ type: 'crew-changed' })
      return updated
    },
    deleteCrew: async (id) => {
      if (crew.list().length <= 1) throw new Error('Keep at least one crew member')
      crew.delete(id)
      host.emit({ type: 'crew-changed' })
    },
    getRun: async (runId) => agents.view(runId),
    sendToRun: async (runId, text, delivery, dictated) => agents.send(runId, text, delivery, dictated),
    stopRun: (runId) => agents.stop(runId),

    openExternal: (url) => host.openExternal(url),
    getCosts: async (projectId, period, listing) => costReport(db, projectId, period, listing, { cursorCosts: cursorCosts.configured() }),
    getCursorCosts: async () => cursorCosts.status(),
    saveCursorAdminKey: (key) => cursorCosts.saveKey(key),
    removeCursorAdminKey: async () => cursorCosts.removeKey(),
    syncCursorCosts: async () => {
      await cursorCosts.sync()
      return cursorCosts.status()
    },
    getUsage: async (projectId) => usageSummary(db, projectId),
    listAgents: () => agentsInfo.list(),
    listConnectors: async () => agentsInfo.connectors(),
    listConnections: async () => connections.list(),
    saveConnection: async (input) => {
      const saved = await connections.save(input)
      host.emit({ type: 'linear-changed' })
      return saved
    },
    removeConnection: async (id) => {
      connections.remove(id)
      host.emit({ type: 'linear-changed' })
    },
    testConnection: async (id) => connections.test(id),
    listJiraStatuses: async (connectionId, projectKey) => new JiraClient(connections.get(connectionId), connections.token(connectionId), fetchImpl).statuses(projectKey),
    saveCustomAgent: async (agent) => agentsInfo.saveCustom(agent),
    removeCustomAgent: async (id) => agentsInfo.removeCustom(id),
    testAgent: (adapter) => agentsInfo.test(adapter),
    listModels: async (adapter) => agentsInfo.models(adapter),
    addModel: async (adapter, id) => agentsInfo.addModel(adapter, id),
    removeModel: async (adapter, id) => agentsInfo.removeModel(adapter, id),
    listRules: () => rules.list(),
    saveRule: (id, content) => rules.save(id, content),
    proposeRuleChange: (id, content, syncAgents) => rules.proposeChange(id, content, { syncAgents }),
    listSkills: async () => ({ skills: await tooling.skills(), defaultForNew: tooling.skillDefault() }),
    setSkillAllowed: async (name, allowed) => tooling.setSkillAllowed(name, allowed),
    setSkillDefault: async (value) => tooling.setSkillDefault(value),
    markSkillsSeen: async (names) => tooling.markSkillsSeen(names),
    listMcpServers: () => tooling.servers(),
    setMcpServerAllowed: async (key, allowed) => tooling.setServerAllowed(key, allowed),
    addMcpServer: async (name, spec) => tooling.addServer(name, spec),
    removeMcpServer: async (name) => tooling.removeServer(name),
    listChats: async (projectId) => forge.list(projectId),
    createChat: async (projectId, chat) => forge.create(projectId, chat),
    updateChat: async (chatId, patch) => forge.update(chatId, patch),
    deleteChat: (chatId) => forge.remove(chatId),
    sendToChat: (chatId, text, dictated) => forge.send(chatId, text, dictated),
    sendTicketToForge: async (ticketId, runId) => {
      const ticket = tickets.get(ticketId)
      // The crew member of the run you're looking at, or of the stage the ticket is in.
      const run = runId !== null ? runs.get(runId) : null
      const stages = engine.stages(ticket)
      const stage = stages.find((item) => item.id === (run?.ticketId === ticketId ? run.stage : ticket.stage)) ?? stages.find((item) => item.id === ticket.stage) ?? stages[0]
      const ran = run?.ticketId === ticketId && run.crewId !== null ? crew.list().find((item) => item.id === run.crewId) : undefined
      const member = ran ?? engine.crewFor(stage)
      return forge.createForTicket(ticket.projectId, ticket, { crewId: member.id, adapter: member.adapter, model: member.model })
    },

    // After the tickets API: in a project linked to Linear, createTicket makes a Linear issue.
    ...integrationsApi
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
    prs,
    prStage,
    ci,
    issueSync,
    linearAuth,
    shutdown: async () => {
      ci.stop()
      issueSync.stop()
      cursorCosts.stop()
      linearAuth.cancelSignIn()
      await agents.stopAll()
      await services.stopAll()
    }
  }
}
