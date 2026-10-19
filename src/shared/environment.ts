/** Live state of one ticket environment (or a project's test run), pushed to screens as it changes. */

export type EnvironmentPhase = 'setting-up' | 'ready' | 'failed' | 'tearing-down' | 'torn-down' | 'teardown-failed'

export type EnvironmentStepStatus = 'running' | 'done' | 'skipped' | 'failed' | 'failed-continued'

export interface EnvironmentStep {
  label: string
  status: EnvironmentStepStatus
  output: string
  durationMs?: number
}

export interface EnvironmentRepo {
  repoId: number
  name: string
  /** The worktree, inside the repo's runtime. */
  path: string
  /** The ticket branch, or null when the repo is detached at the base branch (read-only for this ticket). */
  branch: string | null
  steps: EnvironmentStep[]
  teardown: EnvironmentStep[]
}

export type ServiceState = 'starting' | 'ready' | 'failed' | 'stopped'

export interface EnvironmentService {
  repoName: string
  name: string
  state: ServiceState
  openUrl: string | null
  log: string[]
}

export interface Environment {
  /** `ticket:<id>` for a ticket, `test:<projectId>` for a project's test run. */
  key: string
  projectId: number
  ticketKey: string
  slot: number
  phase: EnvironmentPhase
  error: string | null
  /** Resolved project variables for this ticket, e.g. app_port = 8101. */
  values: Record<string, string>
  repos: EnvironmentRepo[]
  services: EnvironmentService[]
}

export function serviceKey(environmentKey: string, repoName: string, serviceName: string): string {
  return `${environmentKey}|${repoName}|${serviceName}`
}
