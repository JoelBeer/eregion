import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { API_METHODS, type EregionEvent } from '@shared/api'
import { createApi, type Host } from './api'
import { openDatabase } from './db'

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

  it('returns null when the user cancels a file dialog', async () => {
    const api = createApi(openDatabase(':memory:'), fakeHost())
    const project = await api.createProject('X')
    expect(await api.exportProject(project.id)).toBeNull()
    expect(await api.importProject()).toBeNull()
  })
})
