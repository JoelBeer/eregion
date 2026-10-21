import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../db'
import { ProjectStore } from './store'

let db: Db
let store: ProjectStore

beforeEach(() => {
  db = openDatabase(':memory:')
  store = new ProjectStore(db)
})

function wordMagic() {
  const project = store.create('Word Magic', '#F2D06B')
  const repo = store.addRepo(project.id, { name: 'word-magic', path: '/home/joel/sites/word-magic', runtime: 'native', defaultBranch: 'master', githubRepo: 'JoelBeer/word-magic' })
  store.update(project.id, { variables: [{ name: 'app_port', formula: '8100 + {{slot}}' }] })
  store.saveSteps(repo.id, 'setup', [
    { config: { type: 'copy_file', from: '.env', to: '.env' }, options: {} },
    { config: { type: 'set_env', file: '.env', values: [{ key: 'APP_URL', value: 'http://localhost:{{app_port}}' }] }, options: {} },
    { config: { type: 'command', command: 'composer install' }, options: { onlyIfMissing: 'vendor' } }
  ])
  store.saveServices(repo.id, [
    { name: 'app', command: 'php artisan serve --port={{app_port}}', readyCheck: { kind: 'http', url: 'http://localhost:{{app_port}}', timeoutSec: 60 }, openUrl: 'http://localhost:{{app_port}}' }
  ])
  return { project: store.get(project.id), repo }
}

describe('ProjectStore', () => {
  it('creates a project with initials and sensible GitHub defaults', () => {
    const project = store.create('  Word Magic ')
    expect(project).toMatchObject({ name: 'Word Magic', initials: 'WM', liveSlots: 2, setupStep: 1, repos: [] })
    expect(project.github).toEqual({ draft: true, linkPrs: true, teardownOnMerge: true })
    expect(() => store.create('  ')).toThrow('Give the project a name')
  })

  it('updates only the fields given, and keeps the live cap at least 1', () => {
    const project = store.create('PerchPeak')
    const updated = store.update(project.id, { liveSlots: 0, initials: 'ppx1', color: '#5FC4B8' })
    expect(updated).toMatchObject({ liveSlots: 1, initials: 'PPX', color: '#5FC4B8', name: 'PerchPeak' })
    expect(store.update(project.id, { initials: ' w m ' }).initials).toBe('WM')
    expect(store.update(project.id, { initials: 'a-b c d' }).initials).toBe('ABC')
    expect(() => store.update(project.id, { initials: ' - ' })).toThrow('Initials need at least one letter or digit')
    expect(store.get(project.id).initials).toBe('ABC')
  })

  it('keeps repos in order and can reorder them', () => {
    const project = store.create('PerchPeak')
    const api = store.addRepo(project.id, { name: 'api', path: '/a', runtime: 'native', defaultBranch: 'main' })
    const web = store.addRepo(project.id, { name: 'web', path: '/w', runtime: 'native', defaultBranch: 'main' })
    expect(store.repos(project.id).map((repo) => repo.name)).toEqual(['api', 'web'])
    expect(store.reorderRepos(project.id, [web.id, api.id]).map((repo) => repo.name)).toEqual(['web', 'api'])
    expect(() => store.addRepo(project.id, { name: 'api', path: '/b', runtime: 'native', defaultBranch: 'main' })).toThrow()
  })

  it('stores typed steps and replaces the whole list on save', () => {
    const { repo } = wordMagic()
    const steps = store.steps(repo.id, 'setup')
    expect(steps.map((step) => step.config.type)).toEqual(['copy_file', 'set_env', 'command'])
    expect(steps[2]).toMatchObject({ config: { type: 'command', command: 'composer install' }, options: { onlyIfMissing: 'vendor' }, position: 2 })
    store.saveSteps(repo.id, 'setup', [{ config: { type: 'command', command: 'npm ci' }, options: {} }])
    expect(store.steps(repo.id, 'setup')).toHaveLength(1)
    expect(store.steps(repo.id, 'teardown')).toHaveLength(0)
  })

  it('summarises projects for the Projects screen', () => {
    wordMagic()
    expect(store.list()).toEqual([
      expect.objectContaining({ name: 'Word Magic', initials: 'WM', repoNames: ['word-magic'], runtimes: ['native'], slotsInUse: 0, ticketsInProgress: 0 })
    ])
  })

  it('exports without machine paths and imports into a new project with a free name', () => {
    const { project } = wordMagic()
    const file = store.export(project.id)
    expect(file.repos[0].path).toBe('')
    expect(file.repos[0].steps).toHaveLength(3)

    const imported = store.import(JSON.parse(JSON.stringify(file)), { 'word-magic': '/elsewhere/word-magic' })
    expect(imported.name).toBe('Word Magic 2')
    expect(imported.variables).toEqual(project.variables)
    expect(imported.repos[0]).toMatchObject({ name: 'word-magic', path: '/elsewhere/word-magic', defaultBranch: 'master' })
    expect(store.steps(imported.repos[0].id, 'setup').map((step) => step.config)).toEqual(store.steps(project.repos[0].id, 'setup').map((step) => step.config))
    expect(store.services(imported.repos[0].id)[0].name).toBe('app')
    expect(() => store.import({ format: 'other' } as never)).toThrow('not an Eregion project file')
  })

  it('removes repos and their recipes with the project', () => {
    const { project } = wordMagic()
    store.delete(project.id)
    expect(store.list()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM steps').get()).toEqual({ n: 0 })
  })
})
