import { firstSentence } from './agent'
import type { Environment } from './environment'
import type { PullRequest } from './integrations'
import { isGenericStage, stageAccess, type StageConfig } from './pipeline'
import type { Mood } from './robot'
import { STOP_LABELS, stageLoops, type Ticket, type TicketCard } from './tickets'

export interface CardInputs {
  ticket: Ticket
  stages: StageConfig[]
  crewId: number | null
  environment: Environment | undefined
  /** The last thing the current run's agent said. */
  lastAgentText: string | null
  openQuestions: number
  prLinks: { label: string; url: string }[]
  /** The ticket's PRs with their last-seen checks, for Watch CI. */
  prs?: Pick<PullRequest, 'state' | 'checks' | 'autofix' | 'autofixPausedReason'>[]
}

/** What Watch CI is waiting on, in a few words. */
export function ciSummary(prs: NonNullable<CardInputs['prs']>): string {
  const open = prs.filter((pr) => pr.state === 'open')
  const checks = open.flatMap((pr) => pr.checks)
  const failing = checks.filter((check) => check.bucket === 'fail').length
  const pending = checks.filter((check) => check.bucket === 'pending').length
  if (open.length === 0) return 'Every PR has merged.'
  if (failing > 0) return `${failing} ${failing === 1 ? 'check' : 'checks'} failing.`
  if (pending > 0) return `${checks.length - pending} of ${checks.length} checks done.`
  if (checks.length === 0) return 'Waiting for checks to start.'
  return `All checks green. Waiting for ${open.length === 1 ? 'the merge' : `${open.length} merges`}.`
}

/**
 * Builds a board card from real state only, following the "Tags and where they come from" table in
 * the Screen specs: pills from stage and status, bubbles from templates or the agent's own words.
 */
export function ticketCard(inputs: CardInputs): TicketCard {
  const { ticket, stages, environment, lastAgentText, openQuestions } = inputs
  const stage = stages.find((item) => item.id === ticket.stage)
  // The stage whose failed work sent the ticket back (or stopped it at its loop limit), and its count.
  const failedStage = ticket.returnedFrom ? stages.find((item) => item.id === ticket.returnedFrom) : undefined
  const failedLoops = failedStage?.onFailure ? stageLoops(ticket, failedStage.id, failedStage.onFailure.maxLoops) : null
  let pill: TicketCard['pill'] = null
  let mood: Mood = 'idle'
  let bubble: string | null = null

  const settingUp = environment?.phase === 'setting-up'
  const runningStep = environment?.repos.flatMap((repo) => repo.steps).find((step) => step.status === 'running')

  if (ticket.stage === 'backlog') {
    pill = null
  } else if (ticket.stage === 'done') {
    pill = { status: 'passed', label: 'Done' }
    mood = 'shipped'
    bubble = 'Merged. Environment torn down.'
  } else if (ticket.stopReason) {
    pill = { status: ticket.stopReason === 'stuck' || ticket.stopReason === 'setup_failed' ? 'failed' : 'needsYou', label: STOP_LABELS[ticket.stopReason] }
    mood = 'stuck'
    const detail = (ticket.stopDetail ?? '').split('\n')[0]
    bubble =
      ticket.stopReason === 'loop_limit'
        ? `${failedStage?.name ?? stage?.name ?? 'The stage'} failed ${failedLoops?.failures ?? 0} times. Your call: one more loop, or back to Plan.`
        : `${STOP_LABELS[ticket.stopReason]}: ${firstSentence(detail).replace(/\.$/, '')}.`
  } else if (ticket.status === 'needs_you') {
    mood = 'needsYou'
    switch (ticket.waitingFor) {
      case 'answers':
        pill = { status: 'needsYou', label: 'Needs you' }
        bubble = openQuestions > 0 ? `${openQuestions} ${openQuestions === 1 ? 'question' : 'questions'} waiting for you.` : lastAgentText ? firstSentence(lastAgentText) : 'Waiting for you.'
        break
      case 'approval':
        pill = { status: 'needsYou', label: 'Needs you' }
        bubble = stage?.kind === 'plan' ? 'The plan is ready for your approval.' : `${stage?.name ?? 'This stage'} is ready for your approval.`
        break
      case 'manual-review':
        pill = { status: 'needsYou', label: 'Your turn' }
        bubble = `${stage?.name ?? 'The stage'} passed. Your turn to click around.`
        break
      case 'ready-for-review':
        pill = { status: 'needsYou', label: 'PRs open as drafts' }
        bubble = 'PRs are open as drafts. Mark them ready when you are.'
        break
      default:
        pill = { status: 'needsYou', label: 'Needs you' }
        bubble = lastAgentText ? firstSentence(lastAgentText) : 'Waiting for you.'
    }
  } else if (ticket.status === 'stopped') {
    pill = { status: 'idle', label: 'Paused' }
    bubble = `${stage?.name ?? 'The stage'} is paused. Resume when you're ready.`
  } else if (ticket.status === 'idle' && ticket.waitingFor === 'slot') {
    pill = { status: 'neutral', label: 'Waiting for a slot' }
    bubble = 'Waiting for a free slot.'
  } else if (ticket.status === 'idle' && stage?.kind === 'ci') {
    const failing = (inputs.prs ?? []).some((pr) => pr.checks.some((check) => check.bucket === 'fail'))
    pill = failing ? { status: 'fixing', label: 'Checks failing' } : { status: 'waiting', label: 'Watching CI' }
    mood = failing ? 'working' : 'idle'
    bubble = ciSummary(inputs.prs ?? [])
  } else if (ticket.status === 'running') {
    mood = 'working'
    if (settingUp) {
      pill = { status: 'running', label: 'Setting up' }
      bubble = runningStep ? `Running: ${firstSentence(runningStep.label)}` : 'Setting up the environment.'
    } else {
      pill = { status: stage?.kind === 'ci' ? 'fixing' : 'running', label: stage?.kind === 'ci' ? 'Fixing CI' : 'Running' }
      bubble = lastAgentText ? firstSentence(lastAgentText) : 'Getting started.'
    }
  }

  const tags: string[] = []
  const answering = failedStage && failedLoops && stage && failedStage.onFailure?.returnTo === stage.id
  if (answering && !ticket.stopReason) tags.push(`Back from ${failedStage.name.toLowerCase()} · loop ${failedLoops.failures} of ${failedLoops.allowed}`)
  else if (stage && isGenericStage(stage) && stageAccess(stage) === 'changes' && ticket.loop > 1 && !ticket.stopReason) tags.push(`${stage.name} · pass ${ticket.loop}`)
  if (ticket.stage === 'backlog' && ticket.linear.isNew) tags.push('New')
  if (ticket.linear.reassigned && ticket.stage !== 'done') tags.push('Reassigned in Linear')
  if (stage?.kind === 'ci' && inputs.prs?.some((pr) => pr.state === 'open' && (!pr.autofix || pr.autofixPausedReason))) tags.push('Autofix off')

  const openService = environment?.services.find((service) => service.state === 'ready' && service.openUrl)
  return {
    ticket,
    crewId: inputs.crewId,
    pill,
    mood,
    bubble,
    tags,
    links: inputs.prLinks,
    openUrl: openService?.openUrl ?? null
  }
}
