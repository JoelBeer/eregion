import { firstSentence } from './agent'
import type { Environment } from './environment'
import type { StageConfig } from './pipeline'
import type { Mood } from './robot'
import { STOP_LABELS, type Ticket, type TicketCard } from './tickets'

export interface CardInputs {
  ticket: Ticket
  stages: StageConfig[]
  crewId: number | null
  environment: Environment | undefined
  /** The last thing the current run's agent said. */
  lastAgentText: string | null
  openQuestions: number
  prLinks: { label: string; url: string }[]
}

/**
 * Builds a board card from real state only, following the "Tags and where they come from" table in
 * the Screen specs: pills from stage and status, bubbles from templates or the agent's own words.
 */
export function ticketCard(inputs: CardInputs): TicketCard {
  const { ticket, stages, environment, lastAgentText, openQuestions } = inputs
  const stage = stages.find((item) => item.id === ticket.stage)
  const review = stages.find((item) => item.kind === 'review')
  const allowedLoops = (review?.onFailure?.maxLoops ?? 2) + ticket.extraLoops
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
        ? `Review failed ${ticket.reviewFailures} times. Your call: one more loop, or back to Plan.`
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
        bubble = 'AI review passed. Your turn to click around.'
        break
      case 'ready-for-review':
        pill = { status: 'needsYou', label: 'PRs open as drafts' }
        bubble = 'PRs are open as drafts. Mark them ready when you are.'
        break
      default:
        pill = { status: 'needsYou', label: 'Needs you' }
        bubble = lastAgentText ? firstSentence(lastAgentText) : 'Waiting for you.'
    }
  } else if (ticket.status === 'idle' && ticket.waitingFor === 'slot') {
    pill = { status: 'neutral', label: 'Waiting for a slot' }
    bubble = 'Waiting for a free slot.'
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
  if (stage?.kind === 'build' && ticket.reviewFailures > 0 && !ticket.stopReason) tags.push(`Back from review · loop ${ticket.reviewFailures} of ${allowedLoops}`)
  else if (stage?.kind === 'build' && ticket.loop > 1 && !ticket.stopReason) tags.push(`${stage.name} · pass ${ticket.loop}`)

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
