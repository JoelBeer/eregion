import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { API_METHODS, type EregionEvent } from '@shared/api'
import { createApi, createBackend, type Host } from './api'
import { git, makeRepo } from './testing/git'
import { getSetting, openDatabase, setSetting } from './db'

function fakeHost(overrides: Partial<Host> = {}): Host & { events: EregionEvent[] } {
  const events: EregionEvent[] = []
  return {
    events,
    appVersion: '0.1.0',
    databasePath: ':memory:',
    pickFolder: async () => null,
    pickSaveFile: async () => null,
    pickOpenFile: async () => null,
    openExternal: async () => undefined,
    emit: (event) => events.push(event),
    ...overrides
  }
}

describe('createApi', () => {
  it('implements every method the preload script exposes', () => {
    const api = createApi(openDatabase(':memory:'), fakeHost())
    for (const method of API_METHODS) {
      expect(typeof api[method]).toBe('function')
    }
  })

  it('tells screens to refresh when a project changes', async () => {
    const host = fakeHost()
    const api = createApi(openDatabase(':memory:'), host)
    const project = await api.createProject('Word Magic')
    await api.updateProject(project.id, { liveSlots: 3 })
    expect(host.events).toContainEqual({ type: 'project-changed', projectId: project.id })
    expect(host.events).toContainEqual({ type: 'projects-changed' })
  })

  it('previews variables for a sample ticket named after the project', async () => {
    const api = createApi(openDatabase(':memory:'), fakeHost())
    const project = await api.createProject('Word Magic')
    const preview = await api.previewVariables(project.id, [
      { name: 'app_port', formula: '8100 + {{slot}}' },
      { name: 'db', formula: 'wm_{{ticket.key | snake}}' }
    ])
    expect(preview.sample).toEqual({ key: 'WM-1', title: 'Sample ticket', slot: 1, branch: 'wm-1-sample-ticket' })
    expect(preview.values).toEqual({ app_port: '8101', db: 'wm_wm_1' })
  })

  it('exports to the file the user picks and imports it back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eregion-export-'))
    const file = join(dir, 'word-magic.eregion.json')
    const host = fakeHost({ pickSaveFile: async () => file, pickOpenFile: async () => file })
    const api = createApi(openDatabase(':memory:'), host)
    const project = await api.createProject('Word Magic')
    await api.addRepo(project.id, { name: 'word-magic', path: '/sites/word-magic', runtime: 'native', defaultBranch: 'master' })

    expect(await api.exportProject(project.id)).toBe(file)
    expect(JSON.parse(await readFile(file, 'utf8')).format).toBe('eregion-project')
    const imported = await api.importProject()
    expect(imported?.name).toBe('Word Magic 2')
    expect(imported?.repos[0]).toMatchObject({ name: 'word-magic', path: '' })
  })

  it("takes the pipeline along, but not this machine's crew or GitHub account", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eregion-export-'))
    const file = join(dir, 'word-magic.eregion.json')
    const api = createApi(openDatabase(':memory:'), fakeHost({ pickSaveFile: async () => file, pickOpenFile: async () => file }))
    const project = await api.createProject('Word Magic')
    await api.updateProject(project.id, { github: { draft: true, account: 'me-at-work' } })
    const bob = await api.createCrew({ name: 'Bob', role: 'Builder', adapter: 'cursor', model: 'auto', seed: 1 })
    const { stages } = await api.getPipeline(project.id)
    const custom = stages.map((stage) => (stage.kind === 'build' ? { ...stage, goal: 'Build it with the house skill.', crewId: bob.id } : stage))
    await api.savePipeline(project.id, custom)

    await api.exportProject(project.id)
    const written = JSON.parse(await readFile(file, 'utf8'))
    expect(written.project.github).toEqual({ draft: true })
    expect(written.pipeline.find((stage: { kind: string }) => stage.kind === 'build')).toMatchObject({ goal: 'Build it with the house skill.', crewId: null })

    const imported = await api.importProject()
    const pipeline = await api.getPipeline(imported?.id as number)
    expect(pipeline.stages.find((stage) => stage.kind === 'build')).toMatchObject({ goal: 'Build it with the house skill.', crewId: null })
    expect(imported?.github).toEqual({ draft: true })
  })

  it('refuses a file whose pipeline is broken, without making a project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eregion-export-'))
    const file = join(dir, 'broken.eregion.json')
    const api = createApi(openDatabase(':memory:'), fakeHost({ pickSaveFile: async () => file, pickOpenFile: async () => file }))
    const project = await api.createProject('Word Magic')
    await api.exportProject(project.id)
    const written = JSON.parse(await readFile(file, 'utf8'))
    await writeFile(file, JSON.stringify({ ...written, pipeline: written.pipeline.filter((stage: { kind: string }) => stage.kind !== 'plan') }))
    await expect(api.importProject()).rejects.toThrow("The pipeline in that file isn't valid")
    expect(await api.listProjects()).toHaveLength(1)
  })

  it("points a repo at another folder, keeping its steps, services and settings, but not under a live environment", async () => {
    const backend = createBackend(openDatabase(':memory:'), fakeHost(), { workspaceRoot: await mkdtemp(join(tmpdir(), 'eregion-move-')) })
    const { api } = backend
    const before = await makeRepo({ 'README.md': 'app' })
    const after = await makeRepo({ 'README.md': 'app' })
    const project = await api.createProject('Word Magic')
    const repo = await api.addRepo(project.id, { name: 'app', path: before.clone, runtime: 'native', defaultBranch: 'main', commitStyle: 'conventional', commitTypes: ['feat', 'fix'] })
    await api.saveSteps(repo.id, 'setup', [{ config: { type: 'command', command: 'npm install' }, options: {} }])
    await api.saveSteps(repo.id, 'teardown', [{ config: { type: 'command', command: 'npm run clean' }, options: {} }])
    await api.saveServices(repo.id, [{ name: 'app', command: 'npm run dev', readyCheck: { kind: 'none' }, openUrl: null }])

    const first = await backend.workspaces.refreshPlanCheckout(await api.getProject(project.id))
    const ticket = await api.createTicket(project.id, 'Hints', '')
    backend.tickets.update(ticket.id, { slot: 1 })
    await expect(api.moveRepo(repo.id, after.clone)).rejects.toThrow(`Tear down ${ticket.key} first`)
    backend.tickets.update(ticket.id, { slot: null })
    await expect(api.moveRepo(repo.id, join(after.root, 'nowhere'))).rejects.toThrow()

    const moved = await api.moveRepo(repo.id, after.clone)
    expect(moved).toMatchObject({ id: repo.id, name: 'app', path: after.clone, defaultBranch: 'main', commitStyle: 'conventional', commitTypes: ['feat', 'fix'] })
    expect(backend.projects.steps(repo.id, 'setup').map((step) => step.config)).toEqual([{ type: 'command', command: 'npm install' }])
    expect(backend.projects.steps(repo.id, 'teardown').map((step) => step.config)).toEqual([{ type: 'command', command: 'npm run clean' }])
    expect(backend.projects.services(repo.id).map((service) => service.command)).toEqual(['npm run dev'])
    // The plan checkout is made again, now from the new folder.
    const second = await backend.workspaces.refreshPlanCheckout(await api.getProject(project.id))
    expect(second.repos[0].path).toBe(first.repos[0].path)
    expect(git(after.clone, 'worktree', 'list')).toContain(first.repos[0].path.split('/').slice(-2).join('/'))
    expect(git(before.clone, 'worktree', 'list')).not.toContain(first.repos[0].path.split('/').slice(-2).join('/'))
  })

  it("deletes a project: tears down its live environments, removes Eregion's folder for it, and keeps the repo and its branches", async () => {
    const db = openDatabase(':memory:')
    const root = await mkdtemp(join(tmpdir(), 'eregion-delete-'))
    const backend = createBackend(db, fakeHost(), { workspaceRoot: root })
    const { api } = backend
    const repo = await makeRepo({ 'README.md': 'app' })
    const project = await api.createProject('Word Magic')
    await api.addRepo(project.id, { name: 'app', path: repo.clone, runtime: 'native', defaultBranch: 'main' })
    const full = await api.getProject(project.id)
    await backend.workspaces.refreshPlanCheckout(full)
    const ticket = await api.createTicket(project.id, 'Hints', '')
    await backend.workspaces.create(`ticket:${ticket.id}`, full, { key: ticket.key, title: 'Hints', slot: 1, branch: 'wm-1-hints', affectedRepoIds: [full.repos[0].id] })
    backend.tickets.update(ticket.id, { slot: 1, branch: 'wm-1-hints' })
    setSetting(db, `rules.project.${project.id}`, 'Use British English.')
    expect(existsSync(join(root, 'word-magic', 'work', ticket.key, 'app'))).toBe(true)

    await api.deleteProject(project.id)
    expect((await api.listProjects()).map((item) => item.id)).not.toContain(project.id)
    expect(existsSync(join(root, 'word-magic'))).toBe(false)
    expect(git(repo.clone, 'worktree', 'list').split('\n')).toHaveLength(1)
    expect(git(repo.clone, 'branch', '--list', 'wm-1-hints')).toContain('wm-1-hints')
    expect(getSetting(db, `rules.project.${project.id}`, 'gone')).toBe('gone')
    expect(existsSync(join(repo.clone, 'README.md'))).toBe(true)
  })

  it("leaves Eregion's folder alone when another project shares its name", async () => {
    const root = await mkdtemp(join(tmpdir(), 'eregion-delete-'))
    const backend = createBackend(openDatabase(':memory:'), fakeHost(), { workspaceRoot: root })
    const { api } = backend
    const repo = await makeRepo({ 'README.md': 'app' })
    const [one, two] = [await api.createProject('Twin'), await api.createProject('Twin!')]
    for (const project of [one, two]) await api.addRepo(project.id, { name: 'app', path: repo.clone, runtime: 'native', defaultBranch: 'main' })
    await backend.workspaces.refreshPlanCheckout(await api.getProject(two.id))
    await api.deleteProject(one.id)
    expect(existsSync(join(root, 'twin', 'plan', 'app'))).toBe(true)
  })

  it('returns null when the user cancels a file dialog', async () => {
    const api = createApi(openDatabase(':memory:'), fakeHost())
    const project = await api.createProject('X')
    expect(await api.exportProject(project.id)).toBeNull()
    expect(await api.importProject()).toBeNull()
  })
})
