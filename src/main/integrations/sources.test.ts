import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/model'
import { openDatabase } from '../db'
import { TicketStore } from '../pipeline/stores'
import { ProjectStore } from '../projects/store'
import { IssueSync, sourceIntegrations, type SourceIssue, type TicketSource } from './sources'

/** A tracker stand-in: its open issues are whatever \`issues\` holds; it records the hooks it's called with. */
function fakeSource(kind: TicketSource['kind'], issues: () => SourceIssue[]) {
  const hooked: string[] = []
  const source: TicketSource = {
    kind,
    location: () => 'somewhere',
    notReady: () => null,
    candidates: async () => issues(),
    byIds: async () => [],
    byKey: async (_project, key) => {
      const found = issues().find((issue) => issue.key === key)
      if (!found) throw new Error('not found')
      return found
    },
    wanted: (_project, issue) => issue.mine,
    hooks: { stageEntered: async (ticket) => void hooked.push(`${kind} ${ticket.key}`) }
  }
  return { source, hooked }
}

const issue = (key: string): SourceIssue => ({ id: `id-${key}`, key, title: key, description: '', url: '', data: { assignee: 'Joel', assigneeId: 'joel' }, closed: false, mine: true })

describe('IssueSync across trackers', () => {
  it("leaves a project's old tickets alone after it switches trackers, and only hooks into its current one", async () => {
    const db = openDatabase(':memory:')
    const projects = new ProjectStore(db)
    const tickets = new TicketStore(db)
    let linearIssues = [issue('WM-1'), issue('WM-2')]
    const linear = fakeSource('linear', () => linearIssues)
    const github = fakeSource('github-issues', () => [issue('GH-7')])
    const sync = new IssueSync(db, [linear.source, github.source], projects, tickets, { ticketChanged: () => undefined, ticketRemoved: () => undefined, notify: () => undefined, statusChanged: () => undefined })
    let project: Project = projects.update(projects.create('Word Magic').id, { source: { kind: 'linear' } })

    await sync.syncProject(project)
    const working = tickets.findByKey(project.id, 'WM-2')
    tickets.update(working?.id as number, { stage: 'build' })
    expect(tickets.findByKey(project.id, 'WM-1')?.linear.source).toBe('linear')

    project = projects.update(project.id, { source: { kind: 'github-issues' } })
    linearIssues = []
    expect(await sync.syncProject(project)).toEqual({ imported: ['GH-7'], refreshed: 0, removed: [], flagged: [] })
    expect(tickets.list(project.id).map((ticket) => [ticket.key, ticket.linear.reassigned ?? false]).sort()).toEqual([
      ['GH-7', false],
      ['WM-1', false],
      ['WM-2', false]
    ])

    const hooks = sourceIntegrations(sync, () => undefined)
    for (const key of ['WM-2', 'GH-7']) await hooks.stageEntered?.(tickets.findByKey(project.id, key) as never, { id: 'build' } as never, project)
    expect([...linear.hooked, ...github.hooked]).toEqual(['github-issues GH-7'])
    await expect(sync.pullAgain(tickets.findByKey(project.id, 'WM-1') as never)).rejects.toThrow("WM-1 didn't come from GitHub Issues")
  })
})
