import type { Project } from '@shared/model'
import { DEFAULT_SOURCE_PUSH, importRules, labelsMatch, sourceOf, STAGE_LABEL_PREFIX, stageLabel } from '@shared/sources'
import type { RunnerFor } from '../runner/types'
import type { SourceIssue, TicketSource } from './sources'

const FIELDS = 'number,title,body,url,state,labels,assignees,comments'

interface RawIssue {
  number: number
  title: string
  body: string
  url: string
  state: string
  labels: { name: string }[]
  assignees: { login: string }[]
  comments?: { author?: { login?: string }; body: string; createdAt: string }[]
}

/** The issue number in GH-12, #12, 12, or an issue URL. */
export function issueNumber(key: string): number {
  const match = key.trim().match(/(?:^GH-|^#|\/issues\/|^)(\d+)$/i)
  if (!match) throw new Error(`${key} isn't a GitHub issue: use its number, like GH-12 or #12`)
  return Number(match[1])
}

/**
 * GitHub Issues as a ticket source, through gh signed in as you in the repos' runtime. Tickets are GH-12;
 * while one is in a stage its issue carries that stage's eregion: label, and it's closed when the ticket is done.
 */
export class GitHubIssuesSource implements TicketSource {
  readonly kind = 'github-issues' as const
  private readonly logins = new Map<string, Promise<string>>()
  private readonly madeLabels = new Set<string>()

  constructor(private readonly runnerFor: RunnerFor) {}

  /** The repo the project's issues are in: the one set in its Tickets and code step, or its first GitHub repo. */
  repo(project: Project): string | null {
    return sourceOf(project).location?.trim() || project.repos.find((repo) => repo.githubRepo)?.githubRepo || null
  }

  location(project: Project): string | null {
    return this.repo(project)
  }

  notReady(project: Project): string | null {
    if (project.repos.length === 0) return `${project.name} has no repos yet`
    if (!this.repo(project)) return `Choose the GitHub repo ${project.name}'s issues are in, in its Tickets and code step`
    return null
  }

  private async gh(project: Project, args: string[], input?: string): Promise<string> {
    const [first] = project.repos
    const result = await this.runnerFor(first.runtime, project).exec(['gh', ...args], { cwd: first.path, input, timeoutMs: 60_000 })
    if (result.code !== 0) throw new Error(`GitHub: ${(result.stderr || result.stdout).trim() || `gh ${args.slice(0, 2).join(' ')} failed`}`)
    return result.stdout
  }

  /** Your GitHub login in the repos' runtime: the project's account, or gh's active one. */
  private me(project: Project): Promise<string> {
    const key = `${project.repos[0].runtime}:${project.github?.account ?? ''}`
    if (!this.logins.has(key)) {
      const login = this.gh(project, ['api', 'user', '--jq', '.login']).then((out) => out.trim())
      login.catch(() => this.logins.delete(key))
      this.logins.set(key, login)
    }
    return this.logins.get(key) as Promise<string>
  }

  private toIssue(raw: RawIssue, repo: string, me: string): SourceIssue {
    const assignees = raw.assignees.map((person) => person.login)
    return {
      id: `${repo}#${raw.number}`,
      key: `GH-${raw.number}`,
      title: raw.title,
      description: raw.body ?? '',
      url: raw.url,
      data: {
        state: raw.state === 'CLOSED' ? 'Closed' : 'Open',
        labels: raw.labels.map((label) => label.name),
        comments: (raw.comments ?? []).map((comment) => ({ author: comment.author?.login ?? 'someone', body: comment.body, createdAt: comment.createdAt })),
        assignee: assignees[0] ?? null,
        assigneeId: assignees[0] ?? null
      },
      closed: raw.state === 'CLOSED',
      mine: assignees.includes(me)
    }
  }

  async candidates(project: Project): Promise<SourceIssue[]> {
    const repo = this.repo(project) as string
    const rules = importRules(sourceOf(project))
    const me = await this.me(project)
    const list = async (assignee?: string): Promise<RawIssue[]> =>
      JSON.parse(await this.gh(project, ['issue', 'list', '-R', repo, '--state', 'open', '--limit', '200', '--json', FIELDS, ...(assignee ? ['--assignee', assignee] : [])])) as RawIssue[]
    const raw = rules.who === 'me' ? await list('@me') : rules.who === 'people' ? (await Promise.all(rules.people.map((person) => list(person.id)))).flat() : await list()
    const unique = [...new Map(raw.map((issue) => [issue.number, issue])).values()]
    return unique.map((issue) => this.toIssue(issue, repo, me)).filter((issue) => labelsMatch(issue.data.labels ?? [], rules))
  }

  private async view(project: Project, repo: string, number: number): Promise<SourceIssue> {
    const raw = JSON.parse(await this.gh(project, ['issue', 'view', String(number), '-R', repo, '--json', FIELDS])) as RawIssue
    return this.toIssue(raw, repo, await this.me(project))
  }

  async byIds(project: Project, ids: string[]): Promise<SourceIssue[]> {
    const found = await Promise.all(
      ids.map(async (id) => {
        const [repo, number] = id.split('#')
        return this.view(project, repo, Number(number)).catch(() => null)
      })
    )
    return found.filter((issue): issue is SourceIssue => issue !== null)
  }

  async byKey(project: Project, key: string): Promise<SourceIssue> {
    return this.view(project, this.repo(project) as string, issueNumber(key))
  }

  wanted(project: Project, issue: SourceIssue): boolean {
    const rules = importRules(sourceOf(project))
    if (rules.who === 'everyone') return true
    if (rules.who === 'me') return issue.mine
    return rules.people.some((person) => person.id === issue.data.assigneeId)
  }

  async create(project: Project, input: { title: string; description: string }): Promise<SourceIssue> {
    const out = await this.gh(project, ['issue', 'create', '-R', this.repo(project) as string, '--title', input.title, '--body-file', '-', '--assignee', '@me'], input.description)
    const url = out.trim().split('\n').reverse().find((line) => line.includes('/issues/'))
    if (!url) throw new Error(`gh didn't print the new issue's URL: ${out.trim()}`)
    return this.byKey(project, url.trim())
  }

  /** Makes a stage label once per repo per session; --force leaves an existing one as it is. */
  private async ensureLabel(project: Project, repo: string, label: string): Promise<void> {
    if (this.madeLabels.has(`${repo}:${label}`)) return
    await this.gh(project, ['label', 'create', label, '-R', repo, '--color', '0B6594', '--description', 'Eregion: the ticket is in this stage', '--force'])
    this.madeLabels.add(`${repo}:${label}`)
  }

  /** Swaps the issue's eregion: label for `next` (none when it's done). */
  private async relabel(project: Project, ticketId: string, next: string | null): Promise<{ repo: string; number: number }> {
    const [repo, numberText] = ticketId.split('#')
    const number = Number(numberText)
    const current = JSON.parse(await this.gh(project, ['issue', 'view', String(number), '-R', repo, '--json', 'labels'])) as { labels: { name: string }[] }
    const stale = current.labels.map((label) => label.name).filter((name) => name.startsWith(STAGE_LABEL_PREFIX) && name !== next)
    if (next) await this.ensureLabel(project, repo, next)
    if (next || stale.length > 0) {
      await this.gh(project, ['issue', 'edit', String(number), '-R', repo, ...(next ? ['--add-label', next] : []), ...(stale.length ? ['--remove-label', stale.join(',')] : [])])
    }
    return { repo, number }
  }

  readonly hooks: TicketSource['hooks'] = {
    stageEntered: async (ticket, stage, project) => {
      await this.relabel(project, ticket.linearId as string, stageLabel(stage.id))
    },
    ticketDone: async (ticket, project) => {
      const { repo, number } = await this.relabel(project, ticket.linearId as string, null)
      await this.gh(project, ['issue', 'close', String(number), '-R', repo, '--comment', 'Done in Eregion: the pull requests merged.'])
    },
    planApproved: async (ticket, markdown, project) => {
      if (!{ ...DEFAULT_SOURCE_PUSH, ...sourceOf(project).push }.planComment) return
      const [repo, number] = (ticket.linearId as string).split('#')
      await this.gh(project, ['issue', 'comment', number, '-R', repo, '--body-file', '-'], `**Plan approved in Eregion**\n\n${markdown.trim()}`)
    },
    prsOpened: async (ticket, prs, project) => {
      if (!{ ...DEFAULT_SOURCE_PUSH, ...sourceOf(project).push }.prLinks || prs.length === 0) return
      const [repo, number] = (ticket.linearId as string).split('#')
      await this.gh(project, ['issue', 'comment', number, '-R', repo, '--body-file', '-'], `Pull requests from Eregion:\n\n${prs.map((pr) => `- ${pr.url} (${pr.title})`).join('\n')}`)
    }
  }
}
