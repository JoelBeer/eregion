import type { PrCheck } from '@shared/integrations'
import type { GitHub, PrInfo } from '../integrations/github'
import type { Runner } from '../runner/types'

interface FakePr extends PrInfo {
  body: string
  cwd: string
}

/**
 * GitHub for tests: PRs live in memory, while branch heads come from the real (local) remote, so
 * pushes made by the pipeline show up as new head commits.
 */
export class FakeGitHub implements GitHub {
  readonly prs: FakePr[] = []
  readonly calls: string[] = []
  /** Decides each check's result from the PR's current head commit. */
  checkResult: (pr: FakePr) => PrCheck[] = () => [{ name: 'tests', workflow: 'CI', bucket: 'pass', link: 'https://github.com/me/app/actions/runs/1/job/1' }]

  private async head(runner: Runner, cwd: string, branch: string): Promise<string> {
    const result = await runner.exec(['git', 'ls-remote', 'origin', `refs/heads/${branch}`], { cwd })
    return result.stdout.split(/\s/)[0] ?? ''
  }

  private find(url: string): FakePr {
    const pr = this.prs.find((item) => item.url === url)
    if (!pr) throw new Error(`No PR at ${url}`)
    return pr
  }

  async createPr(runner: Runner, cwd: string, options: { base: string; branch: string; title: string; body: string; draft: boolean }): Promise<string> {
    const number = this.prs.length + 1
    const url = `https://github.com/me/app/pull/${number}`
    this.prs.push({ id: `PR_${number}`, number, url, title: options.title, draft: options.draft, state: 'open', base: options.base, branch: options.branch, headSha: await this.head(runner, cwd, options.branch), additions: 1, deletions: 0, changedFiles: 1, body: options.body, cwd })
    this.calls.push(`create ${options.branch}${options.draft ? ' draft' : ''}`)
    return url
  }

  async viewPr(runner: Runner, _cwd: string, url: string): Promise<PrInfo> {
    const pr = this.find(url)
    pr.headSha = await this.head(runner, pr.cwd, pr.branch)
    const { body: _body, cwd: _where, ...info } = pr
    return { ...info }
  }

  async setPrBody(_runner: Runner, _cwd: string, url: string, body: string): Promise<void> {
    this.find(url).body = body
    this.calls.push(`body ${url}`)
  }

  async markReady(_runner: Runner, _cwd: string, url: string): Promise<void> {
    this.find(url).draft = false
    this.calls.push(`ready ${url}`)
  }

  async checks(runner: Runner, _cwd: string, url: string): Promise<PrCheck[]> {
    const pr = this.find(url)
    pr.headSha = await this.head(runner, pr.cwd, pr.branch)
    return this.checkResult(pr)
  }

  async failedLog(): Promise<string> {
    return 'FAILED tests/HintTest.php: expected a hint'
  }

  async rerunFailed(_runner: Runner, _cwd: string, check: PrCheck): Promise<void> {
    this.calls.push(`rerun ${check.name}`)
  }

  async comment(_runner: Runner, _cwd: string, url: string, body: string): Promise<void> {
    this.calls.push(`comment ${url}: ${body.split('\n')[0]}`)
  }
}
