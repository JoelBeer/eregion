import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/model'
import { DEFAULT_IMPORT_RULES } from '@shared/sources'
import { openDatabase } from '../db'
import { Connections } from './connections'
import { adfToText, importJql, JiraSource, textToAdf } from './jira'
import type { FetchLike } from './linear'
import { PLAIN_CODEC } from './linearAuth'

const raw = (key: string, extra: Record<string, unknown> = {}) => ({
  id: key === 'SHOP-1' ? '10001' : '10002',
  key,
  fields: {
    summary: `Summary ${key}`,
    description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Players get ' }, { type: 'text', text: 'stuck.' }] }] },
    status: { name: 'To Do', statusCategory: { key: 'new' } },
    labels: ['bug'],
    priority: { name: 'High' },
    assignee: { accountId: 'acc-joel', displayName: 'Joel' },
    comment: { comments: [{ author: { displayName: 'Sam' }, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Please' }] }] }, created: '2026-10-20T10:00:00.000+0000' }] },
    ...extra
  }
})

/** A Jira stand-in that answers by path and method, and records every call. */
function fakeJira() {
  const calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method: init.method, url, headers: init.headers, body })
    const respond = (status: number, value: unknown) => ({ ok: status < 400, status, json: async () => value, text: async () => (value === undefined ? '' : JSON.stringify(value)) })
    const path = url.replace('https://shop.atlassian.net', '')
    if (path === '/rest/api/3/myself') return respond(200, { accountId: 'acc-joel', displayName: 'Joel' })
    if (path === '/rest/api/3/search/jql') return respond(200, { issues: [raw('SHOP-1')] })
    if (path.startsWith('/rest/api/3/issue/SHOP-1/transitions') && init.method === 'GET') return respond(200, { transitions: [{ id: '21', name: 'Start', to: { name: 'In Progress' } }, { id: '31', name: 'Finish', to: { name: 'Done' } }] })
    if (path.startsWith('/rest/api/3/issue/SHOP-1?')) return respond(200, raw('SHOP-1'))
    return respond(init.method === 'POST' ? 201 : 204, undefined)
  }
  return { calls, fetchImpl }
}

async function setup() {
  const db = openDatabase(':memory:')
  const jira = fakeJira()
  const connections = new Connections(db, PLAIN_CODEC, { jira: async () => 'Joel', gitlab: async () => 'joel' })
  const connection = await connections.save({ kind: 'jira', name: 'Shop', url: 'https://shop.atlassian.net/', email: 'joel@example.com', token: 'tok' })
  const project = {
    id: 1,
    name: 'Shop',
    linear: {},
    source: { kind: 'jira', connectionId: connection.id, location: 'SHOP', rules: { ...DEFAULT_IMPORT_RULES, labels: ['bug'] }, statusByStage: { build: 'In Progress', done: 'Done' } },
    repos: []
  } as unknown as Project
  return { source: new JiraSource(connections, jira.fetchImpl), calls: jira.calls, project, connections, connection }
}

describe('JiraSource', () => {
  it('searches the project for To Do issues assigned to you with its labels, signed in with your email and token', async () => {
    const { source, calls, project } = await setup()
    const [issue] = await source.candidates(project)
    expect(issue).toEqual({
      id: '10001',
      key: 'SHOP-1',
      title: 'Summary SHOP-1',
      description: 'Players get stuck.',
      url: 'https://shop.atlassian.net/browse/SHOP-1',
      data: { state: 'To Do', priority: 'High', labels: ['bug'], comments: [{ author: 'Sam', body: 'Please', createdAt: '2026-10-20T10:00:00.000+0000' }], assignee: 'Joel', assigneeId: 'acc-joel' },
      closed: false,
      mine: true
    })
    const search = calls.find((call) => call.url.endsWith('/search/jql'))
    expect(search?.body).toMatchObject({ jql: 'project = "SHOP" AND statusCategory = "To Do" AND assignee = currentUser() AND labels = "bug" ORDER BY updated DESC' })
    expect(search?.headers.authorization).toBe(`Basic ${Buffer.from('joel@example.com:tok').toString('base64')}`)
  })

  it('moves the issue to the status set for each stage, comments the plan and links the pull requests', async () => {
    const { source, calls, project } = await setup()
    const ticket = { key: 'SHOP-1', linearId: '10001' } as never
    await source.hooks.stageEntered?.(ticket, { id: 'build' } as never, project)
    await source.hooks.stageEntered?.(ticket, { id: 'review' } as never, project)
    await source.hooks.planApproved?.(ticket, '# Plan\n\nStep one', project)
    await source.hooks.prsOpened?.(ticket, [{ repo: 'shop', number: 4, url: 'https://github.com/me/shop/pull/4', title: 'SHOP-1: Hints' }], project)
    await source.hooks.ticketDone?.(ticket, project)
    const writes = calls.filter((call) => call.method === 'POST').map((call) => [call.url.replace('https://shop.atlassian.net/rest/api/3/issue/SHOP-1', ''), call.body])
    expect(writes).toEqual([
      ['/transitions', { transition: { id: '21' } }],
      ['/comment', { body: textToAdf('Plan approved in Eregion\n\n# Plan\n\nStep one') }],
      ['/remotelink', { object: { url: 'https://github.com/me/shop/pull/4', title: 'shop #4: SHOP-1: Hints' } }],
      ['/transitions', { transition: { id: '31' } }]
    ])
  })

  it("says where a status can't be reached", async () => {
    const { source, project } = await setup()
    const stuck = { ...project, source: { ...project.source, statusByStage: { build: 'Blocked' } } } as Project
    await expect(source.hooks.stageEntered?.({ key: 'SHOP-1' } as never, { id: 'build' } as never, stuck)).rejects.toThrow('SHOP-1 can\'t move to "Blocked" from where it is. It can go to: In Progress, Done')
  })

  it('is not ready until it has a connection and a project key, and keeps the token out of the list', async () => {
    const { source, project, connections } = await setup()
    expect(source.notReady(project)).toBeNull()
    expect(source.notReady({ ...project, source: { kind: 'jira' } } as Project)).toBe("Choose Shop's Jira connection in its Tickets and code step")
    expect(JSON.stringify(connections.list())).not.toContain('tok')
    expect(connections.list()[0]).toMatchObject({ name: 'Shop', url: 'https://shop.atlassian.net', email: 'joel@example.com', account: 'Joel', error: null })
  })
})

describe('Jira text and JQL', () => {
  it('turns rich text into plain text and back', () => {
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] }, { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }] }] }
    expect(adfToText(doc)).toBe('One\ntwo\n\n- a')
    expect(textToAdf('One\ntwo\n\nThree')).toEqual({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }, { type: 'hardBreak' }, { type: 'text', text: 'two' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Three' }] }] })
  })

  it("builds the JQL for everyone's, chosen people's and excluded labels, quoting what you typed", () => {
    expect(importJql('SHOP', { ...DEFAULT_IMPORT_RULES, who: 'everyone', excludeLabels: ['wontfix', 'say "no"'] })).toBe('project = "SHOP" AND statusCategory = "To Do" AND (labels is EMPTY OR labels not in ("wontfix", "say \\"no\\"")) ORDER BY updated DESC')
    expect(importJql('SHOP', { ...DEFAULT_IMPORT_RULES, who: 'people', people: [{ id: 'acc-1', name: 'Sam' }] })).toContain('assignee in ("acc-1")')
  })
})
