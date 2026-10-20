import type { PrCheck } from '@shared/integrations'
import type { Repo } from '@shared/model'
import { parseCiFix } from '@shared/outputs'
import { DEFAULT_CI, type CiSettings, type StageConfig } from '@shared/pipeline'
import type { Ticket } from '@shared/tickets'
import type { GitHub } from '../integrations/github'
import { commitAll, gitIn, pushBranch } from '../workspace/git'
import type { PipelineEngine } from './engine'
import type { PrStore, StoredPr } from './prs'

const TICK_MS = 15_000

const BUCKET_WORDS: Record<PrCheck['bucket'], string> = { pass: 'passed', fail: 'failed', pending: 'started', skipping: 'skipped', cancel: 'was cancelled' }

/** The checks that changed state since the last look, as "lint passed, tests failed"; null when none did. */
export function checkChanges(before: PrCheck[], after: PrCheck[]): string | null {
  const previous = new Map(before.map((check) => [`${check.workflow}/${check.name}`, check.bucket]))
  const changed = after.filter((check) => previous.get(`${check.workflow}/${check.name}`) !== check.bucket)
  return changed.length > 0 ? changed.map((check) => `${check.name} ${BUCKET_WORDS[check.bucket]}`).join(', ') : null
}

/**
 * Watch CI: polls each ticket's PRs with gh, re-runs a failed check once in case it's flaky, then
 * wakes the fixer in the ticket's worktree, commits and pushes its fix. Finishes the ticket when
 * every PR has merged (or every check is green, if the stage says so).
 */
export class CiWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly lastCheck = new Map<number, number>()

  constructor(
    private readonly engine: PipelineEngine,
    private readonly prs: PrStore,
    private readonly github: GitHub,
    private readonly now: () => number = Date.now
  ) {
    engine.registerStage('ci', (ticket, stage) => this.enter(ticket, stage))
  }

  private get deps(): PipelineEngine['deps'] {
    return this.engine.deps
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private settings(stage: StageConfig): CiSettings {
    return { ...DEFAULT_CI, ...stage.ci }
  }

  private async enter(ticket: Ticket, stage: StageConfig): Promise<void> {
    if (this.prs.forTicket(ticket.id).length === 0) {
      this.engine.stop(ticket, 'stuck', 'There are no PRs to watch. Go back to the PR stage first.')
      return
    }
    this.engine.update(ticket.id, { status: 'idle', waitingFor: null, currentRunId: null }, `Watching CI every ${this.settings(stage).intervalSec} seconds`)
    void this.check(ticket.id)
  }

  /** Tickets sitting in Watch CI that aren't stopped and have no fix running. */
  private watching(): Ticket[] {
    const tickets = this.deps.projects.list().flatMap((project) => this.deps.tickets.list(project.id))
    return tickets.filter((ticket) => this.engine.stage(ticket)?.kind === 'ci' && !ticket.stopReason && ticket.status !== 'done')
  }

  async tick(): Promise<void> {
    for (const ticket of this.watching()) {
      const stage = this.engine.stage(ticket) as StageConfig
      const due = (this.lastCheck.get(ticket.id) ?? 0) + this.settings(stage).intervalSec * 1000
      if (this.now() >= due && ticket.currentRunId === null) void this.check(ticket.id)
    }
  }

  private fixesRunning(): number {
    return this.watching().filter((ticket) => ticket.currentRunId !== null).length
  }

  /** One look at a ticket's PRs and checks. */
  check(ticketId: number): Promise<void> {
    return this.engine.serial(ticketId, async () => {
      this.lastCheck.set(ticketId, this.now())
      const ticket = this.deps.tickets.get(ticketId)
      const stage = this.engine.stage(ticket)
      if (stage?.kind !== 'ci' || ticket.stopReason || ticket.currentRunId !== null) return
      const settings = this.settings(stage)
      const project = this.engine.project(ticket)
      const runner = this.engine.runner(project)
      try {
        let all = this.prs.forTicket(ticketId)
        for (const pr of all.filter((item) => item.state === 'open')) {
          const repo = project.repos.find((item) => item.id === pr.repoId) as Repo
          const info = await this.github.viewPr(runner, repo.path, pr.url)
          const saved = this.prs.save(ticketId, pr.repoId, info, pr.autofix)
          if (info.state === 'merged') this.deps.tickets.log(ticketId, 'github', `${pr.repo} #${pr.number} merged`)
          if (info.state === 'closed') {
            this.engine.stop(ticket, 'ci_needs_you', `${pr.repo} #${pr.number} was closed without merging`)
            return
          }
          if (info.state !== 'open') continue
          if (settings.pauseOnForeignPush && saved.pushedSha && info.headSha !== saved.pushedSha && !saved.autofixPausedReason) {
            this.prs.update(saved.id, { autofixPausedReason: 'Someone else pushed to the branch' })
            this.deps.tickets.log(ticketId, 'github', `Someone else pushed to ${pr.repo} #${pr.number}; autofix is paused for it`)
          }
          const { checks, scope } = await this.github.checks(runner, repo.path, pr.url, !settings.includeOptionalChecks)
          if (scope === 'all' && !settings.includeOptionalChecks && saved.checksScope !== 'all') {
            this.deps.tickets.log(ticketId, 'github', `${pr.repo} has no required checks, so Eregion watches all of ${pr.repo} #${pr.number}'s checks`)
          }
          const changes = checkChanges(saved.checks, checks)
          if (changes) this.deps.tickets.log(ticketId, 'github', `${pr.repo} #${pr.number}: ${changes}`)
          this.prs.update(saved.id, { checks, checksScope: scope, checkedAt: new Date(this.now()).toISOString() })
        }
        all = this.prs.forTicket(ticketId)
        if (all.every((pr) => pr.state === 'merged')) {
          this.deps.tickets.log(ticketId, 'github', 'Every PR has merged')
          await this.engine.advance(this.deps.tickets.get(ticketId))
          return
        }
        const open = all.filter((pr) => pr.state === 'open')
        const green = open.every((pr) => pr.checks.length > 0 && pr.checks.every((check) => check.bucket === 'pass' || check.bucket === 'skipping'))
        if (stage.doneWhen === 'prs-green' && green) {
          this.deps.tickets.log(ticketId, 'github', 'Every check is green')
          await this.engine.advance(this.deps.tickets.get(ticketId))
          return
        }
        for (const pr of open) {
          const failed = pr.checks.filter((check) => check.bucket === 'fail')
          if (failed.length === 0) continue
          await this.handleFailure(this.deps.tickets.get(ticketId), stage, settings, pr, failed)
          return
        }
      } catch (error) {
        this.deps.tickets.log(ticketId, 'warning', `Couldn't check CI: ${(error as Error).message}`)
      } finally {
        // Checks and PR states changed even when the ticket itself didn't: let screens refresh.
        this.deps.onTicketChanged(this.deps.tickets.get(ticketId))
      }
    })
  }

  private async handleFailure(ticket: Ticket, stage: StageConfig, settings: CiSettings, pr: StoredPr, failed: PrCheck[]): Promise<void> {
    const project = this.engine.project(ticket)
    const runner = this.engine.runner(project)
    const repo = project.repos.find((item) => item.id === pr.repoId) as Repo
    const names = failed.map((check) => check.name).join(', ')
    if (!pr.autofix || pr.autofixPausedReason) {
      const why = pr.autofixPausedReason ?? 'Autofix is off for this ticket'
      this.engine.stop(ticket, 'ci_needs_you', `${names} failed on ${pr.repo} #${pr.number}. ${why}.`)
      return
    }
    if (settings.rerunFirst && pr.rerunSha !== pr.headSha) {
      const runs = new Set<string>()
      for (const check of failed) {
        const key = check.link.match(/\/actions\/runs\/(\d+)/)?.[1] ?? check.link
        if (runs.has(key)) continue
        runs.add(key)
        await this.github.rerunFailed(runner, repo.path, check).catch((error: Error) => this.deps.tickets.log(ticket.id, 'warning', `Couldn't re-run ${check.name}: ${error.message}`))
      }
      this.prs.update(pr.id, { rerunSha: pr.headSha })
      this.deps.tickets.log(ticket.id, 'github', `${names} failed on ${pr.repo} #${pr.number}. Re-ran once in case it's flaky.`)
      return
    }
    const attempts = this.prs.attempts(pr.id)
    if (attempts.some((attempt) => attempt.headSha === pr.headSha)) return
    if (attempts.length >= settings.maxAttempts) {
      await this.outOfAttempts(ticket, settings, pr, repo, names, attempts.length)
      return
    }
    if (this.fixesRunning() >= settings.concurrentFixes) {
      this.deps.tickets.log(ticket.id, 'pipeline', `Waiting to fix ${names}: ${settings.concurrentFixes} fixes are already running`)
      return
    }
    await this.fix(ticket, stage, settings, pr, repo, failed[0], attempts.length + 1)
  }

  private async outOfAttempts(ticket: Ticket, settings: CiSettings, pr: StoredPr, repo: Repo, names: string, used: number): Promise<void> {
    const detail = `${names} still failing on ${pr.repo} #${pr.number} after ${used} fix ${used === 1 ? 'attempt' : 'attempts'}`
    if (settings.onAttemptsExhausted.commentOnPr) {
      const tried = (await Promise.all(this.prs.attempts(pr.id).map(async (attempt) => (await this.engine.readOutput(ticket, `history/ci-fix-${pr.repo}-${attempt.attempt}.json`)) ?? '')))
        .map((text) => {
          try {
            const fix = JSON.parse(text) as { attempt: number; check: string; cause: string; note: string }
            return `- Attempt ${fix.attempt} (${fix.check}): ${fix.cause} ${fix.note}`.trim()
          } catch {
            return null
          }
        })
        .filter(Boolean)
        .join('\n')
      const body = `Eregion tried to fix ${names} ${used} ${used === 1 ? 'time' : 'times'} and stopped.\n\n${tried || '- No notes from the attempts.'}\n\nA person needs to look at this.`
      await this.github.comment(this.engine.runner(this.engine.project(ticket)), repo.path, pr.url, body).catch((error: Error) => this.deps.tickets.log(ticket.id, 'warning', `Couldn't comment on the PR: ${error.message}`))
    }
    if (settings.onAttemptsExhausted.flagAndNotify) this.engine.stop(ticket, 'ci_needs_you', detail)
    else this.prs.update(pr.id, { autofixPausedReason: 'Out of fix attempts' })
  }

  private async fix(ticket: Ticket, stage: StageConfig, settings: CiSettings, pr: StoredPr, repo: Repo, check: PrCheck, attempt: number): Promise<void> {
    const environment = await this.engine.ensureEnvironment(ticket)
    if (!environment) return
    ticket = this.deps.tickets.get(ticket.id)
    const project = this.engine.project(ticket)
    const runner = this.engine.runner(project)
    const worktree = environment.repos.find((item) => item.repoId === repo.id)
    if (!worktree || worktree.branch === null) {
      this.engine.stop(ticket, 'ci_needs_you', `${repo.name} has no worktree on the ticket branch to fix in`)
      return
    }
    const local = (await gitIn(runner, worktree.path, ['rev-parse', 'HEAD'])).trim()
    if (pr.headSha && local !== pr.headSha) {
      this.prs.update(pr.id, { autofixPausedReason: "The branch on GitHub doesn't match the worktree" })
      this.engine.stop(ticket, 'ci_needs_you', `${pr.repo} #${pr.number} on GitHub isn't the commit in the worktree, so Eregion won't fix it there`)
      return
    }
    const log = await this.github.failedLog(runner, repo.path, check)
    this.prs.addAttempt(pr.id, check.name, pr.headSha, null)
    await this.engine.removeOutput(ticket, 'ci-fix.json')
    const previous = (
      await Promise.all(
        this.prs
          .attempts(pr.id)
          .filter((item) => item.attempt < attempt)
          .map((item) => this.engine.readOutput(ticket, `history/ci-fix-${pr.repo}-${item.attempt}.json`))
      )
    )
      .filter(Boolean)
      .join('\n')
    const crew = this.engine.crewFor(stage)
    const label = `${pr.repo} #${pr.number}`
    const prompt = await this.engine.promptFor(ticket, stage, crew, {
      'ci.attempt': String(attempt),
      'ci.max_attempts': String(settings.maxAttempts),
      'ci.pr': label,
      'ci.repo': pr.repo,
      'ci.check': check.name,
      'ci.log': log,
      'ci.previous': previous,
      'outputs.plan': (await this.engine.readOutput(ticket, 'plan.md')) ?? ''
    })
    const cwd = await this.deps.workspaces.ticketFolder(project, project.repos[0], ticket.key)
    this.deps.tickets.log(ticket.id, 'pipeline', `${check.name} failed again on ${label}. Fix attempt ${attempt} of ${settings.maxAttempts}.`)
    await this.engine.startRun(ticket, stage, { cwd, prompt, profile: 'ci-fix', crew }, async (current, runId) => {
      const text = await this.engine.readOutput(current, 'ci-fix.json')
      const { fix, problems } = text === null ? { fix: null, problems: ["ci-fix.json wasn't written"] } : parseCiFix(text, { pr: label, check: check.name, attempt })
      if (!fix) {
        if (this.engine.requestFix(runId, 'ci-fix.json', problems)) return
        this.engine.endRun(current)
        this.prs.finishAttempt(pr.id, attempt, 'needs-you', runId)
        this.engine.stop(this.deps.tickets.get(current.id), 'stuck', `ci-fix.json isn't valid after one fix request: ${problems.join('; ')}`)
        return
      }
      const ended = this.engine.endRun(current)
      await this.engine.keepHistory(ended, 'ci-fix.json', `ci-fix-${pr.repo}-${attempt}.json`)
      if (fix.result === 'needs-you') {
        this.prs.finishAttempt(pr.id, attempt, 'needs-you', runId)
        this.engine.stop(ended, 'ci_needs_you', `${check.name} on ${label}: ${fix.cause}`)
        return
      }
      const sha = await commitAll(runner, worktree.path, `${ended.key}: fix ${check.name} (CI attempt ${attempt})`, `${fix.cause}\n\n${fix.note}`.trim())
      if (!sha) {
        this.prs.finishAttempt(pr.id, attempt, 'needs-you', runId)
        this.engine.stop(ended, 'ci_needs_you', `The fix for ${check.name} on ${label} changed no files`)
        return
      }
      try {
        await pushBranch(runner, worktree.path, worktree.branch as string)
      } catch (error) {
        this.prs.finishAttempt(pr.id, attempt, 'needs-you', runId)
        this.engine.stop(ended, 'ci_needs_you', `Couldn't push the fix to ${label}: ${(error as Error).message}`)
        return
      }
      const pushed = (await gitIn(runner, worktree.path, ['rev-parse', 'HEAD'])).trim()
      this.prs.update(pr.id, { pushedSha: pushed })
      this.prs.finishAttempt(pr.id, attempt, 'fixed', runId)
      this.engine.update(ended.id, { status: 'idle', waitingFor: null }, `Pushed a fix for ${check.name} to ${label} (${sha}). Watching CI again.`)
    })
  }

  /** Turns autofix on or off for a ticket's PRs; turning it on clears a pause. */
  setAutofix(ticketId: number, on: boolean): void {
    for (const pr of this.prs.forTicket(ticketId)) this.prs.update(pr.id, { autofix: on, autofixPausedReason: null })
    this.deps.tickets.log(ticketId, 'pipeline', on ? 'Autofix on' : 'Autofix off')
  }
}
