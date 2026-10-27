import type { PrCheck, PullRequest } from '@shared/integrations'
import { checkIgnored, DEFAULT_CI } from '@shared/pipeline'
import type { PipelineEngine } from './pipeline/engine'
import type { PrStore } from './pipeline/prs'
import type { TicketStore } from './pipeline/stores'
import { branchExists, gitIn } from './workspace/git'
import type { Workspaces } from './workspace/workspaces'

/** What a Forge chat about a ticket knows: the ticket in words, the code it reads, and the folders it may read. */
export interface TicketContext {
  projectId: number
  key: string
  title: string
  /** Added to the chat's instructions. */
  text: string
  /** The ticket's worktrees by repo name, or empty when its environment is torn down (the chat reads the plan checkout). */
  repoPaths: Record<string, string>
  /** The outputs folder and the folder with the branch's diffs. */
  readDirs: string[]
}

export interface TicketContextDeps {
  engine: PipelineEngine
  tickets: TicketStore
  workspaces: Workspaces
  prs?: PrStore
}

/** A PR in one line, with its checks as Watch CI counts them (ignored ones left out). */
function prLine(pr: PullRequest, ignored: (check: PrCheck) => boolean): string {
  const checks = pr.checks.filter((check) => !ignored(check))
  const failing = checks.filter((check) => check.bucket === 'fail').map((check) => check.name)
  const pending = checks.filter((check) => check.bucket === 'pending').length
  const ci = checks.length === 0 ? 'no checks seen' : failing.length ? `failing: ${failing.join(', ')}` : pending ? `${pending} ${pending === 1 ? 'check' : 'checks'} still running` : 'checks passed'
  return `- ${pr.repo} #${pr.number}${pr.draft ? ' (draft)' : ''}, ${pr.state}, ${ci}: ${pr.url}`
}

/**
 * The context for asking questions about a ticket's work in the Forge. The branch's changes against the base are
 * written as one diff per changed repo into the chat's own folder, so the chat can read them even once the
 * ticket's environment is torn down.
 */
export async function ticketContext(deps: TicketContextDeps, ticketId: number, folder: string): Promise<TicketContext> {
  const ticket = deps.tickets.get(ticketId)
  const project = deps.engine.project(ticket)
  const runner = deps.engine.runner(project)
  const stage = deps.engine.stage(ticket)
  const outputs = await deps.engine.outputsDir(ticket)
  const environment = deps.workspaces.get(`ticket:${ticket.id}`)
  const repoPaths = environment && environment.phase !== 'torn-down' ? Object.fromEntries(environment.repos.map((repo) => [repo.name, repo.path])) : {}

  await runner.exec(['mkdir', '-p', folder])
  const diffs: string[] = []
  const stats: string[] = []
  if (ticket.branch) {
    for (const repo of project.repos) {
      if (!(await branchExists(runner, repo.path, ticket.branch))) continue
      const range = `origin/${repo.defaultBranch}...${ticket.branch}`
      const stat = await gitIn(runner, repo.path, ['diff', '--stat', range]).catch(() => '')
      if (!stat.trim()) continue
      const file = runner.join(folder, `changes-${repo.name}.diff`)
      await runner.writeFile(file, await gitIn(runner, repo.path, ['diff', range], 300_000))
      diffs.push(`- ${repo.name}: ${file}`)
      stats.push(`${repo.name}:\n${stat}`)
    }
  }

  const prs = deps.prs?.forTicket(ticket.id) ?? []
  const ci = deps.engine.stages(ticket).find((item) => item.kind === 'ci')
  const ignores = { ...DEFAULT_CI, ...ci?.ci }.ignoreChecks ?? []
  const ignored = (check: PrCheck): boolean => checkIgnored(check.name, ticket.ignoredChecks, ignores)
  const where = ticket.stage === 'done' ? 'finished' : ticket.stage === 'backlog' ? 'in the Backlog' : `in ${stage?.name ?? ticket.stage}`
  const lines = [
    `You're answering questions about ticket ${ticket.key}, "${ticket.title}", which is ${where}. Read what you need before you answer; don't change anything.`,
    ticket.branch ? `Its branch: ${ticket.branch}` : '',
    ticket.description.trim() ? `The ticket says:\n${ticket.description.trim()}` : '',
    prs.length ? `Its pull requests:\n${prs.map((pr) => prLine(pr, ignored)).join('\n')}` : '',
    `What each stage wrote is in ${outputs}: plan.md (the approved plan), spec.md (the approved spec: what must be true when the ticket is done), build-notes.md, review.json (the latest review), fixes.json, pr-<repo>.md (the PR descriptions), build-log.md, and earlier versions in history/.`,
    Object.keys(repoPaths).length
      ? `The code, on the ticket's branch:\n${Object.entries(repoPaths)
          .map(([name, path]) => `- ${name}: ${path}`)
          .join('\n')}`
      : "The ticket's environment is torn down, so the repos you can read are at their base branch.",
    diffs.length ? `The branch's changes against the base, as diffs:\n${diffs.join('\n')}\n\nChanged files:\n${stats.join('\n\n')}` : ''
  ]
  return { projectId: project.id, key: ticket.key, title: ticket.title, text: lines.filter(Boolean).join('\n\n'), repoPaths, readDirs: [outputs, folder] }
}
