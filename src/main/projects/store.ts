import type { Db } from '../db'
import {
  initialsFor,
  type GithubProjectConfig,
  type LinearProjectConfig,
  type Project,
  type ProjectFile,
  type ProjectSummary,
  type Repo,
  type Service,
  type Step,
  type StepPhase,
  type Variable
} from '@shared/model'

interface ProjectRow {
  id: number
  name: string
  initials: string
  color: string
  variables: string
  live_slots: number
  linear: string
  github: string
  setup_step: number
  setup_parallel: number
}

interface RepoRow {
  id: number
  project_id: number
  name: string
  path: string
  runtime: string
  default_branch: string
  github_repo: string | null
  position: number
}

interface StepRow {
  id: number
  repo_id: number
  phase: StepPhase
  position: number
  type: string
  config: string
  options: string
}

interface ServiceRow {
  id: number
  repo_id: number
  name: string
  command: string
  ready_check: string
  open_url: string | null
}

function toRepo(row: RepoRow): Repo {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    path: row.path,
    runtime: row.runtime,
    defaultBranch: row.default_branch,
    githubRepo: row.github_repo,
    position: row.position
  }
}

function toStep(row: StepRow): Step {
  return {
    id: row.id,
    repoId: row.repo_id,
    phase: row.phase,
    position: row.position,
    config: { type: row.type, ...JSON.parse(row.config) },
    options: JSON.parse(row.options)
  }
}

function toService(row: ServiceRow): Service {
  return {
    id: row.id,
    repoId: row.repo_id,
    name: row.name,
    command: row.command,
    readyCheck: JSON.parse(row.ready_check),
    openUrl: row.open_url
  }
}

export type { ProjectPatch, RepoInput, ServiceInput, StepInput } from '@shared/api'
import type { ProjectPatch as ApiProjectPatch, RepoInput, ServiceInput, StepInput } from '@shared/api'

type ProjectPatch = ApiProjectPatch

/** Projects, repos and recipes. Every write is a single transaction. */
export class ProjectStore {
  constructor(private readonly db: Db) {}

  list(): ProjectSummary[] {
    const projects = this.db.prepare('SELECT * FROM projects ORDER BY created_at, id').all() as ProjectRow[]
    return projects.map((row) => {
      const repos = this.repos(row.id)
      const counts = this.db
        .prepare(
          `SELECT
             SUM(CASE WHEN slot IS NOT NULL THEN 1 ELSE 0 END) AS slots,
             SUM(CASE WHEN stage NOT IN ('backlog', 'done') THEN 1 ELSE 0 END) AS active,
             SUM(CASE WHEN status IN ('needs_you', 'stopped') THEN 1 ELSE 0 END) AS needs
           FROM tickets WHERE project_id = ?`
        )
        .get(row.id) as { slots: number | null; active: number | null; needs: number | null }
      const linear = JSON.parse(row.linear) as LinearProjectConfig
      return {
        id: row.id,
        name: row.name,
        initials: row.initials,
        color: row.color,
        setupStep: row.setup_step,
        repoNames: repos.map((repo) => repo.name),
        runtimes: [...new Set(repos.map((repo) => repo.runtime))],
        liveSlots: row.live_slots,
        slotsInUse: counts.slots ?? 0,
        ticketsInProgress: counts.active ?? 0,
        ticketsNeedYou: counts.needs ?? 0,
        linearTeamKey: linear.teamKey ?? null
      }
    })
  }

  get(id: number): Project {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined
    if (!row) throw new Error(`Project ${id} not found`)
    return {
      id: row.id,
      name: row.name,
      initials: row.initials,
      color: row.color,
      variables: JSON.parse(row.variables),
      liveSlots: row.live_slots,
      linear: JSON.parse(row.linear),
      github: JSON.parse(row.github),
      setupStep: row.setup_step,
      setupInParallel: row.setup_parallel === 1,
      repos: this.repos(row.id)
    }
  }

  create(name: string, color = '#76E1EF'): Project {
    const trimmed = name.trim()
    if (!trimmed) throw new Error('Give the project a name')
    const result = this.db
      .prepare('INSERT INTO projects (name, initials, color, github) VALUES (?, ?, ?, ?)')
      .run(trimmed, initialsFor(trimmed), color, JSON.stringify({ draft: true, linkPrs: true, teardownOnMerge: true }))
    return this.get(Number(result.lastInsertRowid))
  }

  update(id: number, patch: ProjectPatch): Project {
    const columns: Record<keyof ProjectPatch, [string, (value: never) => unknown]> = {
      name: ['name', (value: string) => value.trim()],
      initials: ['initials', (value: string) => value.trim().toUpperCase().slice(0, 3)],
      color: ['color', (value: string) => value],
      variables: ['variables', (value: Variable[]) => JSON.stringify(value)],
      liveSlots: ['live_slots', (value: number) => Math.max(1, Math.floor(value))],
      linear: ['linear', (value: LinearProjectConfig) => JSON.stringify(value)],
      github: ['github', (value: GithubProjectConfig) => JSON.stringify(value)],
      setupStep: ['setup_step', (value: number) => value],
      setupInParallel: ['setup_parallel', (value: boolean) => (value ? 1 : 0)]
    }
    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, value] of Object.entries(patch) as [keyof ProjectPatch, never][]) {
      if (value === undefined) continue
      const [column, encode] = columns[key]
      sets.push(`${column} = ?`)
      values.push(encode(value))
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    }
    return this.get(id)
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  repos(projectId: number): Repo[] {
    return (this.db.prepare('SELECT * FROM repos WHERE project_id = ? ORDER BY position, id').all(projectId) as RepoRow[]).map(toRepo)
  }

  repo(id: number): Repo {
    const row = this.db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined
    if (!row) throw new Error(`Repo ${id} not found`)
    return toRepo(row)
  }

  addRepo(projectId: number, input: RepoInput): Repo {
    const name = input.name.trim()
    if (!name) throw new Error('Give the repo a short name, such as api or web')
    const position = (this.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM repos WHERE project_id = ?').get(projectId) as { next: number }).next
    const result = this.db
      .prepare('INSERT INTO repos (project_id, name, path, runtime, default_branch, github_repo, position) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, name, input.path, input.runtime, input.defaultBranch || 'main', input.githubRepo ?? null, position)
    return this.repo(Number(result.lastInsertRowid))
  }

  updateRepo(id: number, patch: Partial<RepoInput>): Repo {
    const current = this.repo(id)
    const next = { ...current, ...patch }
    this.db
      .prepare('UPDATE repos SET name = ?, path = ?, runtime = ?, default_branch = ?, github_repo = ? WHERE id = ?')
      .run(next.name.trim(), next.path, next.runtime, next.defaultBranch, next.githubRepo ?? null, id)
    return this.repo(id)
  }

  removeRepo(id: number): void {
    this.db.prepare('DELETE FROM repos WHERE id = ?').run(id)
  }

  reorderRepos(projectId: number, repoIds: number[]): Repo[] {
    const update = this.db.prepare('UPDATE repos SET position = ? WHERE id = ? AND project_id = ?')
    this.db.transaction(() => repoIds.forEach((repoId, position) => update.run(position, repoId, projectId)))()
    return this.repos(projectId)
  }

  steps(repoId: number, phase: StepPhase): Step[] {
    return (this.db.prepare('SELECT * FROM steps WHERE repo_id = ? AND phase = ? ORDER BY position').all(repoId, phase) as StepRow[]).map(toStep)
  }

  /** Replaces a repo's setup or teardown steps with this ordered list. */
  saveSteps(repoId: number, phase: StepPhase, steps: StepInput[]): Step[] {
    const insert = this.db.prepare('INSERT INTO steps (repo_id, phase, position, type, config, options) VALUES (?, ?, ?, ?, ?, ?)')
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM steps WHERE repo_id = ? AND phase = ?').run(repoId, phase)
      steps.forEach((step, position) => {
        const { type, ...config } = step.config
        insert.run(repoId, phase, position, type, JSON.stringify(config), JSON.stringify(step.options ?? {}))
      })
    })()
    return this.steps(repoId, phase)
  }

  services(repoId: number): Service[] {
    return (this.db.prepare('SELECT * FROM services WHERE repo_id = ? ORDER BY id').all(repoId) as ServiceRow[]).map(toService)
  }

  saveServices(repoId: number, services: ServiceInput[]): Service[] {
    const insert = this.db.prepare('INSERT INTO services (repo_id, name, command, ready_check, open_url) VALUES (?, ?, ?, ?, ?)')
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM services WHERE repo_id = ?').run(repoId)
      for (const service of services) {
        insert.run(repoId, service.name.trim(), service.command, JSON.stringify(service.readyCheck), service.openUrl || null)
      }
    })()
    return this.services(repoId)
  }

  /** The project and its whole recipe. Paths are left blank because they belong to this machine. */
  export(id: number): ProjectFile {
    const project = this.get(id)
    return {
      format: 'eregion-project',
      version: 1,
      project: {
        name: project.name,
        initials: project.initials,
        color: project.color,
        variables: project.variables,
        liveSlots: project.liveSlots,
        linear: { ...project.linear, teamId: undefined, statusByStage: undefined },
        github: project.github,
        setupInParallel: project.setupInParallel
      },
      repos: project.repos.map((repo) => ({
        name: repo.name,
        path: '',
        runtime: repo.runtime,
        defaultBranch: repo.defaultBranch,
        githubRepo: repo.githubRepo,
        position: repo.position,
        steps: [...this.steps(repo.id, 'setup'), ...this.steps(repo.id, 'teardown')].map((step) => ({
          phase: step.phase,
          position: step.position,
          config: step.config,
          options: step.options
        })),
        services: this.services(repo.id).map((service) => ({
          name: service.name,
          command: service.command,
          readyCheck: service.readyCheck,
          openUrl: service.openUrl
        }))
      }))
    }
  }

  /** Imports a project file. Repo paths are filled in later from the Repos step. */
  import(file: ProjectFile, paths: Record<string, string> = {}): Project {
    if (file.format !== 'eregion-project' || file.version !== 1) {
      throw new Error('This is not an Eregion project file')
    }
    let name = file.project.name
    for (let copy = 2; this.db.prepare('SELECT 1 FROM projects WHERE name = ?').get(name); copy++) {
      name = `${file.project.name} ${copy}`
    }
    return this.db.transaction(() => {
      const project = this.create(name, file.project.color)
      this.update(project.id, {
        initials: file.project.initials,
        variables: file.project.variables,
        liveSlots: file.project.liveSlots,
        linear: file.project.linear,
        github: file.project.github,
        setupInParallel: file.project.setupInParallel
      })
      for (const repoFile of file.repos) {
        const repo = this.addRepo(project.id, {
          name: repoFile.name,
          path: paths[repoFile.name] ?? repoFile.path,
          runtime: repoFile.runtime,
          defaultBranch: repoFile.defaultBranch,
          githubRepo: repoFile.githubRepo
        })
        for (const phase of ['setup', 'teardown'] as const) {
          this.saveSteps(
            repo.id,
            phase,
            repoFile.steps.filter((step) => step.phase === phase).sort((a, b) => a.position - b.position)
          )
        }
        this.saveServices(repo.id, repoFile.services)
      }
      return this.get(project.id)
    })()
  }
}
