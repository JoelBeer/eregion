import type { Project, ProjectSummary, Repo, Service, Step, StepPhase, Variable } from './model'
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
  'openExternal'
] as const satisfies readonly (keyof EregionApi)[]

/** Pushed from the main process when something changes that screens should refresh for. */
export type EregionEvent = { type: 'projects-changed' } | { type: 'project-changed'; projectId: number }

export interface EregionBridge extends EregionApi {
  onEvent(listener: (event: EregionEvent) => void): () => void
}
