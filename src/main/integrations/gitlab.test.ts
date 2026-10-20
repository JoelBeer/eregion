import { describe, expect, it } from 'vitest'
import type { GitHub } from './github'
import type { Project } from '@shared/model'
import { DEFAULT_IMPORT_RULES } from '@shared/sources'
import type { ExecResult, Runner } from '../runner/types'
import { openDatabase } from '../db'
import { Connections } from './connections'
import { CodeHosts, GitLabHost, GitLabIssuesSource, jobBucket, parseMrUrl, parseRemote } from './gitlab'
import type { FetchLike } from './linear'
import { PLAIN_CODEC } from './linearAuth'

/** A GitLab stand-in that answers by method and path, and records every call. */
function fakeGitLab(answers: (method: string, path: string) => unknown) {
  const calls: { method: string; path: string; body: unknown; token: string }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const path = url.replace('https://gitlab.example.com/api/v4', '')
    calls.push({ method: init.method, path, body: init.body ? JSON.parse(init.body) : undefined, token: init.headers['private-token'] })
    const value = path === '/user' ? { id: 7, username: 'joel', name: 'Joel' } : answers(init.method, path)
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? {})
    return { ok: true, status: 200, json: async () => JSON.parse(text), text: async () => text }
  }
  return { calls, fetchImpl }
}

async function connected(answers: (method: string, path: string) => unknown) {
  const db = openDatabase(':memory:')
  const gitlab = fakeGitLab(answers)
  const connections = new Connections(db, PLAIN_CODEC, { jira: async () => 'x', gitlab: async () => 'Joel (@joel)', linear: async () => 'x' })
  const connection = await connections.save({ kind: 'gitlab', name: 'Work GitLab', url: 'https://gitlab.example.com', token: 'glpat-1' })
  return { connections, connection, ...gitlab }
}

const rawIssue = (iid: number, extra: Record<string, unknown> = {}) => ({ iid, title: `Issue ${iid}`, description: 'Body', web_url: `https://gitlab.example.com/team/app/-/issues/${iid}`, state: 'opened', labels: ['bug', 'eregion:plan'], assignees: [{ username: 'joel' }], ...extra })

describe('GitLabIssuesSource', () => {
  it('lists your open issues with the labels in the query, as GL- tickets, with the token in the header', async () => {
    const { connections, connection, calls, fetchImpl } = await connected(() => [rawIssue(3)])
    const project = { id: 1, name: 'App', linear: {}, repos: [], source: { kind: 'gitlab-issues', connectionId: connection.id, location: 'team/app', rules: { ...DEFAULT_IMPORT_RULES, labels: ['bug'], excludeLabels: ['wontfix'] } } } as unknown as Project
    const source = new GitLabIssuesSource(connections, fetchImpl)
    const [issue] = await source.candidates(project)
    expect(issue).toMatchObject({ id: 'team/app#3', key: 'GL-3', url: 'https://gitlab.example.com/team/app/-/issues/3', mine: true, closed: false, data: { labels: ['bug', 'eregion:plan'], assignee: 'joel' } })
    const list = calls.find((call) => call.path.includes('/issues?'))
    expect(list?.path).toBe('/projects/team%2Fapp/issues?state=opened&per_page=100&assignee_id=7&labels=bug&not%5Blabels%5D=wontfix')
    expect(list?.token).toBe('glpat-1')
  })

  it('swaps the stage label, and closes the issue with a note when the ticket is done', async () => {
    const { connections, connection, calls, fetchImpl } = await connected((method, path) => (method === 'GET' && path.endsWith('/issues/3') ? rawIssue(3) : {}))
    const project = { id: 1, name: 'App', linear: {}, repos: [], source: { kind: 'gitlab-issues', connectionId: connection.id, location: 'team/app' } } as unknown as Project
    const source = new GitLabIssuesSource(connections, fetchImpl)
    const ticket = { linearId: 'team/app#3' } as never
    await source.hooks.stageEntered?.(ticket, { id: 'build' } as never, project)
    await source.hooks.ticketDone?.(ticket, project)
    expect(calls.filter((call) => call.method !== 'GET').map((call) => [call.method, call.path, call.body])).toEqual([
      ['PUT', '/projects/team%2Fapp/issues/3', { add_labels: 'eregion:build', remove_labels: 'eregion:plan' }],
      ['POST', '/projects/team%2Fapp/issues/3/notes', { body: 'Done in Eregion: the merge requests merged.' }],
      ['PUT', '/projects/team%2Fapp/issues/3', { remove_labels: 'eregion:plan', state_event: 'close' }]
    ])
  })
})

describe('GitLab as a code host', () => {
  const runner = { exec: async (): Promise<ExecResult> => ({ code: 0, stdout: 'git@gitlab.example.com:team/app.git\n', stderr: '' }) } as unknown as Runner

  it('opens a draft merge request in the repo the remote points at, and reads it back', async () => {
    const { connections, calls, fetchImpl } = await connected((method) =>
      method === 'POST'
        ? { web_url: 'https://gitlab.example.com/team/app/-/merge_requests/9' }
        : { id: 900, iid: 9, web_url: 'https://gitlab.example.com/team/app/-/merge_requests/9', title: 'Draft: GL-3: Hints', state: 'opened', target_branch: 'main', source_branch: 'gl-3-hints', sha: 'abc', changes_count: '4', merged_at: null }
    )
    const host = new GitLabHost(connections, fetchImpl)
    const url = await host.createPr(runner, '/work/app', { base: 'main', branch: 'gl-3-hints', title: 'GL-3: Hints', body: 'Body', draft: true })
    expect(url).toBe('https://gitlab.example.com/team/app/-/merge_requests/9')
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ source_branch: 'gl-3-hints', target_branch: 'main', title: 'Draft: GL-3: Hints', description: 'Body' })
    expect(await host.viewPr(runner, '/work/app', url)).toMatchObject({ number: 9, title: 'GL-3: Hints', draft: true, state: 'open', base: 'main', branch: 'gl-3-hints', headSha: 'abc', changedFiles: 4 })
  })

  it("reads the latest pipeline's jobs as checks, retries a job and fetches its log", async () => {
    const { connections, calls, fetchImpl } = await connected((_method, path) => {
      if (path.endsWith('/merge_requests/9/pipelines')) return [{ id: 55 }, { id: 50 }]
      if (path.includes('/pipelines/55/jobs')) return [{ name: 'tests', stage: 'test', status: 'failed', allow_failure: false, web_url: 'https://gitlab.example.com/team/app/-/jobs/91' }, { name: 'lint', stage: 'test', status: 'failed', allow_failure: true, web_url: 'https://gitlab.example.com/team/app/-/jobs/92' }]
      if (path.endsWith('/trace')) return 'Running tests\nFAILED tests/HintTest.php\n'
      return {}
    })
    const host = new GitLabHost(connections, fetchImpl)
    const { checks, scope } = await host.checks(runner, '/w', 'https://gitlab.example.com/team/app/-/merge_requests/9')
    expect(scope).toBe('all')
    expect(checks.map((check) => [check.name, check.bucket])).toEqual([
      ['tests', 'fail'],
      ['lint', 'skipping']
    ])
    await host.rerunFailed(runner, '/w', checks[0])
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/projects/team%2Fapp/jobs/91/retry' })
    expect(await host.failedLog(runner, '/w', checks[0])).toContain('FAILED tests/HintTest.php')
  })

  it('sends GitLab URLs and repos to GitLab, and everything else to GitHub', async () => {
    const { connections, fetchImpl } = await connected(() => ({}))
    const used: string[] = []
    const github = { viewPr: async () => used.push('github'), createPr: async () => used.push('github create') } as unknown as GitHub
    const gitlab = new GitLabHost(connections, fetchImpl)
    const hosts = new CodeHosts(github, gitlab)
    await hosts.viewPr(runner, '/w', 'https://github.com/me/app/pull/3')
    const noRemote = { exec: async (): Promise<ExecResult> => ({ code: 0, stdout: 'git@github.com:me/app.git\n', stderr: '' }) } as unknown as Runner
    await hosts.createPr(noRemote, '/w', { base: 'main', branch: 'b', title: 't', body: '', draft: false })
    expect(used).toEqual(['github', 'github create'])
    expect(gitlab.handles('https://gitlab.example.com/team/app/-/merge_requests/9')).toBe(true)
  })
})

describe('GitLab parsing', () => {
  it('reads remotes and merge request URLs, and maps job statuses', () => {
    expect(parseRemote('https://oauth2:x@gitlab.example.com/team/sub/app.git')).toEqual({ host: 'gitlab.example.com', path: 'team/sub/app' })
    expect(parseRemote('git@gitlab.com:team/app.git')).toEqual({ host: 'gitlab.com', path: 'team/app' })
    expect(parseMrUrl('https://gitlab.com/team/app/-/merge_requests/12')).toEqual({ host: 'gitlab.com', path: 'team/app', iid: 12 })
    expect(['success', 'failed', 'running', 'manual', 'canceled'].map((status) => jobBucket(status, false))).toEqual(['pass', 'fail', 'pending', 'skipping', 'cancel'])
  })
})
