import { posix } from 'node:path'
import type { RuntimeId } from '@shared/model'
import type { Runner } from '../runner'
import { NativeRunner } from '../runner/native'
import { hostToWslPath, WslRunner } from '../runner/wsl'

export type { DetectedFact, RepoDetection } from '@shared/api'
import type { DetectedFact, RepoDetection } from '@shared/api'

type SuggestedRecipe = RepoDetection['recipe']

/** Works out the runtime from a folder path picked on the host. */
export function runtimeForHostPath(hostPath: string, platform: NodeJS.Platform = process.platform): { runtime: RuntimeId; path: string } {
  const match = hostPath.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)/i)
  if (platform === 'win32' && match) {
    return { runtime: `wsl:${match[1]}`, path: hostToWslPath(match[1], hostPath) }
  }
  return { runtime: 'native', path: hostPath }
}

export function runnerForRuntimeId(runtime: RuntimeId): Runner {
  return runtime.startsWith('wsl:') ? new WslRunner(runtime.slice(4)) : new NativeRunner()
}

/** `git@github.com:Joel/x.git` and `https://github.com/Joel/x.git` both become `Joel/x`. */
export function githubRepoFromRemote(url: string): string | null {
  const match = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}` : null
}

export function parseEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)\s*$/)
    if (!match) continue
    let value = match[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    } else {
      value = value.replace(/\s+#.*$/, '')
    }
    values[match[1]] = value
  }
  return values
}

function portFromUrl(url: string | undefined): number | null {
  if (!url) return null
  const match = url.match(/:(\d{2,5})(?:\/|$)/)
  return match ? Number(match[1]) : null
}

async function git(runner: Runner, path: string, args: string[]): Promise<string | null> {
  const result = await runner.exec(['git', '-C', path, ...args], { timeoutMs: 15_000 })
  return result.code === 0 ? result.stdout.trim() : null
}

/**
 * Inspects a repo folder and suggests values and a recipe. Nothing is applied: the setup screens
 * show these as suggestions to accept, edit or ignore, and anything not found is left blank.
 */
export async function detectRepo(hostPath: string, platform: NodeJS.Platform = process.platform): Promise<RepoDetection> {
  const { runtime, path } = runtimeForHostPath(hostPath, platform)
  return detectRepoAt(runtime, path)
}

/** Same as detectRepo, for a repo whose runtime and path are already known. */
export async function detectRepoAt(runtime: RuntimeId, path: string): Promise<RepoDetection> {
  const runner = runnerForRuntimeId(runtime)
  const hostPath = runner.toHostPath(path)
  const file = (name: string): string => runner.join(path, name)
  const facts: DetectedFact[] = []
  const warnings: string[] = []
  const recipe: SuggestedRecipe = { variables: [], setup: [], teardown: [], services: [] }

  if (runtime !== 'native') facts.push({ label: 'Runtime', value: runtime, source: 'from path' })

  if ((await git(runner, path, ['rev-parse', '--is-inside-work-tree'])) !== 'true') {
    throw new Error(`${hostPath} isn't a git repository`)
  }
  const originHead = await git(runner, path, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const defaultBranch = originHead?.replace(/^origin\//, '') ?? (await git(runner, path, ['branch', '--show-current']))
  if (defaultBranch) facts.push({ label: 'Default branch', value: defaultBranch, source: 'from git' })
  const remote = await git(runner, path, ['remote', 'get-url', 'origin'])
  const githubRepo = remote ? githubRepoFromRemote(remote) : null
  if (githubRepo) facts.push({ label: 'GitHub repo', value: githubRepo, source: 'git remote' })

  const composer = await runner.readFile(file('composer.json'))
  const isLaravel = composer !== null && composer.includes('"laravel/framework"') && (await runner.exists(file('artisan')))
  if (isLaravel) facts.push({ label: 'Framework', value: 'Laravel', source: 'composer.json' })

  const packageJson = await runner.readFile(file('package.json'))
  let packageManager: 'npm' | 'yarn' | 'pnpm' | null = null
  let scripts: Record<string, string> = {}
  if (packageJson !== null) {
    try {
      scripts = (JSON.parse(packageJson) as { scripts?: Record<string, string> }).scripts ?? {}
    } catch {
      warnings.push("package.json isn't valid JSON")
    }
    packageManager = (await runner.exists(file('yarn.lock'))) ? 'yarn' : (await runner.exists(file('pnpm-lock.yaml'))) ? 'pnpm' : 'npm'
    facts.push({ label: 'Package manager', value: packageManager, source: packageManager === 'npm' ? 'package.json' : `${packageManager} lock file` })
  }

  const envName = (await runner.exists(file('.env'))) ? '.env' : (await runner.exists(file('.env.example'))) ? '.env.example' : null
  const env = envName ? parseEnv((await runner.readFile(file(envName))) ?? '') : {}
  if (envName) {
    recipe.setup.push({ config: { type: 'copy_file', from: envName, to: '.env' }, options: {} })
  }

  const basePort = portFromUrl(env.APP_URL) ?? (isLaravel ? 8000 : packageJson ? 3000 : null)
  if (basePort !== null) {
    recipe.variables.push({ name: 'app_port', formula: `${basePort} + {{slot}}` })
  }
  if (isLaravel && envName) {
    recipe.setup.push({ config: { type: 'set_env', file: '.env', values: [{ key: 'APP_URL', value: 'http://localhost:{{app_port}}' }] }, options: {} })
  }

  const connection = env.DB_CONNECTION
  if (connection) facts.push({ label: 'Database', value: connection === 'sqlite' ? 'SQLite file' : `${connection} · ${env.DB_HOST ?? ''}`, source: envName ?? '.env' })
  if (connection === 'sqlite' && !env.DB_DATABASE) {
    recipe.setup.push({ config: { type: 'command', command: 'touch database/database.sqlite' }, options: { onlyIfMissing: 'database/database.sqlite' } })
  } else if (connection === 'mysql' || connection === 'mariadb') {
    recipe.variables.push({ name: 'db_name', formula: `${posix.basename(path).replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_{{ticket.key | snake}}` })
    recipe.setup.push({ config: { type: 'set_env', file: '.env', values: [{ key: 'DB_DATABASE', value: '{{db_name}}' }] }, options: {} })
    recipe.setup.push({ config: { type: 'command', command: `mysql -h ${env.DB_HOST || '127.0.0.1'} -u ${env.DB_USERNAME || 'root'} -e "CREATE DATABASE IF NOT EXISTS {{db_name}}"` }, options: {} })
    recipe.teardown.push({ config: { type: 'command', command: `mysql -h ${env.DB_HOST || '127.0.0.1'} -u ${env.DB_USERNAME || 'root'} -e "DROP DATABASE IF EXISTS {{db_name}}"` }, options: { continueOnError: true } })
    warnings.push('MySQL passwords are not detected. Add one to the keychain if your database needs it.')
  }

  if (composer !== null) {
    recipe.setup.push({ config: { type: 'command', command: 'composer install --no-interaction' }, options: { onlyIfMissing: 'vendor' } })
  }
  if (packageManager) {
    const install = packageManager === 'npm' ? 'npm install' : `${packageManager} install`
    recipe.setup.push({ config: { type: 'command', command: install }, options: { onlyIfMissing: 'node_modules' } })
  }
  if (isLaravel) {
    const seeds = await runner.exists(file('database/seeders/DatabaseSeeder.php'))
    recipe.setup.push({ config: { type: 'command', command: `php artisan migrate${seeds ? ' --seed' : ''} --force` }, options: {} })
  }

  const herd = isLaravel ? (await runner.exec(runner.shell('command -v herd'))).code === 0 : false
  if (herd) {
    facts.push({ label: 'Server', value: 'Herd', source: 'herd on PATH' })
    recipe.setup.push({ config: { type: 'command', command: 'herd link {{repo.name | slug}}-{{ticket.key | slug}}' }, options: {} })
    recipe.teardown.unshift({ config: { type: 'command', command: 'herd unlink {{repo.name | slug}}-{{ticket.key | slug}}' }, options: { continueOnError: true } })
  }

  if (packageManager && scripts.build && isLaravel) {
    recipe.setup.push({ config: { type: 'command', command: `${packageManager} run build` }, options: {} })
  }

  if (isLaravel && !herd) {
    recipe.services.push({
      name: 'app',
      command: 'php artisan serve --host=0.0.0.0 --port={{app_port}}',
      readyCheck: { kind: 'http', url: 'http://localhost:{{app_port}}', timeoutSec: 60 },
      openUrl: 'http://localhost:{{app_port}}'
    })
  } else if (!isLaravel && packageManager && scripts.dev) {
    recipe.services.push({
      name: 'web',
      command: `PORT={{app_port}} ${packageManager} run dev`,
      readyCheck: { kind: 'http', url: 'http://localhost:{{app_port}}', timeoutSec: 90 },
      openUrl: 'http://localhost:{{app_port}}'
    })
    warnings.push(`Check that "${packageManager} run dev" reads PORT. If its port is hard-coded, every ticket's app will collide.`)
  }

  return {
    path,
    runtime,
    name: posix.basename(path.replace(/\\/g, '/')),
    defaultBranch: defaultBranch ?? null,
    githubRepo,
    facts,
    recipe,
    warnings
  }
}
