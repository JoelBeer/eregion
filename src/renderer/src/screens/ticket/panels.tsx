import { useState, type ReactElement } from 'react'
import type { Environment } from '@shared/environment'
import type { StageConfig } from '@shared/pipeline'
import type { CrewMember } from '@shared/runs'
import type { TicketOutputs } from '@shared/ticketDetail'
import type { Ticket } from '@shared/tickets'
import { ServiceRows, StepRows } from '../../components/EnvironmentView'
import { Markdown } from '../../components/Markdown'
import { Chip, StatusPill } from '../../components/ui'
import { useAction } from '../../hooks'

const SEVERITY_STYLE: Record<string, { background: string; color: string; label: string }> = {
  high: { background: 'var(--red-100, #FDECEC)', color: 'var(--red-700, #B42318)', label: 'HIGH' },
  medium: { background: 'var(--amber-100, #FEF3C7)', color: 'var(--amber-800, #92400E)', label: 'MED' },
  low: { background: 'var(--indigo-100, #E9EEF9)', color: 'var(--indigo-800, #2C3E7A)', label: 'LOW' }
}

export function Severity({ severity }: { severity: string }): ReactElement {
  const style = SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.low
  return <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: style.background, color: style.color, flex: 'none' }}>{style.label}</span>
}

/** The live plan.md beside the Plan conversation, with approval gated on open questions. */
export function PlanPanel({ ticket, outputs, builder, nextStage }: { ticket: Ticket; outputs: TicketOutputs | undefined; builder: CrewMember | undefined; nextStage: StageConfig | null }): ReactElement {
  const approve = useAction(() => window.eregion.approvePlan(ticket.id))
  const plan = outputs?.plan
  const open = plan?.parsed.questions.filter((question) => !question.answered).length ?? 0
  const changing = plan?.parsed.repos.filter((repo) => repo.changes).map((repo) => repo.name) ?? []
  const waiting = ticket.status === 'needs_you' && (ticket.waitingFor === 'approval' || ticket.waitingFor === 'answers')
  return (
    <section aria-label="plan.md" className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 className="mono" style={{ fontSize: 15 }}>
          plan.md
        </h2>
        <span className="muted" style={{ fontSize: 12 }}>
          {plan ? 'Draft · updates live' : 'Not written yet'}
        </span>
      </div>
      {plan && (
        <>
          {plan.parsed.repos.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="label">Affected repos</span>
              {plan.parsed.repos.map((repo) => (
                <Chip key={repo.name} tone={repo.changes ? 'teal' : 'neutral'}>
                  {repo.name} · {repo.changes ? 'changes' : 'none'}
                </Chip>
              ))}
            </div>
          )}
          {plan.parsed.questions.length > 0 && (
            <div>
              <span className="label">
                Open questions · {open} of {plan.parsed.questions.length}
              </span>
            </div>
          )}
          <Markdown source={plan.markdown} />
        </>
      )}
      {plan && plan.blockers.length > 0 && (
        <ul className="error-text" style={{ margin: 0, paddingLeft: 18 }}>
          {plan.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      )}
      {plan && plan.blockers.length === 0 && nextStage && (
        <span className="muted" style={{ fontSize: 13 }}>
          Approving hands this ticket to {builder?.name ?? 'the builder'} for {nextStage.name}, creates worktrees for {changing.join(' and ')} and runs setup.
        </span>
      )}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="button" className="er-btn er-btn-primary" disabled={!waiting || !plan || plan.blockers.length > 0 || approve.pending} onClick={() => void approve.run()}>
          {nextStage ? `Approve plan and start ${nextStage.name}` : 'Approve plan'}
        </button>
        {open > 0 && <span className="muted">Answer the open {open === 1 ? 'question' : 'questions'} to enable approval.</span>}
      </div>
      {approve.error && <span className="error-text">{approve.error}</span>}
    </section>
  )
}

/** After the AI review passes: check it yourself, then approve or send it back. */
export function ReviewDecision({ ticket, outputs, nextStage }: { ticket: Ticket; outputs: TicketOutputs | undefined; nextStage: StageConfig | null }): ReactElement {
  const [note, setNote] = useState('')
  const [ticked, setTicked] = useState<Set<number>>(new Set())
  const approve = useAction(() => window.eregion.approveReview(ticket.id))
  const sendBack = useAction(() => window.eregion.sendBackToBuild(ticket.id, note))
  const doneWhen = outputs?.plan?.parsed.doneWhen ?? []
  const lows = outputs?.review?.review?.issues.filter((issue) => issue.severity === 'low') ?? []
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, alignItems: 'flex-start' }}>
      <section aria-label="Check it yourself" className="panel" style={{ flex: '3 1 480px', minWidth: 0 }}>
        <h2 style={{ fontSize: 17 }}>Check it yourself</h2>
        <span className="label">Done when, from the plan</span>
        {doneWhen.map((item, index) => (
          <label key={index} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14 }}>
            <input
              type="checkbox"
              checked={ticked.has(index)}
              onChange={() => {
                const next = new Set(ticked)
                if (next.has(index)) next.delete(index)
                else next.add(index)
                setTicked(next)
              }}
              style={{ marginTop: 3 }}
            />
            {item}
          </label>
        ))}
        <span className="muted" style={{ fontSize: 13 }}>
          Ticks are just for you while you click through. They aren't saved to the plan.
        </span>
        {lows.length > 0 && (
          <>
            <span className="label">Low issues from the review</span>
            {lows.map((issue) => (
              <div key={issue.id} style={{ display: 'flex', gap: 8, fontSize: 14 }}>
                <Severity severity="low" />
                <span>
                  <span className="mono">
                    {issue.file}
                    {issue.line ? `:${issue.line}` : ''}
                  </span>{' '}
                  · {issue.problem}
                </span>
              </div>
            ))}
          </>
        )}
      </section>
      <section aria-label="Decide" className="panel" style={{ flex: '2 1 320px', minWidth: 0, border: '2px solid var(--primary-600)' }}>
        <button type="button" className="er-btn er-btn-primary" onClick={() => void approve.run()} disabled={approve.pending}>
          {nextStage ? `Approve and start ${nextStage.name}` : 'Approve and finish'}
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          The environment keeps running until the ticket is done.
        </span>
        <label className="label" htmlFor="send-back" style={{ marginTop: 6 }}>
          Or send it back to Build
        </label>
        <textarea id="send-back" className="textarea" rows={3} placeholder="What needs changing? Low issues to fix can be named here too." value={note} onChange={(event) => setNote(event.target.value)} />
        <button type="button" className="er-btn" onClick={() => void sendBack.run()} disabled={!note.trim() || sendBack.pending}>
          Send back to Build
        </button>
        <span className="muted" style={{ fontSize: 13 }}>
          Your note goes to the builder as a message from you at the start of the next Build pass, then the review runs again. It doesn't use up an AI review loop.
        </span>
        {(approve.error || sendBack.error) && <span className="error-text">{approve.error ?? sendBack.error}</span>}
      </section>
    </div>
  )
}

const STOP_TITLES = {
  blocked: 'Stopped: the plan doesn’t cover this',
  stuck: 'Stuck',
  setup_failed: 'Setup failed',
  loop_limit: 'Loop limit reached',
  ci_needs_you: 'CI needs you'
} as const

/** Why the ticket stopped and what you can do about it, per the Screen specs table. */
export function StopBanner({ ticket, crew }: { ticket: Ticket; crew: CrewMember | undefined }): ReactElement | null {
  const [note, setNote] = useState('')
  const backToPlan = useAction(() => window.eregion.backToPlan(ticket.id, note))
  const retry = useAction(() => window.eregion.retryTicket(ticket.id))
  const oneMore = useAction(() => window.eregion.allowOneMoreLoop(ticket.id))
  const release = useAction(() => window.eregion.releaseSlot(ticket.id))
  if (!ticket.stopReason) return null
  const error = backToPlan.error ?? retry.error ?? oneMore.error ?? release.error
  return (
    <section aria-label="Why it stopped" className="panel" style={{ border: '2px solid var(--amber-400, #F2C46D)' }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <h2 style={{ fontSize: 17 }}>{STOP_TITLES[ticket.stopReason]}</h2>
        {crew && <span className="muted">{crew.name} stopped</span>}
      </div>
      <blockquote style={{ margin: 0, padding: '12px 14px', borderLeft: '3px solid var(--amber-400)', background: 'var(--surface-25, #F7F8FB)', whiteSpace: 'pre-wrap', fontSize: 14 }}>{ticket.stopDetail}</blockquote>
      {ticket.stopReason === 'blocked' && <span className="muted">Nothing from this pass was committed.</span>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        {(ticket.stopReason === 'blocked' || ticket.stopReason === 'loop_limit') && (
          <>
            <input className="input" style={{ flex: '1 1 260px' }} placeholder="Anything to add for the plan (optional)" value={note} onChange={(event) => setNote(event.target.value)} />
            <button type="button" className="er-btn er-btn-primary" onClick={() => void backToPlan.run()} disabled={backToPlan.pending}>
              Back to Plan
            </button>
          </>
        )}
        {ticket.stopReason === 'loop_limit' && (
          <button type="button" className="er-btn" onClick={() => void oneMore.run()} disabled={oneMore.pending}>
            Allow one more loop
          </button>
        )}
        {(ticket.stopReason === 'blocked' || ticket.stopReason === 'stuck') && (
          <button type="button" className="er-btn" onClick={() => void retry.run()} disabled={retry.pending}>
            Start again
          </button>
        )}
        {ticket.stopReason === 'setup_failed' && (
          <>
            <button type="button" className="er-btn er-btn-primary" onClick={() => void retry.run()} disabled={retry.pending}>
              Retry setup
            </button>
            {ticket.slot !== null && (
              <button type="button" className="er-btn" onClick={() => void release.run()} disabled={release.pending}>
                Release the slot
              </button>
            )}
          </>
        )}
      </div>
      {error && <span className="error-text">{error}</span>}
    </section>
  )
}

export function EnvironmentPanel({ ticket, environment, repoNames }: { ticket: Ticket; environment: Environment | null; repoNames: string[] }): ReactElement | null {
  const start = useAction(() => window.eregion.startServices(ticket.id))
  const stop = useAction(() => window.eregion.stopServices(ticket.id))
  const editor = useAction((repo: string) => window.eregion.openInEditor(ticket.id, repo))
  if (ticket.slot === null) return null
  const running = environment?.services.some((service) => service.state === 'ready' || service.state === 'starting')
  return (
    <section aria-label="Environment" className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ fontSize: 17 }}>Environment</h2>
        <StatusPill status="neutral">Slot {ticket.slot}</StatusPill>
        {environment?.phase === 'setting-up' && <StatusPill status="running">Setting up</StatusPill>}
        <div style={{ flex: 1 }} />
        {running ? (
          <button type="button" className="er-btn er-btn-sm" onClick={() => void stop.run()} disabled={stop.pending}>
            Stop services
          </button>
        ) : (
          <button type="button" className="er-btn er-btn-sm" onClick={() => void start.run()} disabled={start.pending || environment?.phase === 'setting-up'}>
            Start services
          </button>
        )}
      </div>
      {environment && Object.keys(environment.values).length > 0 && (
        <span className="mono muted" style={{ fontSize: 13 }}>
          {Object.entries(environment.values)
            .map(([name, value]) => `${name} = ${value}`)
            .join(' · ')}
        </span>
      )}
      {environment &&
        (environment.phase === 'setting-up' || environment.phase === 'failed') &&
        environment.repos.map((repo) => (
          <div key={repo.name} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span className="label">Setting up {repo.name}</span>
            <StepRows steps={repo.steps} />
          </div>
        ))}
      {environment?.error && <span className="error-text">{environment.error}</span>}
      {environment ? <ServiceRows environment={environment} /> :<span className="muted">Services aren't running since Eregion started. Start them to use the app.</span>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {repoNames.map((repo) => (
          <button key={repo} type="button" className="er-btn er-btn-sm" onClick={() => void editor.run(repo)}>
            Open {repo} in editor
          </button>
        ))}
      </div>
      {(start.error || stop.error || editor.error) && <span className="error-text">{start.error ?? stop.error ?? editor.error}</span>}
    </section>
  )
}
