import type { ChildProcess } from 'node:child_process'
import type { GitHubSignIn, GitHubUser } from '@shared/integrations'
import type { ExecOptions, Runner } from '../runner/types'

const HOST = 'github.com'
const DEVICE_URL = 'https://github.com/login/device'

/** The accounts `gh auth status` lists for github.com, and which one is active. */
export function parseAuthStatus(output: string): GitHubUser[] {
  const users: GitHubUser[] = []
  let host = ''
  for (const line of output.split('\n')) {
    if (/^\S/.test(line)) host = line.trim()
    // An account whose token stopped working is listed as "Failed to log in", and can still be signed out.
    const account = line.match(/(?:Logged in to|Failed to log in to) (\S+) account (\S+)/)
    if (account) {
      host = account[1]
      if (host === HOST) users.push({ login: account[2], active: false })
    }
    const active = line.match(/Active account: (true|false)/)
    if (active && host === HOST && users.length > 0) users[users.length - 1].active = active[1] === 'true'
  }
  return users
}

/** The one-time code `gh auth login --web` prints, like 6DD2-3ECC. */
export function parseDeviceCode(output: string): string | null {
  return output.match(/one-time code: ([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1] ?? null
}

/**
 * What a project's commands run with to act as one GitHub account: gh reads GH_TOKEN, and git (fetch, push,
 * private Composer or npm packages) gets the same token for github.com in place of its usual credential helper
 * (the macOS Keychain, git's store, or gh's own), for that command only.
 */
export function accountEnvironment(token: string): Record<string, string> {
  const key = `credential.https://${HOST}.helper`
  return {
    GH_TOKEN: token,
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: key,
    // An empty helper clears the ones configured before it.
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: key,
    GIT_CONFIG_VALUE_1: '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f'
  }
}

/** A runner whose commands all start with these variables added; a command's own still win. */
export function withEnvironment(runner: Runner, environment: () => Record<string, string>, prepare: () => Promise<void>): Runner {
  const wrapped = Object.create(runner) as Runner
  const options = (given: ExecOptions = {}): ExecOptions => ({ ...given, env: { ...environment(), ...given.env } })
  wrapped.exec = async (argv, given) => {
    await prepare()
    return runner.exec(argv, options(given))
  }
  wrapped.spawn = (argv, given) => runner.spawn(argv, options(given))
  return wrapped
}

/**
 * The GitHub accounts gh is signed in to, kept by gh (in the Keychain on a Mac) rather than by Eregion. A
 * project can use one of them in place of gh's active account; Eregion asks gh for its token when needed.
 */
export class GitHubAccounts {
  private readonly tokens = new Map<string, Promise<string>>()
  private signIn: { child: ChildProcess; done: Promise<GitHubUser[]> } | null = null

  constructor(
    /** gh's runtime: the machine's own, or the first WSL distro on Windows. */
    private readonly runner: () => Runner,
    private readonly onChange: () => void = () => undefined
  ) {}

  async list(): Promise<GitHubUser[]> {
    const result = await this.runner().exec(['gh', 'auth', 'status', '--hostname', HOST], { timeoutMs: 20_000 })
    return parseAuthStatus(`${result.stdout}\n${result.stderr}`)
  }

  private token(runner: Runner, login: string): Promise<string> {
    const key = `${runner.runtime.kind === 'wsl' ? runner.runtime.distro : 'native'}:${login}`
    if (!this.tokens.has(key)) {
      const token = runner.exec(['gh', 'auth', 'token', '--hostname', HOST, '--user', login], { timeoutMs: 20_000 }).then((result) => {
        if (result.code !== 0 || !result.stdout.trim()) throw new Error(`gh isn't signed in to GitHub as ${login} any more. Add the account again in Settings › Accounts, or choose another for this project.`)
        return result.stdout.trim()
      })
      token.catch(() => this.tokens.delete(key))
      this.tokens.set(key, token)
    }
    return this.tokens.get(key) as Promise<string>
  }

  /** The runner a project's commands use: as its chosen account, or gh's active one when it has none. */
  forProject(runner: Runner, login: string | null | undefined): Runner {
    if (!login) return runner
    let environment: Record<string, string> = {}
    const prepare = (): Promise<void> => this.token(runner, login).then((token) => void (environment = accountEnvironment(token)))
    // Long-running processes start synchronously; by then a git command has fetched the token.
    prepare().catch(() => undefined)
    return withEnvironment(runner, () => environment, prepare)
  }

  /**
   * Starts gh's browser sign-in and returns the one-time code to enter at github.com/login/device. Adding an
   * account makes it gh's active one, so the account that was active before is switched back afterwards: your
   * Terminal keeps the account it had.
   */
  async startSignIn(): Promise<GitHubSignIn> {
    this.cancelSignIn()
    const before = (await this.list()).find((user) => user.active)?.login ?? null
    const runner = this.runner()
    const child = runner.spawn(['gh', 'auth', 'login', '--hostname', HOST, '--web', '--git-protocol', 'https', '--skip-ssh-key'])
    let output = ''
    const code = new Promise<string>((resolve, reject) => {
      const read = (chunk: Buffer): void => {
        output += chunk.toString('utf8')
        const found = parseDeviceCode(output)
        if (found) resolve(found)
      }
      child.stdout?.on('data', read)
      child.stderr?.on('data', read)
      child.on('error', reject)
      child.on('close', () => reject(new Error(output.trim() || "gh didn't start a sign-in")))
    })
    const done = new Promise<GitHubUser[]>((resolve, reject) => {
      child.on('close', async (exit) => {
        if (this.signIn?.child === child) this.signIn = null
        if (exit !== 0) {
          reject(new Error("The sign-in was cancelled or didn't finish in time"))
          return
        }
        if (before) await runner.exec(['gh', 'auth', 'switch', '--hostname', HOST, '--user', before], { timeoutMs: 20_000 })
        this.onChange()
        resolve(await this.list())
      })
    })
    done.catch(() => undefined)
    this.signIn = { child, done }
    return { code: await code, url: DEVICE_URL }
  }

  /** Waits for the sign-in started by startSignIn to finish in the browser. */
  async finishSignIn(): Promise<GitHubUser[]> {
    if (!this.signIn) throw new Error('No GitHub sign-in is in progress')
    return this.signIn.done
  }

  cancelSignIn(): void {
    this.signIn?.child.kill()
    this.signIn = null
  }

  /** Signs gh out of one account, on this machine. */
  async signOut(login: string): Promise<GitHubUser[]> {
    const result = await this.runner().exec(['gh', 'auth', 'logout', '--hostname', HOST, '--user', login], { timeoutMs: 20_000 })
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `gh couldn't sign out of ${login}`)
    for (const key of [...this.tokens.keys()]) if (key.endsWith(`:${login}`)) this.tokens.delete(key)
    this.onChange()
    return this.list()
  }
}
