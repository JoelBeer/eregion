import type { CheckBucket, PrCheck } from '@shared/integrations'
import type { Project } from '@shared/model'
import { DEFAULT_SOURCE_PUSH, importRules, sourceOf, STAGE_LABEL_PREFIX, stageLabel, type Connection } from '@shared/sources'
import type { Runner } from '../runner/types'
import { restJson, type Connections } from './connections'
import { trimJobLog, type CheckList, type GitHub, type PrInfo } from './github'
import type { FetchLike } from './linear'
import type { SourceIssue, TicketSource } from './sources'

type Json = Record<string, unknown>

/** The host and project path in a git remote: https://gitlab.com/group/app.git or git@gitlab.com:group/app.git. */
export function parseRemote(remote: string): { host: string; path: string } | null {
  const trimmed = remote.trim()
  const https = trimmed.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (https) return { host: https[1].toLowerCase(), path: https[2] }
  const ssh = trimmed.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/)
  return ssh ? { host: ssh[1].toLowerCase(), path: ssh[2] } : null
}

/** The project path and number in a merge request URL: https://gitlab.com/group/app/-/merge_requests/12. */
export function parseMrUrl(url: string): { host: string; path: string; iid: number } | null {
  const match = url.match(/^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/)
  return match ? { host: match[1].toLowerCase(), path: match[2], iid: Number(match[3]) } : null
}

/** The project path and job id in a job URL: https://gitlab.com/group/app/-/jobs/99. */
export function parseJobUrl(url: string): { path: string; id: number } | null {
  const match = url.match(/^https?:\/\/[^/]+\/(.+?)\/-\/jobs\/(\d+)/)
  return match ? { path: match[1], id: Number(match[2]) } : null
}

const hostOf = (url: string): string => new URL(url).host.toLowerCase()

/** A job's status as a check's bucket. A failure that's allowed to fail doesn't count against the MR. */
export function jobBucket(status: string, allowFailure: boolean): CheckBucket {
  if (status === 'success') return 'pass'
  if (status === 'failed') return allowFailure ? 'skipping' : 'fail'
  if (status === 'canceled') return 'cancel'
  if (status === 'skipped' || status === 'manual') return 'skipping'
  return 'pending'
}

/** GitLab's REST API (v4) with a personal access token, on gitlab.com or your own instance. */
export class GitLabClient {
  constructor(
    private readonly connection: Connection,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return restJson<T>(this.fetchImpl, 'GitLab', `${this.connection.url}/api/v4${path}`, { method, headers: { 'private-token': this.token }, body })
  }

  static project(path: string): string {
    return `/projects/${encodeURIComponent(path)}`
  }

  user(): Promise<{ id: number; username: string; name: string }> {
    return this.request('GET', '/user')
  }

  issues(path: string, query: URLSearchParams): Promise<Json[]> {
    return this.request('GET', `${GitLabClient.project(path)}/issues?${query}`)
  }

  issue(path: string, iid: number): Promise<Json> {
    return this.request('GET', `${GitLabClient.project(path)}/issues/${iid}`)
  }

  notes(path: string, iid: number): Promise<Json[]> {
    return this.request('GET', `${GitLabClient.project(path)}/issues/${iid}/notes?sort=asc&per_page=50`)
  }

  createIssue(path: string, input: { title: string; description: string; assigneeId: number }): Promise<Json> {
    return this.request('POST', `${GitLabClient.project(path)}/issues`, { title: input.title, description: input.description, assignee_ids: [input.assigneeId] })
  }

  editIssue(path: string, iid: number, changes: { add_labels?: string; remove_labels?: string; state_event?: 'close' }): Promise<Json> {
    return this.request('PUT', `${GitLabClient.project(path)}/issues/${iid}`, changes)
  }

  note(path: string, iid: number, body: string, on: 'issues' | 'merge_requests' = 'issues'): Promise<Json> {
    return this.request('POST', `${GitLabClient.project(path)}/${on}/${iid}/notes`, { body })
  }

  createMr(path: string, input: { source_branch: string; target_branch: string; title: string; description: string }): Promise<Json> {
    return this.request('POST', `${GitLabClient.project(path)}/merge_requests`, input)
  }

  mr(path: string, iid: number): Promise<Json> {
    return this.request('GET', `${GitLabClient.project(path)}/merge_requests/${iid}`)
  }

  updateMr(path: string, iid: number, changes: { title?: string; description?: string }): Promise<Json> {
    return this.request('PUT', `${GitLabClient.project(path)}/merge_requests/${iid}`, changes)
  }

  mrPipelines(path: string, iid: number): Promise<{ id: number }[]> {
    return this.request('GET', `${GitLabClient.project(path)}/merge_requests/${iid}/pipelines`)
  }

  jobs(path: string, pipelineId: number): Promise<Json[]> {
    return this.request('GET', `${GitLabClient.project(path)}/pipelines/${pipelineId}/jobs?per_page=100&include_retried=false`)
  }

  retryJob(path: string, jobId: number): Promise<Json> {
    return this.request('POST', `${GitLabClient.project(path)}/jobs/${jobId}/retry`)
  }

  /** A job's log, as text. */
  async trace(path: string, jobId: number): Promise<string> {
    const response = await this.fetchImpl(`${this.connection.url}/api/v4${GitLabClient.project(path)}/jobs/${jobId}/trace`, { method: 'GET', headers: { 'private-token': this.token }, body: undefined as unknown as string })
    if (!response.ok) throw new Error(`GitLab answered ${response.status} for the job log`)
    return response.text()
  }
}

/** Your GitLab account on a connection, for "who is this signed in as". */
export async function gitlabWhoAmI(connection: Connection, token: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<string> {
  const user = await new GitLabClient(connection, token, fetchImpl).user()
  return `${user.name} (@${user.username})`
}

/** The connection for a host, among your GitLab connections. */
function connectionForHost(connections: Connections, host: string): Connection | undefined {
  return connections.list().find((connection) => connection.kind === 'gitlab' && hostOf(connection.url) === host)
}

/**
 * GitLab issues as a ticket source. Tickets are GL- and the issue number; while one is in a stage its issue
 * carries that stage's eregion: label, and it's closed when the ticket is done.
 */
export class GitLabIssuesSource implements TicketSource {
  readonly kind = 'gitlab-issues' as const
  private readonly users = new Map<string, Promise<{ id: number; username: string }>>()

  constructor(
    private readonly connections: Connections,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  private client(project: Project): GitLabClient {
    const id = sourceOf(project).connectionId as string
    return new GitLabClient(this.connections.get(id), this.connections.token(id), this.fetchImpl)
  }

  private me(project: Project): Promise<{ id: number; username: string }> {
    const id = sourceOf(project).connectionId as string
    if (!this.users.has(id)) {
      const user = this.client(project).user()
      user.catch(() => this.users.delete(id))
      this.users.set(id, user)
    }
    return this.users.get(id) as Promise<{ id: number; username: string }>
  }

  location(project: Project): string | null {
    return sourceOf(project).location?.trim() || null
  }

  notReady(project: Project): string | null {
    const source = sourceOf(project)
    if (!source.connectionId || !this.connections.list().some((connection) => connection.id === source.connectionId)) return `Choose ${project.name}'s GitLab connection in its Tickets and code step`
    if (!source.location?.trim()) return `Enter ${project.name}'s GitLab project, like group/app, in its Tickets and code step`
    return null
  }

  private toIssue(raw: Json, path: string, me: string, comments: Json[] = []): SourceIssue {
    const assignee = ((raw.assignees as Json[] | undefined) ?? [])[0] ?? (raw.assignee as Json | null | undefined)
    const iid = Number(raw.iid)
    return {
      id: `${path}#${iid}`,
      key: `GL-${iid}`,
      title: String(raw.title ?? ''),
      description: String(raw.description ?? ''),
      url: String(raw.web_url ?? ''),
      data: {
        state: raw.state === 'closed' ? 'Closed' : 'Open',
        labels: (raw.labels as string[] | undefined) ?? [],
        comments: comments.filter((note) => !note.system).map((note) => ({ author: String(((note.author as Json | undefined) ?? {}).name ?? 'someone'), body: String(note.body ?? ''), createdAt: String(note.created_at ?? '') })),
        assignee: assignee ? String(assignee.username ?? '') : null,
        assigneeId: assignee ? String(assignee.username ?? '') : null
      },
      closed: raw.state === 'closed',
      mine: Boolean(assignee && assignee.username === me)
    }
  }

  async candidates(project: Project): Promise<SourceIssue[]> {
    const path = this.location(project) as string
    const rules = importRules(sourceOf(project))
    const me = await this.me(project)
    const list = (extra: Record<string, string>): Promise<Json[]> => {
      const query = new URLSearchParams({ state: 'opened', per_page: '100', ...extra })
      if (rules.labels.length) query.set('labels', rules.labels.join(','))
      if (rules.excludeLabels.length) query.set('not[labels]', rules.excludeLabels.join(','))
      return this.client(project).issues(path, query)
    }
    const raw = rules.who === 'me' ? await list({ assignee_id: String(me.id) }) : rules.who === 'people' ? (await Promise.all(rules.people.map((person) => list({ assignee_username: person.id })))).flat() : await list({})
    const unique = [...new Map(raw.map((issue) => [Number(issue.iid), issue])).values()]
    return unique.map((issue) => this.toIssue(issue, path, me.username))
  }

  async byIds(project: Project, ids: string[]): Promise<SourceIssue[]> {
    const me = await this.me(project)
    const found = await Promise.all(
      ids.map(async (id) => {
        const [path, iid] = id.split('#')
        return this.client(project)
          .issue(path, Number(iid))
          .then((raw) => this.toIssue(raw, path, me.username))
          .catch(() => null)
      })
    )
    return found.filter((issue): issue is SourceIssue => issue !== null)
  }

  async byKey(project: Project, key: string): Promise<SourceIssue> {
    const match = key.trim().match(/(?:^GL-|^#|\/issues\/|^)(\d+)$/i)
    if (!match) throw new Error(`${key} isn't a GitLab issue: use its number, like GL-12 or #12`)
    const path = this.location(project) as string
    const iid = Number(match[1])
    const [raw, notes] = await Promise.all([this.client(project).issue(path, iid), this.client(project).notes(path, iid).catch(() => [])])
    return this.toIssue(raw, path, (await this.me(project)).username, notes)
  }

  wanted(project: Project, issue: SourceIssue): boolean {
    const rules = importRules(sourceOf(project))
    if (rules.who === 'everyone') return true
    if (rules.who === 'me') return issue.mine
    return rules.people.some((person) => person.id === issue.data.assigneeId)
  }

  async create(project: Project, input: { title: string; description: string }): Promise<SourceIssue> {
    const raw = await this.client(project).createIssue(this.location(project) as string, { ...input, assigneeId: (await this.me(project)).id })
    return this.byKey(project, String(raw.iid))
  }

  /** Swaps the issue's eregion: label for `next` (none when it's done). GitLab makes a label the first time it's used. */
  private async relabel(project: Project, ticketId: string, next: string | null, close = false): Promise<void> {
    const [path, iid] = ticketId.split('#')
    const current = await this.client(project).issue(path, Number(iid))
    const stale = ((current.labels as string[] | undefined) ?? []).filter((label) => label.startsWith(STAGE_LABEL_PREFIX) && label !== next)
    await this.client(project).editIssue(path, Number(iid), {
      ...(next ? { add_labels: next } : {}),
      ...(stale.length ? { remove_labels: stale.join(',') } : {}),
      ...(close ? { state_event: 'close' as const } : {})
    })
  }

  readonly hooks: TicketSource['hooks'] = {
    stageEntered: (ticket, stage, project) => this.relabel(project, ticket.linearId as string, stageLabel(stage.id)),
    ticketDone: async (ticket, project) => {
      const [path, iid] = (ticket.linearId as string).split('#')
      await this.client(project).note(path, Number(iid), 'Done in Eregion: the merge requests merged.')
      await this.relabel(project, ticket.linearId as string, null, true)
    },
    planApproved: async (ticket, markdown, project) => {
      if (!{ ...DEFAULT_SOURCE_PUSH, ...sourceOf(project).push }.planComment) return
      const [path, iid] = (ticket.linearId as string).split('#')
      await this.client(project).note(path, Number(iid), `**Plan approved in Eregion**\n\n${markdown.trim()}`)
    },
    prsOpened: async (ticket, prs, project) => {
      if (!{ ...DEFAULT_SOURCE_PUSH, ...sourceOf(project).push }.prLinks || prs.length === 0) return
      const [path, iid] = (ticket.linearId as string).split('#')
      await this.client(project).note(path, Number(iid), `Merge requests from Eregion:\n\n${prs.map((pr) => `- ${pr.url} (${pr.title})`).join('\n')}`)
    }
  }
}

const DRAFT = /^(draft:|\[draft\]|\(draft\)|wip:)\s*/i

/**
 * GitLab as a code host: merge requests and pipeline jobs, behind the same interface as GitHub, so the PR
 * stage and Watch CI work the same. It uses the GitLab connection whose address matches the repo's remote.
 */
export class GitLabHost implements GitHub {
  constructor(
    private readonly connections: Connections,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike
  ) {}

  /** Whether a URL (a merge request, a job) is on one of your GitLab connections. */
  handles(url: string): boolean {
    const match = url.match(/^https?:\/\/([^/]+)/)
    return Boolean(match && connectionForHost(this.connections, match[1].toLowerCase()))
  }

  /** The repo's GitLab project, when its origin is on one of your GitLab connections. */
  async remote(runner: Runner, cwd: string): Promise<{ client: GitLabClient; path: string } | null> {
    const result = await runner.exec(['git', 'remote', 'get-url', 'origin'], { cwd, timeoutMs: 15_000 })
    const remote = result.code === 0 ? parseRemote(result.stdout) : null
    const connection = remote ? connectionForHost(this.connections, remote.host) : undefined
    return remote && connection ? { client: new GitLabClient(connection, this.connections.token(connection.id), this.fetchImpl), path: remote.path } : null
  }

  private forUrl(url: string): { client: GitLabClient; path: string; iid: number } {
    const parsed = parseMrUrl(url)
    const connection = parsed ? connectionForHost(this.connections, parsed.host) : undefined
    if (!parsed || !connection) throw new Error(`${url} isn't a merge request on one of your GitLab connections`)
    return { client: new GitLabClient(connection, this.connections.token(connection.id), this.fetchImpl), path: parsed.path, iid: parsed.iid }
  }

  private forJob(check: PrCheck): { client: GitLabClient; path: string; id: number } {
    const job = parseJobUrl(check.link)
    const match = check.link.match(/^https?:\/\/([^/]+)/)
    const connection = match ? connectionForHost(this.connections, match[1].toLowerCase()) : undefined
    if (!job || !connection) throw new Error(`${check.name} isn't a job on one of your GitLab connections`)
    return { client: new GitLabClient(connection, this.connections.token(connection.id), this.fetchImpl), path: job.path, id: job.id }
  }

  async createPr(runner: Runner, cwd: string, options: { base: string; branch: string; title: string; body: string; draft: boolean }): Promise<string> {
    const remote = await this.remote(runner, cwd)
    if (!remote) throw new Error("This repo's origin isn't on one of your GitLab connections")
    const mr = await remote.client.createMr(remote.path, { source_branch: options.branch, target_branch: options.base, title: options.draft ? `Draft: ${options.title}` : options.title, description: options.body })
    return String(mr.web_url)
  }

  async viewPr(_runner: Runner, _cwd: string, url: string): Promise<PrInfo> {
    const { client, path, iid } = this.forUrl(url)
    const mr = await client.mr(path, iid)
    return {
      id: String(mr.id),
      number: iid,
      url: String(mr.web_url ?? url),
      title: String(mr.title ?? '').replace(DRAFT, ''),
      draft: mr.draft === true || mr.work_in_progress === true || DRAFT.test(String(mr.title ?? '')),
      state: mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'open',
      base: String(mr.target_branch ?? ''),
      branch: String(mr.source_branch ?? ''),
      headSha: String(mr.sha ?? ''),
      additions: 0,
      deletions: 0,
      changedFiles: Number(String(mr.changes_count ?? '0').replace(/\D/g, '')) || 0,
      mergedAt: (mr.merged_at as string | null | undefined) ?? null
    }
  }

  async setPrBody(_runner: Runner, _cwd: string, url: string, body: string): Promise<void> {
    const { client, path, iid } = this.forUrl(url)
    await client.updateMr(path, iid, { description: body })
  }

  async markReady(_runner: Runner, _cwd: string, url: string): Promise<void> {
    const { client, path, iid } = this.forUrl(url)
    const mr = await client.mr(path, iid)
    const title = String(mr.title ?? '')
    if (DRAFT.test(title)) await client.updateMr(path, iid, { title: title.replace(DRAFT, '') })
  }

  /** The jobs of the merge request's latest pipeline. GitLab has no required checks, so they're all watched. */
  async checks(_runner: Runner, _cwd: string, url: string): Promise<CheckList> {
    const { client, path, iid } = this.forUrl(url)
    const [latest] = await client.mrPipelines(path, iid)
    if (!latest) return { checks: [], scope: 'all' }
    const jobs = await client.jobs(path, latest.id)
    return {
      checks: jobs.map((job) => ({ name: String(job.name ?? ''), workflow: String(job.stage ?? ''), bucket: jobBucket(String(job.status ?? ''), job.allow_failure === true), link: String(job.web_url ?? '') })),
      scope: 'all'
    }
  }

  async failedLog(_runner: Runner, _cwd: string, check: PrCheck): Promise<string> {
    const { client, path, id } = this.forJob(check)
    return trimJobLog(await client.trace(path, id))
  }

  async rerunFailed(_runner: Runner, _cwd: string, check: PrCheck): Promise<void> {
    const { client, path, id } = this.forJob(check)
    await client.retryJob(path, id)
  }

  async comment(_runner: Runner, _cwd: string, url: string, body: string): Promise<void> {
    const { client, path, iid } = this.forUrl(url)
    await client.note(path, iid, body, 'merge_requests')
  }
}

/**
 * The code host for each call: GitLab for repos and URLs on one of your GitLab connections, GitHub (through gh)
 * for everything else, so the PR stage and Watch CI don't need to know which.
 */
export class CodeHosts implements GitHub {
  constructor(
    private readonly github: GitHub,
    private readonly gitlab: GitLabHost
  ) {}

  private host(url: string): GitHub {
    return this.gitlab.handles(url) ? this.gitlab : this.github
  }

  async createPr(runner: Runner, cwd: string, options: { base: string; branch: string; title: string; body: string; draft: boolean }): Promise<string> {
    return ((await this.gitlab.remote(runner, cwd)) ? this.gitlab : this.github).createPr(runner, cwd, options)
  }

  viewPr(runner: Runner, cwd: string, url: string): Promise<PrInfo> {
    return this.host(url).viewPr(runner, cwd, url)
  }

  setPrBody(runner: Runner, cwd: string, url: string, body: string): Promise<void> {
    return this.host(url).setPrBody(runner, cwd, url, body)
  }

  markReady(runner: Runner, cwd: string, url: string): Promise<void> {
    return this.host(url).markReady(runner, cwd, url)
  }

  checks(runner: Runner, cwd: string, url: string, requiredOnly: boolean): Promise<CheckList> {
    return this.host(url).checks(runner, cwd, url, requiredOnly)
  }

  failedLog(runner: Runner, cwd: string, check: PrCheck): Promise<string> {
    return this.host(check.link).failedLog(runner, cwd, check)
  }

  rerunFailed(runner: Runner, cwd: string, check: PrCheck): Promise<void> {
    return this.host(check.link).rerunFailed(runner, cwd, check)
  }

  comment(runner: Runner, cwd: string, url: string, body: string): Promise<void> {
    return this.host(url).comment(runner, cwd, url, body)
  }
}
