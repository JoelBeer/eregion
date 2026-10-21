import type { Environment, EnvironmentRepo, EnvironmentStep } from '@shared/environment'
import { serviceKey } from '@shared/environment'
import type { Project, Repo } from '@shared/model'
import { FILTERS } from '@shared/template'
import { runnerForRuntimeId } from '../projects/detect'
import type { ProjectStore } from '../projects/store'
import { recipeContext, type TicketValues } from '../recipe/context'
import type { RunningService, ServiceManager } from '../recipe/services'
import { runSteps, type StepResult } from '../recipe/steps'
import type { Runner } from '../runner'
import type { RunnerFor } from '../runner/types'
import { baseRef, branchExists, ensureWorktree, gitIn, removeWorktree, updateFromBase as bringInBase } from './git'

export interface WorkspaceTicket extends TicketValues {
  /** Repos the plan changes. They get the ticket branch; the rest stay detached at the base branch. */
  affectedRepoIds: number[]
}

export interface WorkspaceOptions {
  /** Called for every log line worth keeping with the ticket. */
  log?: (kind: string, message: string) => void
  /** Delete the ticket branch at teardown (used by the test run). */
  deleteBranch?: boolean
}

function stepFrom(result: Partial<StepResult> & { label: string }): EnvironmentStep {
  return { label: result.label, status: result.status ?? 'running', output: result.output ?? '', durationMs: result.durationMs }
}

/**
 * Creates and removes ticket environments: one git worktree per repo, the recipe's setup steps,
 * its services, and teardown. Everything lives under ~/.eregion/<project>/ inside each repo's own
 * runtime, so WSL repos keep their worktrees inside WSL.
 */
export class Workspaces {
  private readonly environments = new Map<string, Environment>()
  private readonly homes = new Map<string, Promise<string>>()
  private readonly repoLocks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly projects: ProjectStore,
    private readonly services: ServiceManager,
    private readonly onChange: (environment: Environment) => void,
    private readonly runnerFor: RunnerFor = runnerForRuntimeId,
    /** Overrides $HOME/.eregion, for tests. */
    private readonly rootOverride?: string
  ) {}

  get(key: string): Environment | undefined {
    return this.environments.get(key)
  }

  list(projectId?: number): Environment[] {
    return [...this.environments.values()].filter((environment) => projectId === undefined || environment.projectId === projectId)
  }

  /** Slots taken by live environments of a project that aren't recorded on tickets (the test run). */
  liveSlots(projectId: number): number[] {
    return this.list(projectId)
      .filter((environment) => environment.phase !== 'torn-down')
      .map((environment) => environment.slot)
  }

  private async root(runner: Runner, runtime: string): Promise<string> {
    if (this.rootOverride) return this.rootOverride
    if (!this.homes.has(runtime)) {
      this.homes.set(
        runtime,
        runner.exec(['sh', '-c', 'printf %s "$HOME"']).then((result) => {
          if (result.code !== 0 || !result.stdout) throw new Error(`Couldn't find the home folder in ${runtime}`)
          return runner.join(result.stdout, '.eregion')
        })
      )
    }
    return this.homes.get(runtime) as Promise<string>
  }

  private projectFolder(project: Project): string {
    return FILTERS.slug(project.name) || `project-${project.id}`
  }

  async ticketFolder(project: Project, repo: Repo, ticketKey: string): Promise<string> {
    const runner = this.runnerFor(repo.runtime)
    return runner.join(await this.root(runner, repo.runtime), this.projectFolder(project), 'work', ticketKey)
  }

  async worktreePath(project: Project, repo: Repo, ticketKey: string): Promise<string> {
    return this.runnerFor(repo.runtime).join(await this.ticketFolder(project, repo, ticketKey), repo.name)
  }

  /** Where a ticket's stage outputs (plan.md, review.json…) live: next to the first repo's worktrees. */
  async outputsFolder(project: Project, ticketKey: string): Promise<string> {
    const repo = project.repos[0]
    if (!repo) throw new Error('This project has no repos')
    const runner = this.runnerFor(repo.runtime)
    return runner.join(await this.root(runner, repo.runtime), this.projectFolder(project), 'tickets', ticketKey)
  }

  async planFolder(project: Project): Promise<string> {
    const repo = project.repos[0]
    if (!repo) throw new Error('This project has no repos')
    const runner = this.runnerFor(repo.runtime)
    return runner.join(await this.root(runner, repo.runtime), this.projectFolder(project), 'plan')
  }

  /** Where Forge chats run: an empty folder, so a chat reads only the repos you attach. */
  async forgeFolder(project: Project): Promise<string> {
    const repo = project.repos[0]
    if (!repo) throw new Error('This project has no repos')
    const runner = this.runnerFor(repo.runtime)
    const folder = runner.join(await this.root(runner, repo.runtime), this.projectFolder(project), 'forge')
    await runner.exec(['mkdir', '-p', folder])
    return folder
  }

  /** One git operation per repo at a time: worktree commands take a lock on the repo. */
  private withRepoLock<T>(repo: Repo, task: () => Promise<T>): Promise<T> {
    const previous = this.repoLocks.get(repo.path) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.repoLocks.set(
      repo.path,
      next.catch(() => undefined)
    )
    return next
  }

  /**
   * Brings the shared plan checkout up to date: every repo detached at the latest base branch,
   * with local changes thrown away. Planning reads it; nothing is ever committed there.
   */
  async refreshPlanCheckout(project: Project): Promise<{ path: string; repos: { name: string; path: string; base: string }[] }> {
    const folder = await this.planFolder(project)
    const repos = []
    for (const repo of project.repos) {
      const runner = this.runnerFor(repo.runtime, project)
      const path = runner.join(folder, repo.name)
      const base = await this.withRepoLock(repo, async () => {
        const { ref } = await baseRef(runner, repo.path, repo.defaultBranch)
        await ensureWorktree(runner, repo.path, path, ref, null)
        await gitIn(runner, path, ['checkout', '--detach', '--force', ref])
        await gitIn(runner, path, ['clean', '-fdq'])
        return ref
      })
      repos.push({ name: repo.name, path, base })
    }
    return { path: folder, repos }
  }

  private update(environment: Environment, patch: Partial<Environment> = {}): void {
    Object.assign(environment, patch)
    this.onChange({ ...environment, repos: environment.repos.map((repo) => ({ ...repo })), services: [...environment.services] })
  }

  private serviceSnapshot(environment: Environment): void {
    environment.services = this.services.list(`${environment.key}|`).map((service: RunningService) => {
      const [, repoName, name] = service.key.split('|')
      return { repoName, name, state: service.state, openUrl: service.openUrl, log: service.log.slice(-40) }
    })
  }

  /**
   * Creates the ticket's worktrees, runs setup and starts services. Resolves when the environment
   * is ready or has failed; progress is reported through onChange as it happens.
   */
  async create(key: string, project: Project, ticket: WorkspaceTicket, options: WorkspaceOptions = {}): Promise<Environment> {
    const context = recipeContext(project.variables, ticket)
    const variableErrors = Object.entries(context.variables.errors)
    const environment: Environment = {
      key,
      projectId: project.id,
      ticketKey: ticket.key,
      slot: ticket.slot,
      phase: 'setting-up',
      error: null,
      values: context.variables.values,
      repos: await Promise.all(
        project.repos.map(async (repo) => ({
          repoId: repo.id,
          name: repo.name,
          path: await this.worktreePath(project, repo, ticket.key),
          branch: ticket.affectedRepoIds.includes(repo.id) ? ticket.branch : null,
          steps: [],
          teardown: []
        }))
      ),
      services: []
    }
    this.environments.set(key, environment)
    this.update(environment)

    if (variableErrors.length > 0) {
      this.update(environment, { phase: 'failed', error: `Variables can't be worked out: ${variableErrors.map(([name, error]) => `${name} (${error})`).join(', ')}` })
      return environment
    }

    const setUpRepo = async (repo: Repo, state: EnvironmentRepo): Promise<boolean> => {
      const runner = this.runnerFor(repo.runtime, project)
      const worktreeStep: EnvironmentStep = { label: state.branch ? `Create worktree on ${state.branch}` : `Create worktree at ${repo.defaultBranch} (read-only for this ticket)`, status: 'running', output: '' }
      state.steps.push(worktreeStep)
      this.update(environment)
      try {
        const started = Date.now()
        const outcome = await this.withRepoLock(repo, async () => {
          const { ref, fetched } = await baseRef(runner, repo.path, repo.defaultBranch)
          const result = await ensureWorktree(runner, repo.path, state.path, ref, state.branch)
          return `${result === 'created' ? 'Created' : result === 'switched' ? 'Switched to the ticket branch in' : 'Reused'} ${state.path} from ${ref}${fetched ? '' : ' (not fetched: offline or no origin)'}`
        })
        Object.assign(worktreeStep, { status: 'done', output: outcome, durationMs: Date.now() - started })
        options.log?.('worktree', `${repo.name}: ${outcome}`)
      } catch (error) {
        Object.assign(worktreeStep, { status: 'failed', output: (error as Error).message })
        options.log?.('error', `${repo.name}: ${(error as Error).message}`)
        this.update(environment)
        return false
      }
      this.update(environment)

      const offset = state.steps.length
      const { ok } = await runSteps(
        this.projects.steps(repo.id, 'setup'),
        { runner, cwd: state.path, mainPath: repo.path, lookup: context.lookupFor({ name: repo.name, path: state.path, mainPath: repo.path }) },
        (result) => {
          state.steps[offset + result.index] = stepFrom(result)
          if (result.status) options.log?.(`step-${result.status}`, `${repo.name}: ${result.label}${result.status === 'failed' ? `\n${result.output}` : ''}`)
          this.update(environment)
        }
      )
      return ok
    }

    const pairs = project.repos.map((repo, index) => [repo, environment.repos[index]] as const)
    let ok = true
    if (project.setupInParallel) {
      ok = (await Promise.all(pairs.map(([repo, state]) => setUpRepo(repo, state)))).every(Boolean)
    } else {
      for (const [repo, state] of pairs) {
        if (!(await setUpRepo(repo, state))) {
          ok = false
          break
        }
      }
    }
    if (!ok) {
      this.update(environment, { phase: 'failed', error: 'A setup step failed' })
      return environment
    }

    await this.startServices(key, project, ticket)
    const failed = environment.services.filter((service) => service.state === 'failed')
    this.update(environment, failed.length > 0 ? { phase: 'failed', error: `Service ${failed.map((service) => service.name).join(', ')} didn't become ready` } : { phase: 'ready' })
    options.log?.('environment', failed.length > 0 ? `Setup failed: ${environment.error}` : 'Environment ready')
    return environment
  }

  async startServices(key: string, project: Project, ticket: TicketValues): Promise<void> {
    const environment = this.environments.get(key)
    if (!environment) throw new Error('No environment for this ticket')
    const context = recipeContext(project.variables, ticket)
    await Promise.all(
      project.repos.flatMap((repo) => {
        const state = environment.repos.find((item) => item.repoId === repo.id)
        if (!state) return []
        const runner = this.runnerFor(repo.runtime)
        const lookup = context.lookupFor({ name: repo.name, path: state.path, mainPath: repo.path })
        return this.projects.services(repo.id).map((service) =>
          this.services.start(serviceKey(key, repo.name, service.name), service, runner, state.path, lookup, () => {
            this.serviceSnapshot(environment)
            this.update(environment)
          })
        )
      })
    )
    this.serviceSnapshot(environment)
    this.update(environment)
  }

  async stopServices(key: string): Promise<void> {
    await this.services.stopAll(`${key}|`)
    const environment = this.environments.get(key)
    if (environment) {
      this.serviceSnapshot(environment)
      this.update(environment)
    }
  }

  /**
   * Brings a ticket's worktrees up to date with their base branches, then sets the environment up
   * again: services stop, the base is merged in (or a read-only worktree moves to it), setup runs,
   * services start. If a merge conflicts, nothing changes and the services come back as they were.
   */
  async updateFromBase(key: string, project: Project, ticket: WorkspaceTicket, options: WorkspaceOptions = {}): Promise<Environment> {
    const hadServices = (this.environments.get(key)?.services ?? []).some((service) => service.state === 'ready' || service.state === 'starting')
    await this.stopServices(key)
    try {
      for (const repo of project.repos) {
        const runner = this.runnerFor(repo.runtime, project)
        const path = await this.worktreePath(project, repo, ticket.key)
        if (!(await runner.exists(path))) continue
        const outcome = await this.withRepoLock(repo, async () => {
          const { ref } = await baseRef(runner, repo.path, repo.defaultBranch)
          return bringInBase(runner, path, ref, ticket.affectedRepoIds.includes(repo.id))
        })
        options.log?.('git', `${repo.name}: ${outcome}`)
      }
    } catch (error) {
      if (hadServices && this.environments.has(key)) await this.startServices(key, project, ticket)
      throw error
    }
    return this.create(key, project, ticket, options)
  }

  /** Stops services, runs teardown steps, and removes the worktrees. The ticket branch is kept unless asked. */
  async teardown(key: string, project: Project, ticket: WorkspaceTicket, options: WorkspaceOptions = {}): Promise<Environment> {
    const environment =
      this.environments.get(key) ??
      ({
        key,
        projectId: project.id,
        ticketKey: ticket.key,
        slot: ticket.slot,
        phase: 'tearing-down',
        error: null,
        values: {},
        repos: await Promise.all(project.repos.map(async (repo) => ({ repoId: repo.id, name: repo.name, path: await this.worktreePath(project, repo, ticket.key), branch: null, steps: [], teardown: [] }))),
        services: []
      } satisfies Environment)
    this.environments.set(key, environment)
    this.update(environment, { phase: 'tearing-down', error: null })
    await this.stopServices(key)

    const context = recipeContext(project.variables, ticket)
    let ok = true
    for (const repo of project.repos) {
      const state = environment.repos.find((item) => item.repoId === repo.id)
      if (!state) continue
      const runner = this.runnerFor(repo.runtime)
      state.teardown = []
      const result = await runSteps(
        this.projects.steps(repo.id, 'teardown'),
        { runner, cwd: state.path, mainPath: repo.path, lookup: context.lookupFor({ name: repo.name, path: state.path, mainPath: repo.path }) },
        (step) => {
          state.teardown[step.index] = stepFrom(step)
          this.update(environment)
        }
      )
      ok &&= result.ok
      const removal: EnvironmentStep = { label: 'Remove worktree', status: 'running', output: '' }
      state.teardown.push(removal)
      this.update(environment)
      try {
        await this.withRepoLock(repo, async () => {
          await removeWorktree(runner, repo.path, state.path)
          if (options.deleteBranch && (await branchExists(runner, repo.path, ticket.branch))) {
            await gitIn(runner, repo.path, ['branch', '-D', ticket.branch])
          }
        })
        Object.assign(removal, { status: 'done', output: `Removed ${state.path}` })
      } catch (error) {
        ok = false
        Object.assign(removal, { status: 'failed', output: (error as Error).message })
      }
      this.update(environment)
      // Remove the ticket folder once its last worktree is gone; rmdir leaves it if anything is left.
      await runner.exec(['sh', '-c', 'rmdir "$1" 2>/dev/null; true', 'sh', await this.ticketFolder(project, repo, ticket.key)])
    }
    options.log?.('environment', ok ? 'Torn down' : 'Teardown had problems')
    this.update(environment, ok ? { phase: 'torn-down' } : { phase: 'teardown-failed', error: 'A teardown step failed. The worktree may still exist.' })
    return environment
  }

  forget(key: string): void {
    this.environments.delete(key)
  }
}
