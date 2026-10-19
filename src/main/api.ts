import { readFile, writeFile } from 'node:fs/promises'
import type { EregionApi, EregionEvent, VariablePreview } from '@shared/api'
import { branchName, type ProjectFile, type Variable } from '@shared/model'
import { resolveVariables } from '@shared/variables'
import type { Db } from './db'
import { detectRepo, detectRepoAt } from './projects/detect'
import { ProjectStore } from './projects/store'
import { ticketBuiltins } from './recipe/context'
import { checkTools } from './tools'

/** What the API needs from Electron, kept behind an interface so the API can be tested without it. */
export interface Host {
  appVersion: string
  databasePath: string
  pickFolder(): Promise<string | null>
  pickSaveFile(defaultName: string): Promise<string | null>
  pickOpenFile(): Promise<string | null>
  openExternal(url: string): Promise<void>
  emit(event: EregionEvent): void
}

export function sampleTicket(projectKey: string | null): VariablePreview['sample'] {
  const key = `${projectKey ?? 'TEST'}-1`
  return { key, title: 'Sample ticket', slot: 1, branch: branchName(key, 'Sample ticket') }
}

export function createApi(db: Db, host: Host): EregionApi {
  const projects = new ProjectStore(db)
  const changed = (projectId: number): void => {
    host.emit({ type: 'project-changed', projectId })
    host.emit({ type: 'projects-changed' })
  }

  return {
    appInfo: async () => ({ version: host.appVersion, platform: process.platform, databasePath: host.databasePath }),
    checkTools: () => checkTools(),

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

    openExternal: (url) => host.openExternal(url)
  }
}
