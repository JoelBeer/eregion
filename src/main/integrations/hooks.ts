import { DEFAULT_LINEAR_PUSH, type Project } from '@shared/model'
import type { StageConfig } from '@shared/pipeline'
import type { Ticket } from '@shared/tickets'
import type { Integrations } from '../pipeline/engine'
import type { LinearAuth } from './linearAuth'

export const PLAN_MARKER = '<!-- eregion:plan -->'

/** The ticket description with the approved plan appended, replacing a plan Eregion added before. */
export function descriptionWithPlan(description: string, plan: string): string {
  const original = description.split(PLAN_MARKER)[0].trimEnd()
  return `${original}\n\n${PLAN_MARKER}\n---\n\n${plan.trim()}\n`
}

/** The pipeline's hooks into Linear: status per stage, the approved plan, PR links. */
export function linearIntegrations(auth: LinearAuth, notify: (title: string, body: string) => void): Integrations {
  const linked = (ticket: Ticket, project: Project) => {
    const client = auth.client()
    return client && ticket.linearId && project.linear.teamId ? client : null
  }
  const setState = async (ticket: Ticket, project: Project, key: string): Promise<void> => {
    const stateId = project.linear.statusByStage?.[key]
    const client = linked(ticket, project)
    if (client && stateId) await client.updateIssue(ticket.linearId as string, { stateId })
  }
  return {
    stageEntered: (ticket: Ticket, stage: StageConfig, project: Project) => setState(ticket, project, stage.id),
    ticketDone: (ticket: Ticket, project: Project) => setState(ticket, project, 'done'),
    async planApproved(ticket, markdown, project) {
      const client = linked(ticket, project)
      if (!client) return
      const push = { ...DEFAULT_LINEAR_PUSH, ...project.linear.push }
      if (push.planComment) await client.comment(ticket.linearId as string, `**Plan approved in Eregion**\n\n${markdown.trim()}`)
      if (push.planDescription) await client.updateIssue(ticket.linearId as string, { description: descriptionWithPlan(ticket.description, markdown) })
    },
    async prsOpened(ticket, prs, project) {
      const client = linked(ticket, project)
      if (!client || !{ ...DEFAULT_LINEAR_PUSH, ...project.linear.push }.prLinks) return
      for (const pr of prs) await client.attachLink(ticket.linearId as string, pr.url, `${pr.repo} #${pr.number}: ${pr.title}`)
    },
    notify
  }
}
