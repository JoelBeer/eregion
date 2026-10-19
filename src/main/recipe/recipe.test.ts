import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NativeRunner } from '../runner/native'
import { recipeContext } from './context'
import { formatEnvValue, setEnvValues } from './env'
import { portOpen, ServiceManager } from './services'
import { describeStep } from '@shared/recipe'
import { runSteps } from './steps'

describe('setEnvValues', () => {
  it('replaces keys in place, appends new ones and keeps comments', () => {
    const before = '# App\nAPP_NAME="Word Magic"\nAPP_URL=http://localhost\n\nDB_CONNECTION=sqlite\nAPP_URL=dup\n'
    expect(setEnvValues(before, [{ key: 'APP_URL', value: 'http://localhost:8101' }, { key: 'NEW_KEY', value: 'a b' }])).toBe(
      '# App\nAPP_NAME="Word Magic"\nAPP_URL=http://localhost:8101\n\nDB_CONNECTION=sqlite\nNEW_KEY="a b"\n'
    )
  })

  it('works on an empty file and with export prefixes', () => {
    expect(setEnvValues('', [{ key: 'A', value: '1' }])).toBe('A=1\n')
    expect(setEnvValues('export A=0\n', [{ key: 'A', value: '1' }])).toBe('A=1\n')
  })

  it('quotes only values that need it', () => {
    expect(formatEnvValue('perchpeak_pp_412')).toBe('perchpeak_pp_412')
    expect(formatEnvValue('localhost:3003,api.test')).toBe('localhost:3003,api.test')
    expect(formatEnvValue('Word "Magic"')).toBe('"Word \\"Magic\\""')
  })
})

describe('recipeContext', () => {
  it('resolves variables and repo values for a ticket', () => {
    const context = recipeContext([{ name: 'app_port', formula: '8100 + {{slot}}' }], { key: 'WM-7', title: 'Add hints', slot: 2, branch: 'wm-7-add-hints' })
    const lookup = context.lookupFor({ name: 'word-magic', path: '/work/WM-7/word-magic', mainPath: '/sites/word-magic' })
    expect(lookup('app_port')).toBe('8102')
    expect(lookup('repo.path')).toBe('/work/WM-7/word-magic')
    expect(lookup('ticket.key')).toBe('WM-7')
    expect(describeStep({ type: 'command', command: 'php artisan serve --port={{app_port}}' }, lookup)).toBe('php artisan serve --port=8102')
  })
})

describe.skipIf(process.platform === 'win32')('runSteps', () => {
  const runner = new NativeRunner()

  async function workspace() {
    const root = await mkdtemp(join(tmpdir(), 'eregion-recipe-'))
    const main = join(root, 'main')
    const worktree = join(root, 'worktree')
    await mkdir(main, { recursive: true })
    await mkdir(worktree, { recursive: true })
    await writeFile(join(main, '.env'), 'APP_URL=http://localhost\nAPP_KEY=base64:abc\n')
    const lookup = recipeContext([{ name: 'app_port', formula: '8100 + {{slot}}' }], { key: 'WM-7', title: 't', slot: 1, branch: 'b' }).lookupFor({
      name: 'word-magic',
      path: worktree,
      mainPath: main
    })
    return { main, worktree, target: { runner, cwd: worktree, mainPath: main, lookup } }
  }

  it('runs the Word Magic style setup: copy .env, set values, create a file, skip what exists', async () => {
    const { worktree, target } = await workspace()
    await mkdir(join(worktree, 'vendor'))
    const seen: string[] = []
    const { ok, results } = await runSteps(
      [
        { config: { type: 'copy_file', from: '.env', to: '.env' }, options: {} },
        { config: { type: 'set_env', file: '.env', values: [{ key: 'APP_URL', value: 'http://localhost:{{app_port}}' }] }, options: {} },
        { config: { type: 'command', command: 'mkdir -p database && touch database/database.sqlite' }, options: { onlyIfMissing: 'database/database.sqlite' } },
        { config: { type: 'command', command: 'echo installing' }, options: { onlyIfMissing: 'vendor' } }
      ],
      target,
      (step) => step.status && seen.push(`${step.index}:${step.status}`)
    )
    expect(ok).toBe(true)
    expect(results.map((result) => result.status)).toEqual(['done', 'done', 'done', 'skipped'])
    expect(seen).toEqual(['0:done', '1:done', '2:done', '3:skipped'])
    expect(await readFile(join(worktree, '.env'), 'utf8')).toBe('APP_URL=http://localhost:8101\nAPP_KEY=base64:abc\n')
    expect(await runner.exists(join(worktree, 'database/database.sqlite'))).toBe(true)
  })

  it('stops at the first failing step unless it may continue', async () => {
    const { target } = await workspace()
    const { ok, results } = await runSteps(
      [
        { config: { type: 'command', command: 'exit 2' }, options: { continueOnError: true } },
        { config: { type: 'command', command: 'echo broken >&2; exit 1' }, options: {} },
        { config: { type: 'command', command: 'echo never' }, options: {} }
      ],
      target
    )
    expect(ok).toBe(false)
    expect(results.map((result) => result.status)).toEqual(['failed-continued', 'failed'])
    expect(results[1].output).toBe('broken')
  })

  it('fails a step with an unknown placeholder instead of running it half-filled', async () => {
    const { target } = await workspace()
    const { results } = await runSteps([{ config: { type: 'command', command: 'echo {{nope}}' }, options: {} }], target)
    expect(results[0]).toMatchObject({ status: 'failed', output: 'Unknown placeholder: nope' })
  })

  it('reports a missing file to copy from the main repo', async () => {
    const { target } = await workspace()
    const { results } = await runSteps([{ config: { type: 'copy_file', from: '.env.missing', to: '.env' }, options: {} }], target)
    expect(results[0].status).toBe('failed')
    expect(results[0].output).toContain("doesn't exist")
  })

  it('times out a step that runs too long', async () => {
    const { target } = await workspace()
    const { results } = await runSteps([{ config: { type: 'command', command: 'sleep 10' }, options: { timeoutSec: 1 } }], target)
    expect(results[0].status).toBe('failed')
    expect(results[0].durationMs).toBeLessThan(5000)
  })
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

describe.skipIf(process.platform === 'win32')('ServiceManager', () => {
  const runner = new NativeRunner()

  it('starts a service, waits until it answers, and stops its whole process tree', async () => {
    const port = await freePort()
    const services = new ServiceManager()
    const lookup = (name: string): string | undefined => (name === 'port' ? String(port) : undefined)
    const service = await services.start(
      'ticket-1:app',
      {
        name: 'app',
        command: `node -e "require('http').createServer((q, s) => s.end('ok')).listen({{port}})"`,
        readyCheck: { kind: 'http', url: 'http://127.0.0.1:{{port}}', timeoutSec: 20 },
        openUrl: 'http://localhost:{{port}}'
      },
      runner,
      tmpdir(),
      lookup
    )
    expect(service.state).toBe('ready')
    expect(service.pid).toBeGreaterThan(0)
    expect(service.openUrl).toBe(`http://localhost:${port}`)
    expect(await portOpen(port)).toBe(true)

    await services.stop('ticket-1:app')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(await portOpen(port)).toBe(false)
    expect(services.list()).toHaveLength(0)
  })

  it('marks a service as failed when it exits before it is ready', async () => {
    const services = new ServiceManager()
    const service = await services.start(
      'ticket-1:broken',
      { name: 'broken', command: 'echo cannot start >&2; exit 1', readyCheck: { kind: 'port', port: '1', timeoutSec: 10 }, openUrl: null },
      runner,
      tmpdir(),
      () => undefined
    )
    expect(service.state).toBe('failed')
    expect(service.log.join('\n')).toContain('cannot start')
  })
})
