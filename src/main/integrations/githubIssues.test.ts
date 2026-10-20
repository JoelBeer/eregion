import { describe, expect, it } from 'vitest'
import type { Project } from '@shared/model'
import type { ExecOptions, ExecResult, Runner } from '../runner/types'
import { GitHubIssuesSource, issueNumber } from './githubIssues'

const project = {
  id: 1,
  name: 'Word Magic',
  linear: {},
  source: { kind: 'github-issues', rules: { who: 'me', people: [], labels: ['bug'], excludeLabels: [] } },
  repos: [{ id: 1, name: 'word-magic', path: '/work/word-magic', runtime: 'wsl:Ubuntu', githubRepo: 'joel/word-magic' }]
} as unknown as Project

const issue = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  body: `Body ${number}`,
  url: `https://github.com/joel/word-magic/issues/${number}`,
  state: 'OPEN',
  labels: [{ name: 'Bug' }],
  assignees: [{ login: 'joel' }],
  comments: [{ author: { login: 'sam' }, body: 'Please', createdAt: '2026-10-20T10:00:00Z' }],
  ...extra
})

/** A gh stand-in that answers by command, and records every call. */
function fakeGh(reply: (args: string[]) => unknown) {
  const calls: { args: string[]; options?: ExecOptions }[] = []
  const runner = {
    exec: async (argv: string[], options?: ExecOptions): Promise<ExecResult> => {
      const args = argv.slice(1)
      calls.push({ args, options })
      if (args[0] === 'api' && args[1] === 'user') return { code: 0, stdout: 'joel\n', stderr: '' }
      const out = reply(args)
      return { code: 0, stdout: typeof out === 'string' ? out : JSON.stringify(out ?? {}), stderr: '' }
    }
  } as unknown as Runner
  return { source: new GitHubIssuesSource(() => runner), calls }
}

describe('GitHubIssuesSource', () => {
  it("lists your open issues in the project's repo, keeping those with its labels, as GH- tickets", async () => {
    const { source, calls } = fakeGh(() => [issue(12), issue(13, { labels: [{ name: 'question' }] })])
    const issues = await source.candidates(project)
    expect(issues).toEqual([
      {
        id: 'joel/word-magic#12',
        key: 'GH-12',
        title: 'Issue 12',
        description: 'Body 12',
        url: 'https://github.com/joel/word-magic/issues/12',
        data: { state: 'Open', labels: ['Bug'], comments: [{ author: 'sam', body: 'Please', createdAt: '2026-10-20T10:00:00Z' }], assignee: 'joel', assigneeId: 'joel' },
        closed: false,
        mine: true
      }
    ])
    expect(calls.at(-1)?.args).toEqual(['issue', 'list', '-R', 'joel/word-magic', '--state', 'open', '--limit', '200', '--json', 'number,title,body,url,state,labels,assignees,comments', '--assignee', '@me'])
    expect(calls.at(-1)?.options).toMatchObject({ cwd: '/work/word-magic' })
  })

  it("lists everyone's open issues without an assignee, and chosen people's one person at a time", async () => {
    const { source, calls } = fakeGh(() => [issue(14, { assignees: [] })])
    const everyone = { ...project, source: { kind: 'github-issues', rules: { who: 'everyone', people: [], labels: [], excludeLabels: [] } } } as Project
    expect((await source.candidates(everyone)).map((item) => [item.key, item.mine, source.wanted(everyone, item)])).toEqual([['GH-14', false, true]])
    expect(calls.at(-1)?.args).not.toContain('--assignee')
    const people = { ...project, source: { kind: 'github-issues', rules: { who: 'people', people: [{ id: 'sam', name: 'sam' }, { id: 'kim', name: 'kim' }], labels: [], excludeLabels: [] } } } as Project
    await source.candidates(people)
    expect(calls.filter((call) => call.args.includes('--assignee')).map((call) => call.args.at(-1))).toEqual(['sam', 'kim'])
  })

  it('swaps the stage label as a ticket moves, making the label once, then closes the issue when it is done', async () => {
    const { source, calls } = fakeGh((args) => (args[0] === 'issue' && args[1] === 'view' ? { labels: [{ name: 'Bug' }, { name: 'eregion:plan' }] } : ''))
    const ticket = { linearId: 'joel/word-magic#12' } as never
    await source.hooks.stageEntered?.(ticket, { id: 'build' } as never, project)
    await source.hooks.stageEntered?.(ticket, { id: 'build' } as never, project)
    await source.hooks.ticketDone?.(ticket, project)
    const writes = calls.filter((call) => !(call.args[0] === 'issue' && call.args[1] === 'view')).map((call) => call.args.join(' '))
    expect(writes).toEqual([
      'label create eregion:build -R joel/word-magic --color 0B6594 --description Eregion: the ticket is in this stage --force',
      'issue edit 12 -R joel/word-magic --add-label eregion:build --remove-label eregion:plan',
      'issue edit 12 -R joel/word-magic --add-label eregion:build --remove-label eregion:plan',
      'issue edit 12 -R joel/word-magic --remove-label eregion:plan',
      'issue close 12 -R joel/word-magic --comment Done in Eregion: the pull requests merged.'
    ])
  })

  it('comments the approved plan and the pull requests', async () => {
    const { source, calls } = fakeGh(() => '')
    const ticket = { linearId: 'joel/word-magic#12' } as never
    await source.hooks.planApproved?.(ticket, '# Plan', project)
    await source.hooks.prsOpened?.(ticket, [{ repo: 'word-magic', number: 3, url: 'https://github.com/joel/word-magic/pull/3', title: 'GH-12: Hints' }], project)
    expect(calls.map((call) => [call.args.slice(0, 4).join(' '), call.options?.input])).toEqual([
      ['issue comment 12 -R', '**Plan approved in Eregion**\n\n# Plan'],
      ['issue comment 12 -R', 'Pull requests from Eregion:\n\n- https://github.com/joel/word-magic/pull/3 (GH-12: Hints)']
    ])
  })

  it('reads an issue number from GH-12, #12, 12 or its URL', () => {
    expect(['GH-12', 'gh-12', '#12', '12', 'https://github.com/joel/word-magic/issues/12'].map(issueNumber)).toEqual([12, 12, 12, 12, 12])
    expect(() => issueNumber('WM-12')).toThrow("isn't a GitHub issue")
  })
})
