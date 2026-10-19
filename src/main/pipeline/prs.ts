import type { PrCheck, PullRequest } from '@shared/integrations'
import type { Db } from '../db'
import type { PrInfo } from '../integrations/github'

interface PrRow {
  id: number
  ticket_id: number
  repo_id: number
  repo: string
  number: number
  url: string
  title: string
  draft: number
  state: 'open' | 'merged' | 'closed'
  base: string
  branch: string
  additions: number
  deletions: number
  changed_files: number
  autofix: number
  autofix_paused_reason: string | null
  checks: string
  rerun_sha: string | null
  pushed_sha: string | null
  head_sha: string | null
  attempts: number
}

export interface StoredPr extends PullRequest {
  repoId: number
  headSha: string | null
  /** The head commit whose failed checks Eregion already re-ran once. */
  rerunSha: string | null
  /** The last commit Eregion pushed, to tell when someone else pushes. */
  pushedSha: string | null
}

function toPr(row: PrRow): StoredPr {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    repoId: row.repo_id,
    repo: row.repo,
    number: row.number,
    url: row.url,
    title: row.title,
    draft: row.draft === 1,
    state: row.state,
    base: row.base,
    branch: row.branch,
    additions: row.additions,
    deletions: row.deletions,
    changedFiles: row.changed_files,
    autofix: row.autofix === 1,
    autofixPausedReason: row.autofix_paused_reason,
    checks: JSON.parse(row.checks) as PrCheck[],
    attempts: row.attempts,
    headSha: row.head_sha,
    rerunSha: row.rerun_sha,
    pushedSha: row.pushed_sha
  }
}

const SELECT = `
  SELECT p.*, r.name AS repo, (SELECT COUNT(*) FROM ci_attempts a WHERE a.pull_request_id = p.id) AS attempts
  FROM pull_requests p JOIN repos r ON r.id = p.repo_id`

/** The pull requests Eregion opened for each ticket, one per changed repo. */
export class PrStore {
  constructor(private readonly db: Db) {}

  forTicket(ticketId: number): StoredPr[] {
    return (this.db.prepare(`${SELECT} WHERE p.ticket_id = ? ORDER BY r.position`).all(ticketId) as PrRow[]).map(toPr)
  }

  get(id: number): StoredPr {
    const row = this.db.prepare(`${SELECT} WHERE p.id = ?`).get(id) as PrRow | undefined
    if (!row) throw new Error(`No pull request ${id}`)
    return toPr(row)
  }

  /** Records a PR from what GitHub says about it, keeping Eregion's own fields. */
  save(ticketId: number, repoId: number, info: PrInfo, autofix: boolean): StoredPr {
    this.db
      .prepare(
        `INSERT INTO pull_requests (ticket_id, repo_id, number, url, title, draft, state, base, branch, additions, deletions, changed_files, head_sha, autofix, pushed_sha)
         VALUES (@ticketId, @repoId, @number, @url, @title, @draft, @state, @base, @branch, @additions, @deletions, @changedFiles, @headSha, @autofix, @headSha)
         ON CONFLICT (ticket_id, repo_id) DO UPDATE SET number = excluded.number, url = excluded.url, title = excluded.title, draft = excluded.draft,
           state = excluded.state, base = excluded.base, branch = excluded.branch, additions = excluded.additions, deletions = excluded.deletions,
           changed_files = excluded.changed_files, head_sha = excluded.head_sha`
      )
      .run({ ticketId, repoId, ...info, draft: info.draft ? 1 : 0, autofix: autofix ? 1 : 0 })
    return this.forTicket(ticketId).find((pr) => pr.repoId === repoId) as StoredPr
  }

  update(id: number, patch: Partial<{ checks: PrCheck[]; rerunSha: string | null; pushedSha: string | null; autofix: boolean; autofixPausedReason: string | null }>): StoredPr {
    const columns: Record<string, string> = { checks: 'checks', rerunSha: 'rerun_sha', pushedSha: 'pushed_sha', autofix: 'autofix', autofixPausedReason: 'autofix_paused_reason' }
    for (const [key, value] of Object.entries(patch)) {
      const stored = key === 'checks' ? JSON.stringify(value) : key === 'autofix' ? (value ? 1 : 0) : value
      this.db.prepare(`UPDATE pull_requests SET ${columns[key]} = ? WHERE id = ?`).run(stored, id)
    }
    return this.get(id)
  }

  addAttempt(prId: number, check: string, headSha: string | null, runId: number | null): number {
    const attempt = (this.db.prepare('SELECT COUNT(*) AS n FROM ci_attempts WHERE pull_request_id = ?').get(prId) as { n: number }).n + 1
    this.db.prepare('INSERT INTO ci_attempts (pull_request_id, check_name, attempt, run_id, head_sha) VALUES (?, ?, ?, ?, ?)').run(prId, check, attempt, runId, headSha)
    return attempt
  }

  finishAttempt(prId: number, attempt: number, result: 'fixed' | 'needs-you', runId: number | null): void {
    this.db.prepare('UPDATE ci_attempts SET result = ?, run_id = COALESCE(?, run_id) WHERE pull_request_id = ? AND attempt = ?').run(result, runId, prId, attempt)
  }

  attempts(prId: number): { check: string; attempt: number; result: string; headSha: string | null }[] {
    return this.db.prepare('SELECT check_name AS "check", attempt, result, head_sha AS headSha FROM ci_attempts WHERE pull_request_id = ? ORDER BY attempt').all(prId) as {
      check: string
      attempt: number
      result: string
      headSha: string | null
    }[]
  }

  removeForTicket(ticketId: number): void {
    this.db.prepare('DELETE FROM pull_requests WHERE ticket_id = ?').run(ticketId)
  }
}
