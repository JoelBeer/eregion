import { describe, expect, it } from 'vitest'
import { NativeRunner } from '../runner/native'
import type { ExecOptions, ExecResult, Runner } from '../runner/types'
import { accountEnvironment, GitHubAccounts, parseAuthStatus, parseDeviceCode } from './githubAccounts'

function fakeRunner(reply: (argv: string[]) => ExecResult): { runner: Runner; calls: { argv: string[]; options?: ExecOptions }[] } {
  const calls: { argv: string[]; options?: ExecOptions }[] = []
  const runner = {
    runtime: { kind: 'native' },
    exec: async (argv: string[], options?: ExecOptions) => {
      calls.push({ argv, options })
      return reply(argv)
    }
  } as unknown as Runner
  return { runner, calls }
}

const TWO_ACCOUNTS = `github.com
  ✓ Logged in to github.com account work-joel (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************

  ✓ Logged in to github.com account JoelBeer (keyring)
  - Active account: false
  - Git operations protocol: https

ghe.example.com
  ✓ Logged in to ghe.example.com account joel (keyring)
  - Active account: true
`

describe('parseAuthStatus', () => {
  it("lists github.com's accounts and which one is active, leaving other hosts out", () => {
    expect(parseAuthStatus(TWO_ACCOUNTS)).toEqual([
      { login: 'work-joel', active: true },
      { login: 'JoelBeer', active: false }
    ])
  })

  it('keeps an account whose token stopped working, so it can be signed out', () => {
    expect(parseAuthStatus('github.com\n  X Failed to log in to github.com account old-me (keyring)\n  - Active account: true\n')).toEqual([{ login: 'old-me', active: true }])
  })

  it('is empty when gh is signed in nowhere', () => {
    expect(parseAuthStatus('You are not logged into any GitHub hosts. To log in, run: gh auth login')).toEqual([])
  })
})

describe('parseDeviceCode', () => {
  it("reads the one-time code gh's browser sign-in prints", () => {
    expect(parseDeviceCode('\n! First copy your one-time code: 6DD2-3ECC\nOpen this URL to continue in your web browser: https://github.com/login/device\n')).toBe('6DD2-3ECC')
    expect(parseDeviceCode('Open this URL')).toBeNull()
  })
})

describe.skipIf(process.platform === 'win32')('accountEnvironment', () => {
  it("makes git hand the account's token to github.com in place of its usual credential helper", async () => {
    const runner = new NativeRunner()
    const result = await runner.exec(['git', '-c', 'credential.helper=store --file=/nonexistent', 'credential', 'fill'], {
      env: { ...accountEnvironment('token-for-work'), GIT_TERMINAL_PROMPT: '0' },
      input: 'protocol=https\nhost=github.com\npath=acme/app.git\n\n'
    })
    expect(result.stdout).toContain('username=x-access-token\npassword=token-for-work')
  })
})

describe('GitHubAccounts', () => {
  it('runs a project as its chosen account, with the token gh holds for it', async () => {
    const { runner, calls } = fakeRunner((argv) => (argv[1] === 'auth' ? { code: 0, stdout: 'gho_work\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }))
    const accounts = new GitHubAccounts(() => runner)
    const project = accounts.forProject(runner, 'work-joel')
    await project.exec(['git', 'push'], { cwd: '/repo', env: { EXTRA: '1' } })
    await project.exec(['gh', 'pr', 'view'])
    expect(calls.filter((call) => call.argv[1] === 'auth')).toEqual([{ argv: ['gh', 'auth', 'token', '--hostname', 'github.com', '--user', 'work-joel'], options: { timeoutMs: 20_000 } }])
    const push = calls.find((call) => call.argv[1] === 'push')
    expect(push?.options).toMatchObject({ cwd: '/repo', env: { GH_TOKEN: 'gho_work', GIT_CONFIG_COUNT: '2', EXTRA: '1' } })
    expect(project.runtime).toEqual({ kind: 'native' })
  })

  it("leaves a project without an account on gh's active one", () => {
    const { runner } = fakeRunner(() => ({ code: 0, stdout: '', stderr: '' }))
    expect(new GitHubAccounts(() => runner).forProject(runner, null)).toBe(runner)
  })

  it('says so when the chosen account is no longer signed in', async () => {
    const { runner } = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'no account found for gone-user' }))
    await expect(new GitHubAccounts(() => runner).forProject(runner, 'gone-user').exec(['git', 'fetch'])).rejects.toThrow("gh isn't signed in to GitHub as gone-user any more")
  })

  it('signs gh out of one account and lists the rest', async () => {
    let changed = 0
    const { runner, calls } = fakeRunner((argv) => (argv[2] === 'status' ? { code: 0, stdout: '', stderr: '  ✓ Logged in to github.com account JoelBeer (keyring)\n  - Active account: true\n' } : { code: 0, stdout: '', stderr: '' }))
    const accounts = await new GitHubAccounts(() => runner, () => changed++).signOut('work-joel')
    expect(calls[0].argv).toEqual(['gh', 'auth', 'logout', '--hostname', 'github.com', '--user', 'work-joel'])
    expect(accounts).toEqual([{ login: 'JoelBeer', active: true }])
    expect(changed).toBe(1)
  })
})
