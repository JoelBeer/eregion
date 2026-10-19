import type { Project, ProjectSummary, Repo, Service, Step, StepPhase, Variable } from './model'
import type { AgentEvent } from './agent'
import type { Environment } from './environment'
import type { CrewMember, RunView } from './runs'
import type { StageConfig } from './pipeline'
import type { RepoDiff, TicketDetail, TicketOutputs } from './ticketDetail'
import type { Ticket, TicketCard } from './tickets'
import type { AppInfo, ToolCheck } from './types'

export interface RepoInput {
  name: string
  path: string
  runtime: string
  defaultBranch: string
  githubRepo?: string | null
}

export type StepInput = Pick<Step, 'config' | 'options'>
export type ServiceInput = Pick<Service, 'name' | 'command' | 'readyCheck' | 'openUrl'>

export interface DetectedFact {
  label: string
  value: string
  source: string
}

export interface RepoDetection {
  path: string
  runtime: string
  name: string
  defaultBranch: string | null
  githubRepo: string | null
  facts: DetectedFact[]
  recipe: { variables: Variable[]; setup: StepInput[]; teardown: StepInput[]; services: ServiceInput[] }
  warnings: string[]
}

export interface RepoRecipe {
  repo: Repo
  setup: Step[]
  teardown: Step[]
  services: Service[]
}

export interface VariablePreview {
  sample: { key: string; title: string; slot: number; branch: string }
  values: Record<string, string>
  errors: Record<string, string>
}

export interface ProjectPatch {
  name?: string
  initials?: string
  color?: string
  variables?: Variable[]
  liveSlots?: number
  setupStep?: number
  setupInParallel?: boolean
}

/** Everything the renderer can ask the main process to do. Each method is one IPC round trip. */
export interface EregionApi {
  appInfo(): Promise<AppInfo>
  checkTools(): Promise<ToolCheck[]>

  listProjects(): Promise<ProjectSummary[]>
  getProject(id: number): Promise<Project>
  createProject(name: string): Promise<Project>
  updateProject(id: number, patch: ProjectPatch): Promise<Project>
  deleteProject(id: number): Promise<void>
  exportProject(id: number): Promise<string | null>
  importProject(): Promise<Project | null>

  pickFolder(): Promise<string | null>
  detectRepo(hostPath: string): Promise<RepoDetection>
  suggestRecipe(repoId: number): Promise<RepoDetection>
  addRepo(projectId: number, input: RepoInput): Promise<Repo>
  updateRepo(id: number, patch: Partial<RepoInput>): Promise<Repo>
  removeRepo(id: number): Promise<void>
  reorderRepos(projectId: number, repoIds: number[]): Promise<Repo[]>

  getRecipe(projectId: number): Promise<RepoRecipe[]>
  saveSteps(repoId: number, phase: StepPhase, steps: StepInput[]): Promise<Step[]>
  saveServices(repoId: number, services: ServiceInput[]): Promise<Service[]>
  previewVariables(projectId: number, variables?: Variable[]): Promise<VariablePreview>

  startTestRun(projectId: number): Promise<Environment>
  tearDownTestRun(projectId: number): Promise<Environment | null>
  getEnvironment(key: string): Promise<Environment | null>
  finishSetup(projectId: number): Promise<Project>

  listTickets(projectId: number): Promise<TicketCard[]>
  getTicket(ticketId: number): Promise<TicketDetail>
  getTicketOutputs(ticketId: number): Promise<TicketOutputs>
  getTicketDiff(ticketId: number): Promise<RepoDiff[]>
  createTicket(projectId: number, title: string, description: string): Promise<Ticket>
  startTicket(ticketId: number): Promise<void>
  approvePlan(ticketId: number): Promise<void>
  approveReview(ticketId: number): Promise<void>
  approveStage(ticketId: number): Promise<void>
  sendBackToBuild(ticketId: number, note: string): Promise<void>
  backToPlan(ticketId: number, note: string): Promise<void>
  retryTicket(ticketId: number, note?: string): Promise<void>
  allowOneMoreLoop(ticketId: number): Promise<void>
  releaseSlot(ticketId: number): Promise<void>
  stopTicketRun(ticketId: number): Promise<void>
  discardTicket(ticketId: number): Promise<void>
  startServices(ticketId: number): Promise<void>
  stopServices(ticketId: number): Promise<void>
  openInEditor(ticketId: number, repoName: string): Promise<void>

  getPipeline(projectId: number): Promise<{ version: number; stages: StageConfig[]; olderVersions: { version: number; tickets: number }[] }>
  savePipeline(projectId: number, stages: StageConfig[]): Promise<number>

  getSetting<T>(key: string, fallback: T): Promise<T>
  setSetting(key: string, value: unknown): Promise<void>

  listCrew(): Promise<CrewMember[]>
  getRun(runId: number): Promise<RunView>
  sendToRun(runId: number, text: string, delivery: 'now' | 'queue', dictated: boolean): Promise<'delivered' | 'queued'>
  stopRun(runId: number): Promise<void>

  openExternal(url: string): Promise<void>
}

/** The method names, so the preload script can expose each one explicitly. */
export const API_METHODS = [
  'appInfo',
  'checkTools',
  'listProjects',
  'getProject',
  'createProject',
  'updateProject',
  'deleteProject',
  'exportProject',
  'importProject',
  'pickFolder',
  'detectRepo',
  'suggestRecipe',
  'addRepo',
  'updateRepo',
  'removeRepo',
  'reorderRepos',
  'getRecipe',
  'saveSteps',
  'saveServices',
  'previewVariables',
  'startTestRun',
  'tearDownTestRun',
  'getEnvironment',
  'finishSetup',
  'listTickets',
  'getTicket',
  'getTicketOutputs',
  'getTicketDiff',
  'createTicket',
  'startTicket',
  'approvePlan',
  'approveReview',
  'approveStage',
  'sendBackToBuild',
  'backToPlan',
  'retryTicket',
  'allowOneMoreLoop',
  'releaseSlot',
  'stopTicketRun',
  'discardTicket',
  'startServices',
  'stopServices',
  'openInEditor',
  'getPipeline',
  'savePipeline',
  'getSetting',
  'setSetting',
  'listCrew',
  'getRun',
  'sendToRun',
  'stopRun',
  'openExternal'
] as const satisfies readonly (keyof EregionApi)[]

/** Pushed from the main process when something changes that screens should refresh for. */
export type EregionEvent = { type: 'projects-changed' } | { type: 'project-changed'; projectId: number } | { type: 'environment'; environment: Environment }
  | { type: 'run-event'; runId: number; event: AgentEvent }
  | { type: 'run-state'; runId: number; state: RunView['state']; queued: number }
  | { type: 'crew-changed' }
  | { type: 'ticket-changed'; ticketId: number; projectId: number }

export interface EregionBridge extends EregionApi {
  onEvent(listener: (event: EregionEvent) => void): () => void
}
