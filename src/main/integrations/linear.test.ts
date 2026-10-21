import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { LinearIssue } from '@shared/integrations'
import type { Ticket } from '@shared/tickets'
import { openDatabase } from '../db'
import { TicketStore } from '../pipeline/stores'
import { ProjectStore } from '../projects/store'
import { descriptionWithPlan, PLAN_MARKER } from './hooks'
import { LinearAuthError, LinearClient, type FetchLike } from './linear'
import { authorizeUrl, LinearAuth, pkcePair, PLAIN_CODEC } from './linearAuth'
import { linearAssignees, LinearSource } from './linearSource'
import { IssueSync } from './sources'
import { Connections } from './connections'

interface Call {
  url: string
  headers: Record<string, string>
  body: string
}

function issue(identifier: string, overrides: Partial<LinearIssue> = {}): Record<string, unknown> {
  const base = {
    id: `id-${identifier}`,
    identifier,
    title: `Title ${identifier}`,
    description: `Description ${identifier}`,
    url: `https://linear.app/wm/issue/${identifier}`,
    priorityLabel: 'High',
    estimate: 2,
    updatedAt: '2026-10-19T10:00:00Z',
    state: { id: 's-backlog', name: 'Backlog', type: 'backlog' },
    assignee: { id: 'u-joel', name: 'Joel' },
    ...overrides
  }
  return { ...base, labels: { nodes: [{ name: 'Bug' }] }, comments: { nodes: [{ body: 'Please', createdAt: '2026-10-18T10:00:00Z', user: { name: 'Sam' } }] } }
}

/** A Linear stand-in that answers by query text, and records every call. */
function fakeLinear(handlers: { assigned?: () => unknown[]; byId?: (ids: string[]) => unknown[] } = {}) {
  const calls: Call[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body })
    const respond = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })
    if (url.endsWith('/oauth/token')) {
      const params = new URLSearchParams(init.body)
      if (params.get('grant_type') === 'authorization_code') return respond(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 86_400 })
      return respond(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 86_400 })
    }
    if (init.headers.authorization === 'Bearer bad') return respond(401, {})
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> }
    if (query.includes('viewer')) return respond(200, { data: { viewer: { id: 'u-joel', name: 'Joel', email: 'joel@example.com', organization: { name: 'Word Magic' } } } })
    if (query.includes('issues(filter: $filter')) return respond(200, { data: { issues: { nodes: handlers.assigned?.() ?? [], pageInfo: { hasNextPage: false, endCursor: null } } } })
    if (query.includes('id: { in: $ids }')) return respond(200, { data: { issues: { nodes: handlers.byId?.(variables.ids as string[]) ?? [] } } })
    if (query.includes('commentCreate') || query.includes('issueUpdate') || query.includes('attachmentLinkURL')) return respond(200, { data: { ok: { success: true } } })
    return respond(200, { errors: [{ message: `Unexpected query: ${query.slice(0, 40)}` }] })
  }
  return { calls, fetchImpl }
}

describe('LinearClient', () => {
  it('sends an API key as is and an OAuth token as a bearer token', async () => {
    const linear = fakeLinear()
    await new LinearClient({ kind: 'api-key', key: 'lin_api_1' }, linear.fetchImpl).viewer()
    await new LinearClient({ kind: 'oauth', token: async () => 'tok' }, linear.fetchImpl).viewer()
    expect(linear.calls.map((call) => call.headers.authorization)).toEqual(['lin_api_1', 'Bearer tok'])
  })

  it('asks for my issues in the team and state types', async () => {
    const linear = fakeLinear({ assigned: () => [issue('WM-5')] })
    const issues = await new LinearClient({ kind: 'api-key', key: 'k' }, linear.fetchImpl).assignedIssues({ teamId: 't1', assigneeIds: 'me', stateTypes: ['backlog', 'unstarted'] })
    expect(issues[0]).toMatchObject({ identifier: 'WM-5', labels: ['Bug'], comments: [{ author: 'Sam', body: 'Please' }] })
    expect(JSON.parse(linear.calls[0].body).variables.filter).toEqual({ team: { id: { eq: 't1' } }, assignee: { isMe: { eq: true } }, state: { type: { in: ['backlog', 'unstarted'] } } })
  })

  it('turns a 401 into a sign-in error', async () => {
    const linear = fakeLinear()
    await expect(new LinearClient({ kind: 'oauth', token: async () => 'bad' }, linear.fetchImpl).viewer()).rejects.toBeInstanceOf(LinearAuthError)
  })
})

describe('LinearAuth', () => {
  it('makes an S256 challenge from the verifier', () => {
    const { verifier, challenge } = pkcePair()
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'))
    const url = new URL(authorizeUrl({ clientId: 'c1', redirectUri: 'http://127.0.0.1:47321/oauth/callback', state: 's', challenge }))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: 'c1', response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, scope: 'read,write' })
  })

  it('signs in through the loopback redirect with PKCE and no client secret, then refreshes', async () => {
    const linear = fakeLinear()
    const auth = new LinearAuth(openDatabase(':memory:'), PLAIN_CODEC, linear.fetchImpl)
    auth.setClientId('client-1')
    const viewer = await auth.signIn(async (url) => {
      // Stands in for the browser: Linear redirects back to Eregion with a code.
      const params = new URL(url).searchParams
      const response = await fetch(`${params.get('redirect_uri')}?code=the-code&state=${params.get('state')}`)
      expect(await response.text()).toContain('Linear is connected')
    })
    expect(viewer.name).toBe('Joel')
    expect(auth.method()).toBe('oauth')
    const exchange = new URLSearchParams(linear.calls.find((call) => call.url.endsWith('/oauth/token'))?.body)
    expect(exchange.get('code')).toBe('the-code')
    expect(exchange.get('code_verifier')).toBeTruthy()
    expect(exchange.has('client_secret')).toBe(false)
    expect(await auth.accessToken()).toBe('access-1')
  })

  it('refuses a callback that does not match the sign-in', async () => {
    const auth = new LinearAuth(openDatabase(':memory:'), PLAIN_CODEC, fakeLinear().fetchImpl)
    auth.setClientId('client-1')
    await expect(
      auth.signIn(async (url) => {
        const params = new URL(url).searchParams
        await fetch(`${params.get('redirect_uri')}?code=x&state=forged`)
      })
    ).rejects.toThrow("didn't match")
    expect(auth.method()).toBeNull()
  })

  it('only takes something that looks like a personal API key', async () => {
    const auth = new LinearAuth(openDatabase(':memory:'), PLAIN_CODEC, fakeLinear().fetchImpl)
    await expect(auth.useApiKey('nope')).rejects.toThrow('lin_api_')
    expect((await auth.useApiKey('lin_api_abc')).email).toBe('joel@example.com')
    expect(auth.method()).toBe('api-key')
  })
})

describe('Linear through IssueSync', () => {
  async function setup(handlers: Parameters<typeof fakeLinear>[0]) {
    const db = openDatabase(':memory:')
    const linear = fakeLinear(handlers)
    const auth = new LinearAuth(db, PLAIN_CODEC, linear.fetchImpl)
    await auth.useApiKey('lin_api_abc')
    const projects = new ProjectStore(db)
    const tickets = new TicketStore(db)
    const project = projects.update(projects.create('Word Magic').id, { linear: { teamId: 'team-wm', teamKey: 'WM' } })
    const notices: string[] = []
    const changed: Ticket[] = []
    const sync = new IssueSync(db, [new LinearSource(auth)], projects, tickets, { ticketChanged: (ticket) => changed.push(ticket), ticketRemoved: () => undefined, notify: (title) => notices.push(title), statusChanged: () => undefined })
    return { sync, tickets, projects, project, notices, changed, linear, auth }
  }

  it('imports issues assigned to me as new Backlog tickets, once', async () => {
    const { sync, tickets, project, notices } = await setup({ assigned: () => [issue('WM-5')] })
    expect((await sync.syncProject(project)).imported).toEqual(['WM-5'])
    expect((await sync.syncProject(project)).imported).toEqual([])
    const [ticket] = tickets.list(project.id)
    expect(ticket).toMatchObject({ key: 'WM-5', linearId: 'id-WM-5', stage: 'backlog', url: 'https://linear.app/wm/issue/WM-5' })
    expect(ticket.linear).toMatchObject({ isNew: true, priority: 'High', labels: ['Bug'], state: 'Backlog' })
    expect(notices).toEqual(['WM-5 assigned to you'])
  })

  it('removes a Backlog ticket assigned away, and flags one already being worked on', async () => {
    let assigned = [issue('WM-5'), issue('WM-6')]
    const { sync, tickets, project } = await setup({ assigned: () => assigned, byId: (ids) => ids.map((id) => issue(id.replace('id-', ''), { assignee: { id: 'u-sam', name: 'Sam' } })) })
    await sync.syncProject(project)
    const started = tickets.findByKey(project.id, 'WM-6') as Ticket
    tickets.update(started.id, { stage: 'build' })
    assigned = []
    const result = await sync.syncProject(project)
    expect(result.removed).toEqual(['WM-5'])
    expect(result.flagged).toEqual(['WM-6'])
    expect(tickets.findByKey(project.id, 'WM-5')).toBeNull()
    expect(tickets.get(started.id).linear).toMatchObject({ reassigned: true, assignee: 'Sam' })
  })

  it("imports everyone's issues when asked, without an assignee filter, keeping only those with the project's labels", async () => {
    const { sync, tickets, projects, project, linear, auth, notices } = await setup({
      assigned: () => [issue('WM-7', { assignee: { id: 'u-sam', name: 'Sam' } }), { ...issue('WM-8', { assignee: null }), labels: { nodes: [{ name: 'Bug' }, { name: 'Wontfix' }] } }]
    })
    auth.setImportAssignees({ mode: 'everyone' })
    const labelled = projects.update(project.id, { source: { kind: 'linear', rules: { who: 'everyone', people: [], labels: ['bug'], excludeLabels: ['wontfix'] } } })
    expect((await sync.syncProject(labelled)).imported).toEqual(['WM-7'])
    const query = JSON.parse(linear.calls.at(-1)?.body ?? '{}') as { variables: { filter: Record<string, unknown> } }
    expect(query.variables.filter).not.toHaveProperty('assignee')
    expect(notices).toEqual(['WM-7 assigned to Sam'])
    expect(tickets.findByKey(project.id, 'WM-7')?.linear).toMatchObject({ assignee: 'Sam', assigneeId: 'u-sam' })
  })

  it("reads another workspace through its connection's API key, with the project's own choice of whose issues", async () => {
    const db = openDatabase(':memory:')
    const linear = fakeLinear({ assigned: () => [issue('OPS-3', { assignee: { id: 'u-ana', name: 'Ana' } })] })
    const auth = new LinearAuth(db, PLAIN_CODEC, linear.fetchImpl)
    const connections = new Connections(db, PLAIN_CODEC, { jira: async () => '', gitlab: async () => '', linear: async () => 'Joel (Ops)' })
    const connection = await connections.save({ kind: 'linear', name: 'Ops workspace', url: '', token: 'lin_api_ops' })
    const projects = new ProjectStore(db)
    const tickets = new TicketStore(db)
    const project = projects.update(projects.create('Ops').id, { linear: { teamId: 'team-ops', teamKey: 'OPS' }, source: { kind: 'linear', connectionId: connection.id, rules: { who: 'everyone', people: [], labels: [], excludeLabels: [] } } })
    const sync = new IssueSync(db, [new LinearSource(auth, connections, linear.fetchImpl)], projects, tickets, { ticketChanged: () => undefined, ticketRemoved: () => undefined, notify: () => undefined, statusChanged: () => undefined })
    expect((await sync.syncProject(project)).imported).toEqual(['OPS-3'])
    const search = linear.calls.find((call) => call.body.includes('issues(filter: $filter'))
    expect(search?.headers.authorization).toBe('lin_api_ops')
    expect((JSON.parse(search?.body ?? '{}') as { variables: { filter: Record<string, unknown> } }).variables.filter).not.toHaveProperty('assignee')
    expect(connection.url).toBe('https://linear.app')
  })

  it("won't import over a ticket made in Eregion with the same key", async () => {
    const { sync, tickets, project } = await setup({ assigned: () => [issue('WM-1')] })
    tickets.create({ projectId: project.id, key: 'WM-1', title: 'Local' })
    expect((await sync.syncProject(project)).imported).toEqual([])
    expect(tickets.list(project.id)).toHaveLength(1)
  })
})

describe('Linear hooks', () => {
  it('replaces an earlier plan in the description instead of stacking them', () => {
    const once = descriptionWithPlan('Players get stuck.', '# Plan A')
    const twice = descriptionWithPlan(once, '# Plan B')
    expect(twice).toBe(`Players get stuck.\n\n${PLAN_MARKER}\n---\n\n# Plan B\n`)
  })

  it('comments the plan, sets the status per stage and attaches PRs', async () => {
    const db = openDatabase(':memory:')
    const linear = fakeLinear()
    const auth = new LinearAuth(db, PLAIN_CODEC, linear.fetchImpl)
    await auth.useApiKey('lin_api_abc')
    const projects = new ProjectStore(db)
    const project = projects.update(projects.create('Word Magic').id, { linear: { teamId: 't', statusByStage: { build: 'state-in-progress' }, push: { planComment: true, planDescription: true, prLinks: true } } })
    const tickets = new TicketStore(db)
    const ticket = tickets.create({ projectId: project.id, key: 'WM-5', title: 'Hints', description: 'Stuck.', linearId: 'id-WM-5' })
    const { hooks } = new LinearSource(auth)
    const before = linear.calls.length
    await hooks.planApproved?.(ticket, '# Plan', project)
    await hooks.stageEntered?.(ticket, { id: 'build' } as never, project)
    await hooks.stageEntered?.(ticket, { id: 'review' } as never, project)
    await hooks.prsOpened?.(ticket, [{ repo: 'app', number: 3, url: 'https://github.com/me/app/pull/3', title: 'WM-5: Hints' }], project)
    const sent = linear.calls.slice(before).map((call) => JSON.parse(call.body) as { query: string; variables: Record<string, unknown> })
    expect(sent.map((call) => call.query.match(/(commentCreate|issueUpdate|attachmentLinkURL)/)?.[1])).toEqual(['commentCreate', 'issueUpdate', 'issueUpdate', 'attachmentLinkURL'])
    expect(sent[2].variables).toEqual({ id: 'id-WM-5', input: { stateId: 'state-in-progress' } })
    expect(sent[3].variables).toMatchObject({ url: 'https://github.com/me/app/pull/3', title: 'app #3: WM-5: Hints' })
  })
})

describe('linearAssignees', () => {
  const project = (source: object | null) => ({ source, linear: { teamId: 'team-wm' } }) as unknown as Parameters<typeof linearAssignees>[0]
  const settings = () => ({ mode: 'everyone' }) as const

  it("uses the project's own choice", () => {
    expect(linearAssignees(project({ kind: 'linear', rules: { who: 'people', people: [{ id: 'u1', name: 'Sam' }] } }), settings)).toEqual({ mode: 'people', people: [{ id: 'u1', name: 'Sam' }] })
    expect(linearAssignees(project({ kind: 'linear', rules: { who: 'me' } }), settings)).toEqual({ mode: 'me' })
  })

  it('keeps the choice Settings used to make for projects on the main account that never chose', () => {
    expect(linearAssignees(project(null), settings)).toEqual({ mode: 'everyone' })
    expect(linearAssignees(project({ kind: 'linear', rules: { labels: ['bug'] } }), settings)).toEqual({ mode: 'everyone' })
  })

  it('imports your own issues through a connection that never chose', () => {
    expect(linearAssignees(project({ kind: 'linear', connectionId: 'work' }), settings)).toEqual({ mode: 'me' })
  })
})
