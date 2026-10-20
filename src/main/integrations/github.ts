import type { CheckBucket, PrCheck } from '@shared/integrations'
import type { Runner } from '../runner/types'

/** A PR's checks, and whether they are the required ones or all of them. */
export interface CheckList {
  checks: PrCheck[]
  scope: 'required' | 'all'
}

export interface PrInfo {
  id: string
  number: number
  url: string
  title: string
  draft: boolean
  state: 'open' | 'merged' | 'closed'
  base: string
  branch: string
  headSha: string
  additions: number
  deletions: number
  changedFiles: number
  mergedAt: string | null
}

/**
 * What Eregion needs from GitHub. GhCli is the real one; tests use a fake. Every call runs in the
 * repo's runtime with the user's own gh login, so nothing about GitHub is stored in Eregion.
 */
export interface GitHub {
  createPr(runner: Runner, cwd: string, options: { base: string; branch: string; title: string; body: string; draft: boolean }): Promise<string>
  viewPr(runner: Runner, cwd: string, url: string): Promise<PrInfo>
  setPrBody(runner: Runner, cwd: string, url: string, body: string): Promise<void>
  markReady(runner: Runner, cwd: string, url: string): Promise<void>
  checks(runner: Runner, cwd: string, url: string, requiredOnly: boolean): Promise<CheckList>
  failedLog(runner: Runner, cwd: string, check: PrCheck): Promise<string>
  rerunFailed(runner: Runner, cwd: string, check: PrCheck): Promise<void>
  comment(runner: Runner, cwd: string, url: string, body: string): Promise<void>
}

const LOG_LIMIT = 12_000

/** owner/repo and number from a pull request URL. */
export function parsePrUrl(url: string): { repo: string; number: number } {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
  if (!match) throw new Error(`Not a pull request URL: ${url}`)
  return { repo: match[1], number: Number(match[2]) }
}

/** The Actions run id in a check's link, when the check is a GitHub Actions job. */
export function runIdFromLink(link: string): string | null {
  return link.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null
}

/**
 * The useful end of a job log: timestamps and colour codes removed, cut after the step's error
 * (the clean-up that follows is noise), and the last 12,000 characters kept.
 */
export function trimJobLog(log: string): string {
  const lines = log
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, '').trimEnd())
  const lastError = lines.map((line) => line.startsWith('##[error]')).lastIndexOf(true)
  const text = (lastError >= 0 ? lines.slice(0, lastError + 1) : lines).join('\n').trim()
  return text.length > LOG_LIMIT ? `…${text.slice(-LOG_LIMIT)}` : text
}

const BUCKETS: CheckBucket[] = ['pass', 'fail', 'pending', 'skipping', 'cancel']

export function parseChecks(stdout: string): PrCheck[] {
  const text = stdout.trim()
  if (!text.startsWith('[')) return []
  return (JSON.parse(text) as { name?: string; workflow?: string; bucket?: string; link?: string }[]).map((check) => ({
    name: check.name ?? '',
    workflow: check.workflow ?? '',
    bucket: BUCKETS.includes(check.bucket as CheckBucket) ? (check.bucket as CheckBucket) : 'pending',
    link: check.link ?? ''
  }))
}

export class GhCli implements GitHub {
  private async gh(runner: Runner, cwd: string, args: string[], input?: string): Promise<string> {
    const result = await runner.exec(['gh', ...args], { cwd, input, timeoutMs: 120_000 })
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `gh ${args[0]} ${args[1] ?? ''} failed`)
    return result.stdout
  }

  async createPr(runner: Runner, cwd: string, options: { base: string; branch: string; title: string; body: string; draft: boolean }): Promise<string> {
    const args = ['pr', 'create', '--base', options.base, '--head', options.branch, '--title', options.title, '--body-file', '-']
    if (options.draft) args.push('--draft')
    const out = await this.gh(runner, cwd, args, options.body)
    const url = out.trim().split('\n').reverse().find((line) => line.includes('/pull/'))
    if (!url) throw new Error(`gh didn't print the new pull request's URL: ${out.trim()}`)
    return url.trim()
  }

  async viewPr(runner: Runner, cwd: string, url: string): Promise<PrInfo> {
    const out = await this.gh(runner, cwd, ['pr', 'view', url, '--json', 'id,number,url,title,isDraft,state,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,mergedAt'])
    const pr = JSON.parse(out) as { id: string; number: number; url: string; title: string; isDraft: boolean; state: string; baseRefName: string; headRefName: string; headRefOid: string; additions: number; deletions: number; changedFiles: number; mergedAt: string | null }
    return {
      id: pr.id,
      number: pr.number,
      url: pr.url,
      title: pr.title,
      draft: pr.isDraft,
      state: pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open',
      base: pr.baseRefName,
      branch: pr.headRefName,
      headSha: pr.headRefOid,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      mergedAt: pr.mergedAt || null
    }
  }

  /** Through the REST API rather than `gh pr edit`, which fails on some gh versions over classic projects. */
  async setPrBody(runner: Runner, cwd: string, url: string, body: string): Promise<void> {
    const { repo, number } = parsePrUrl(url)
    await this.gh(runner, cwd, ['api', '-X', 'PATCH', `repos/${repo}/pulls/${number}`, '--input', '-'], JSON.stringify({ body }))
  }

  async markReady(runner: Runner, cwd: string, url: string): Promise<void> {
    const pr = await this.viewPr(runner, cwd, url)
    if (!pr.draft) return
    const query = 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }'
    await this.gh(runner, cwd, ['api', 'graphql', '-f', `query=${query}`, '-f', `id=${pr.id}`])
  }

  /**
   * The PR's checks. Asked for required checks only, it falls back to all of them when the repo
   * requires none (no branch protection), since otherwise there would be nothing to watch.
   */
  async checks(runner: Runner, cwd: string, url: string, requiredOnly: boolean): Promise<CheckList> {
    const read = async (required: boolean): Promise<PrCheck[] | 'none'> => {
      const args = ['pr', 'checks', url, '--json', 'name,workflow,bucket,link']
      if (required) args.push('--required')
      // gh exits non-zero while checks fail or are pending, and prints the JSON anyway.
      const result = await runner.exec(['gh', ...args], { cwd, timeoutMs: 60_000 })
      if (result.stdout.trim().startsWith('[')) return parseChecks(result.stdout)
      if (/no (required )?checks reported/i.test(result.stderr)) return 'none'
      throw new Error(result.stderr.trim() || 'gh pr checks failed')
    }
    if (requiredOnly) {
      const required = await read(true)
      if (required !== 'none') return { checks: required, scope: 'required' }
    }
    const all = await read(false)
    return { checks: all === 'none' ? [] : all, scope: 'all' }
  }

  /**
   * The failed job's log, read through the REST API: `gh run view --log-failed` prints nothing for
   * some runs on gh 2.63. Falls back to it when the check isn't a job link.
   */
  async failedLog(runner: Runner, cwd: string, check: PrCheck): Promise<string> {
    const job = check.link.match(/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)/)
    if (job) {
      const result = await runner.exec(['gh', 'api', `repos/${job[1]}/actions/jobs/${job[2]}/logs`], { cwd, timeoutMs: 120_000 })
      if (result.code === 0 && result.stdout.trim()) return trimJobLog(result.stdout)
    }
    const runId = runIdFromLink(check.link)
    if (!runId) return `(No log: ${check.name} isn't a GitHub Actions job. See ${check.link})`
    const result = await runner.exec(['gh', 'run', 'view', runId, '--log-failed'], { cwd, timeoutMs: 120_000 })
    return trimJobLog(result.stdout || result.stderr)
  }

  async rerunFailed(runner: Runner, cwd: string, check: PrCheck): Promise<void> {
    const runId = runIdFromLink(check.link)
    if (!runId) throw new Error(`${check.name} can't be re-run from Eregion`)
    await this.gh(runner, cwd, ['run', 'rerun', runId, '--failed'])
  }

  async comment(runner: Runner, cwd: string, url: string, body: string): Promise<void> {
    await this.gh(runner, cwd, ['pr', 'comment', url, '--body-file', '-'], body)
  }
}
