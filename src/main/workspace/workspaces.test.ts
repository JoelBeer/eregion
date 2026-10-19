import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Environment } from '@shared/environment'
import { openDatabase } from '../db'
import { ProjectStore } from '../projects/store'
import { portOpen, ServiceManager } from '../recipe/services'
import { git, makeRepo } from '../testing/git'
import { Workspaces } from './workspaces'

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

async function setup() {
  const api = await makeRepo({ 'README.md': 'api', '.env': 'APP_URL=http://localhost\n' })
  const web = await makeRepo({ 'README.md': 'web' }, 'master')
  const root = await mkdtemp(join(tmpdir(), 'eregion-root-'))
  const port = await freePort()
  const store = new ProjectStore(openDatabase(':memory:'))
  const project = store.create('Test Project')
  const apiRepo = store.addRepo(project.id, { name: 'api', path: api.clone, runtime: 'native', defaultBranch: 'main' })
  const webRepo = store.addRepo(project.id, { name: 'web', path: web.clone, runtime: 'native', defaultBranch: 'master' })
  store.update(project.id, { variables: [{ name: 'app_port', formula: `${port - 1} + {{slot}}` }] })
  store.saveSteps(apiRepo.id, 'setup', [
    { config: { type: 'copy_file', from: '.env', to: '.env' }, options: {} },
    { config: { type: 'set_env', file: '.env', values: [{ key: 'APP_URL', value: 'http://localhost:{{app_port}}' }] }, options: {} },
    { config: { type: 'command', command: 'echo {{ticket.key | snake}} > marker.txt' }, options: {} }
  ])
  store.saveSteps(apiRepo.id, 'teardown', [{ config: { type: 'command', command: 'echo bye > {{repo.main_path}}/teardown-ran.txt' }, options: {} }])
  store.saveServices(apiRepo.id, [
    {
      name: 'app',
      command: `node -e "require('http').createServer((q, s) => s.end('ok')).listen({{app_port}})"`,
      readyCheck: { kind: 'http', url: 'http://127.0.0.1:{{app_port}}', timeoutSec: 20 },
      openUrl: 'http://localhost:{{app_port}}'
    }
  ])
  const changes: Environment[] = []
  const workspaces = new Workspaces(store, new ServiceManager(), (environment) => changes.push(environment), undefined, root)
  return { store, project: store.get(project.id), apiRepo, webRepo, api, web, root, port, workspaces, changes }
}

describe.skipIf(process.platform === 'win32')('Workspaces', () => {
  let context: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => {
    context = await setup()
  })

  it('sets up a ticket: branch for changed repos, detached for the rest, setup steps, services', async () => {
    const { workspaces, project, apiRepo, port, root, changes } = context
    const ticket = { key: 'TP-7', title: 'Add things', slot: 1, branch: 'tp-7-add-things', affectedRepoIds: [apiRepo.id] }
    const environment = await workspaces.create('ticket:1', project, ticket)

    expect(environment.error).toBeNull()
    expect(environment.phase).toBe('ready')
    expect(environment.values).toEqual({ app_port: String(port) })
    const apiPath = join(root, 'test-project', 'work', 'TP-7', 'api')
    const webPath = join(root, 'test-project', 'work', 'TP-7', 'web')
    expect(environment.repos.map((repo) => [repo.name, repo.path, repo.branch])).toEqual([
      ['api', apiPath, 'tp-7-add-things'],
      ['web', webPath, null]
    ])
    expect(git(apiPath, 'branch', '--show-current')).toBe('tp-7-add-things')
    expect(git(webPath, 'branch', '--show-current')).toBe('')
    expect(await readFile(join(apiPath, '.env'), 'utf8')).toBe(`APP_URL=http://localhost:${port}\n`)
    expect((await readFile(join(apiPath, 'marker.txt'), 'utf8')).trim()).toBe('tp_7')
    expect(environment.services).toEqual([expect.objectContaining({ repoName: 'api', name: 'app', state: 'ready', openUrl: `http://localhost:${port}` })])
    expect(await portOpen(port)).toBe(true)
    expect(changes.some((change) => change.phase === 'setting-up')).toBe(true)

    const torn = await workspaces.teardown('ticket:1', project, ticket)
    expect(torn.phase).toBe('torn-down')
    expect(await portOpen(port)).toBe(false)
    expect(git(context.api.clone, 'worktree', 'list')).not.toContain('TP-7')
    expect(git(context.api.clone, 'branch', '--list', 'tp-7-add-things')).toContain('tp-7-add-things')
    expect((await readFile(join(context.api.clone, 'teardown-ran.txt'), 'utf8')).trim()).toBe('bye')
    await expect(readFile(join(root, 'test-project', 'work', 'TP-7'), 'utf8')).rejects.toThrow('ENOENT')
  }, 60_000)

  it('reuses the branch when a ticket environment is created again, and can delete it at teardown', async () => {
    const { workspaces, project, apiRepo } = context
    const ticket = { key: 'TP-8', title: 'Again', slot: 2, branch: 'tp-8-again', affectedRepoIds: [apiRepo.id] }
    await workspaces.create('ticket:2', project, ticket)
    await workspaces.teardown('ticket:2', project, ticket)
    const again = await workspaces.create('ticket:2', project, ticket)
    expect(again.repos[0].steps[0].output).toContain(`from origin/main`)
    await workspaces.teardown('ticket:2', project, ticket, { deleteBranch: true })
    expect(git(context.api.clone, 'branch', '--list', 'tp-8-again')).toBe('')
  }, 60_000)

  it('moves a read-only repo onto the ticket branch when the plan grows', async () => {
    const { workspaces, project, apiRepo, webRepo } = context
    const ticket = { key: 'TP-9', title: 'Grow', slot: 1, branch: 'tp-9-grow', affectedRepoIds: [apiRepo.id] }
    const first = await workspaces.create('ticket:3', project, ticket)
    await workspaces.stopServices('ticket:3')
    const second = await workspaces.create('ticket:3', project, { ...ticket, affectedRepoIds: [apiRepo.id, webRepo.id] })
    expect(second.repos[1].steps[0].output).toContain('Switched to the ticket branch')
    expect(git(first.repos[1].path, 'branch', '--show-current')).toBe('tp-9-grow')
    await workspaces.teardown('ticket:3', project, ticket)
  }, 60_000)

  it('stops at a failing setup step and reports the environment as failed', async () => {
    const { workspaces, project, apiRepo, store } = context
    store.saveSteps(apiRepo.id, 'setup', [{ config: { type: 'command', command: 'echo nope >&2; exit 4' }, options: {} }])
    const ticket = { key: 'TP-10', title: 'Broken', slot: 1, branch: 'tp-10-broken', affectedRepoIds: [] }
    const environment = await workspaces.create('ticket:4', store.get(project.id), ticket)
    expect(environment.phase).toBe('failed')
    expect(environment.repos[0].steps.at(-1)).toMatchObject({ status: 'failed', output: 'nope' })
    expect(environment.services).toEqual([])
    await workspaces.teardown('ticket:4', store.get(project.id), ticket)
  }, 60_000)

  it('keeps the plan checkout detached at the latest base and throws away local changes', async () => {
    const { workspaces, project, api } = context
    const first = await workspaces.refreshPlanCheckout(project)
    const planApi = first.repos[0].path
    expect(first.repos.map((repo) => repo.base)).toEqual(['origin/main', 'origin/master'])
    await writeFile(join(planApi, 'README.md'), 'scribbled on')
    await writeFile(join(planApi, 'stray.txt'), 'stray')

    const seed = join(api.root, 'seed')
    await writeFile(join(seed, 'NEW.md'), 'new on main')
    git(seed, 'add', '-A')
    git(seed, 'commit', '-m', 'More')
    git(seed, 'push')

    await workspaces.refreshPlanCheckout(project)
    expect(await readFile(join(planApi, 'README.md'), 'utf8')).toBe('api')
    expect(await readFile(join(planApi, 'NEW.md'), 'utf8')).toBe('new on main')
    await expect(readFile(join(planApi, 'stray.txt'), 'utf8')).rejects.toThrow()
  }, 60_000)
})
