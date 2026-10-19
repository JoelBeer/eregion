import type { Repo } from '@shared/model'
import { parsePrDescription } from '@shared/outputs'
import { DEFAULT_CI, type StageConfig } from '@shared/pipeline'
import type { Ticket } from '@shared/tickets'
import type { GitHub } from '../integrations/github'
import type { Runner } from '../runner/types'
import { gitIn, hasOrigin, pushBranch } from '../workspace/git'
import type { PipelineEngine } from './engine'
import type { PrStore, StoredPr } from './prs'

/** The PR body: the description, plus links to the ticket's other PRs under "## Linked". */
export function prBody(body: string, others: { repo: string; number: number; url: string }[]): string {
  if (others.length === 0) return body
  const links = others.map((pr) => `- ${pr.repo} #${pr.number}: ${pr.url}`).join('\n')
  return /^## Linked\s*$/m.test(body) ? body.replace(/^## Linked\s*$/m, (heading) => `${heading}\n${links}`) : `${body}\n\n## Linked\n${links}`
}

interface ChangedRepo {
  repo: Repo
  path: string
  branch: string
}

/**
 * The PR stage: the crew member writes pr-<repo>.md for each changed repo; Eregion pushes, opens
 * the PRs (as drafts if the project says so), links them to each other and to Linear. With drafts
 * the stage waits for you to mark them ready; otherwise it ends as soon as they're open.
 */
export class PrStage {
  constructor(
    private readonly engine: PipelineEngine,
    private readonly prs: PrStore,
    private readonly github: GitHub
  ) {
    engine.registerStage('pr', (ticket, stage, note) => this.run(ticket, stage, note))
  }

  private get deps(): PipelineEngine['deps'] {
    return this.engine.deps
  }

  /** Repos on the ticket branch with commits the base branch doesn't have. */
  private async changedRepos(ticket: Ticket, runner: Runner, environment: NonNullable<Awaited<ReturnType<PipelineEngine['ensureEnvironment']>>>): Promise<ChangedRepo[]> {
    const project = this.engine.project(ticket)
    const changed: ChangedRepo[] = []
    for (const state of environment.repos) {
      if (state.branch === null) continue
      const repo = project.repos.find((item) => item.id === state.repoId)
      if (!repo) continue
      const ahead = Number((await gitIn(runner, state.path, ['rev-list', '--count', `origin/${repo.defaultBranch}..HEAD`]).catch(() => '0')).trim())
      if (ahead > 0) changed.push({ repo, path: state.path, branch: state.branch })
      else this.deps.tickets.log(ticket.id, 'pipeline', `${repo.name} has no commits for this ticket, so it gets no PR`)
    }
    return changed
  }

  private async run(ticket: Ticket, stage: StageConfig, note?: string): Promise<void> {
    const environment = await this.engine.ensureEnvironment(ticket)
    if (!environment) return
    ticket = this.deps.tickets.get(ticket.id)
    const project = this.engine.project(ticket)
    const runner = this.engine.runner(project)
    const changed = await this.changedRepos(ticket, runner, environment)
    if (changed.length === 0) {
      this.engine.stop(ticket, 'stuck', 'No repo has commits for this ticket, so there is nothing to open a PR for')
      return
    }
    const crew = this.engine.crewFor(stage)
    for (const item of changed) await this.engine.removeOutput(ticket, `pr-${item.repo.name}.md`)
    const firstAffected = changed[0].repo
    const prompt = await this.engine.promptFor(ticket, stage, crew, {
      'workspace.repos': this.engine.repoLines(project, this.engine.worktreePaths(environment), (repo) =>
        changed.some((item) => item.repo.id === repo.id) ? 'changes' : 'read-only, no changes for this ticket'
      ),
      'base.ref': `origin/${firstAffected.defaultBranch}`,
      'outputs.plan': (await this.engine.readOutput(ticket, 'plan.md')) ?? '',
      'outputs.build_notes': (await this.engine.readOutput(ticket, 'build-notes.md')) ?? '',
      'outputs.review': (await this.engine.readOutput(ticket, 'review.json')) ?? ''
    })
    const cwd = await this.deps.workspaces.ticketFolder(project, project.repos[0], ticket.key)
    await this.engine.startRun(ticket, stage, { cwd, prompt, profile: 'pr', crew, note }, async (current, runId) => {
      const problems: string[] = []
      const descriptions = new Map<number, { title: string; body: string }>()
      for (const item of changed) {
        const file = `pr-${item.repo.name}.md`
        const markdown = await this.engine.readOutput(current, file)
        if (markdown === null) {
          problems.push(`${file} wasn't written`)
          continue
        }
        const parsed = parsePrDescription(markdown, current.key)
        if (parsed.description) descriptions.set(item.repo.id, parsed.description)
        else problems.push(`${file}: ${parsed.problems.join('; ')}`)
      }
      if (problems.length > 0) {
        const file = problems[0].split(/[: ]/)[0]
        if (this.engine.requestFix(runId, file, problems)) return
        this.engine.endRun(current)
        this.engine.stop(this.deps.tickets.get(current.id), 'stuck', `The PR descriptions aren't valid after one fix request: ${problems.join('; ')}`)
        return
      }
      const ended = this.engine.endRun(current)
      await this.open(ended, stage, runner, changed, descriptions)
    })
  }

  private async open(ticket: Ticket, stage: StageConfig, runner: Runner, changed: ChangedRepo[], descriptions: Map<number, { title: string; body: string }>): Promise<void> {
    const project = this.engine.project(ticket)
    const draft = project.github.draft !== false
    const ci = this.engine.stages(ticket).find((item) => item.kind === 'ci')
    const autofix = (ci?.ci ?? DEFAULT_CI).autofixForNewTickets
    const opened: StoredPr[] = []
    for (const item of changed) {
      const description = descriptions.get(item.repo.id) as { title: string; body: string }
      try {
        if (!(await hasOrigin(runner, item.path))) throw new Error(`${item.repo.name} has no origin remote to push to`)
        await pushBranch(runner, item.path, item.branch)
        const existing = this.prs.forTicket(ticket.id).find((pr) => pr.repoId === item.repo.id && pr.state === 'open')
        const url = existing
          ? existing.url
          : await this.github.createPr(runner, item.path, { base: item.repo.defaultBranch, branch: item.branch, title: description.title, body: description.body, draft })
        if (existing) await this.github.setPrBody(runner, item.path, url, description.body)
        const info = await this.github.viewPr(runner, item.path, url)
        const saved = this.prs.save(ticket.id, item.repo.id, info, autofix)
        this.prs.update(saved.id, { pushedSha: info.headSha })
        opened.push(saved)
        this.deps.tickets.log(ticket.id, 'github', `${existing ? 'Updated' : 'Opened'} ${item.repo.name} #${info.number}${info.draft ? ' as a draft' : ''}: ${info.url}`)
      } catch (error) {
        this.engine.stop(this.deps.tickets.get(ticket.id), 'stuck', `Couldn't open the PR for ${item.repo.name}: ${(error as Error).message}`)
        return
      }
    }
    if (opened.length > 1 && project.github.linkPrs !== false) {
      for (const pr of opened) {
        const item = changed.find((entry) => entry.repo.id === pr.repoId) as ChangedRepo
        const body = prBody((descriptions.get(pr.repoId) as { body: string }).body, opened.filter((other) => other.id !== pr.id))
        await this.github.setPrBody(runner, item.path, pr.url, body).catch((error: Error) => this.deps.tickets.log(ticket.id, 'warning', `Couldn't link ${pr.repo} #${pr.number} to the other PRs: ${error.message}`))
      }
    }
    try {
      await this.deps.integrations?.prsOpened?.(ticket, opened.map((pr) => ({ repo: pr.repo, number: pr.number, url: pr.url, title: pr.title })), project)
    } catch (error) {
      this.deps.tickets.log(ticket.id, 'warning', `Couldn't attach the PRs to Linear: ${(error as Error).message}`)
    }
    const current = this.deps.tickets.get(ticket.id)
    await this.engine.runActions(current, stage.after)
    if (opened.some((pr) => pr.draft)) this.engine.needsYou(current, 'ready-for-review', 'The PRs are open as drafts. Mark them ready for review when you are.')
    else await this.engine.advance(current)
  }

  /** Marks the ticket's draft PRs ready for review, which ends the PR stage. */
  markReady(ticketId: number): Promise<void> {
    return this.engine.serial(ticketId, async () => {
      const ticket = this.deps.tickets.get(ticketId)
      if (ticket.waitingFor !== 'ready-for-review') throw new Error(`${ticket.key} has no draft PRs waiting`)
      const project = this.engine.project(ticket)
      const runner = this.engine.runner(project)
      for (const pr of this.prs.forTicket(ticketId).filter((item) => item.state === 'open')) {
        const repo = project.repos.find((item) => item.id === pr.repoId) as Repo
        await this.github.markReady(runner, repo.path, pr.url)
        this.prs.save(ticketId, pr.repoId, await this.github.viewPr(runner, repo.path, pr.url), pr.autofix)
      }
      this.deps.tickets.log(ticketId, 'github', 'You marked the PRs ready for review')
      await this.engine.advance(this.engine.update(ticketId, { status: 'running', waitingFor: null }))
    })
  }

  /** Saves an edited description and updates the PR on GitHub. */
  async updateDescription(ticketId: number, repoName: string, markdown: string): Promise<void> {
    const ticket = this.deps.tickets.get(ticketId)
    const parsed = parsePrDescription(markdown, ticket.key)
    if (!parsed.description) throw new Error(parsed.problems.join('. '))
    const project = this.engine.project(ticket)
    const runner = this.engine.runner(project)
    await runner.writeFile(runner.join(await this.engine.outputsDir(ticket), `pr-${repoName}.md`), markdown)
    const prs = this.prs.forTicket(ticketId)
    const pr = prs.find((item) => item.repo === repoName)
    if (!pr) return
    const repo = project.repos.find((item) => item.id === pr.repoId) as Repo
    const others = project.github.linkPrs !== false ? prs.filter((item) => item.id !== pr.id) : []
    await this.github.setPrBody(runner, repo.path, pr.url, prBody(parsed.description.body, others))
    this.deps.tickets.log(ticketId, 'github', `Updated the description of ${pr.repo} #${pr.number}`)
  }
}
