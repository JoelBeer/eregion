import { mkdtemp, readFile } from 'node:fs/promises'
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

  it('returns null when the user cancels a file dialog', async () => {
    const api = createApi(openDatabase(':memory:'), fakeHost())
    const project = await api.createProject('X')
    expect(await api.exportProject(project.id)).toBeNull()
    expect(await api.importProject()).toBeNull()
  })
})
