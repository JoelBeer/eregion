import { usageLimitMessage } from '@shared/agent'
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { noCostLabel } from '@shared/connectors'
import { SOURCE_NAMES } from '@shared/sources'
import { isGenericStage, sendBackTarget, type StageConfig } from '@shared/pipeline'
import { useConnectors } from '../../agents'
import type { CrewMember, RunSummary } from '@shared/runs'
import type { RepoDiff, TicketDetail, TicketOutputs } from '@shared/ticketDetail'
import { Markdown } from '../../components/Markdown'
import { SessionPanel, useRun } from '../../components/SessionPanel'
import { Stepper, StatusPill, type Step } from '../../components/ui'
import { useAction } from '../../hooks'
import { href, navigate, type TicketTab } from '../../router'
import { useCrew } from '../Board'
import { EnvironmentPanel, OpenFileButton, OpenInEditor, PlanPanel, ReviewDecision, Severity, StopBanner } from './panels'
import { CiPanel, DoneSummary, LinearDetails, PrPanel, usePrs } from './shipping'

function crewForStage(stage: StageConfig | undefined, crew: CrewMember[]): CrewMember | undefined {
  if (!stage) return undefined
  return crew.find((member) => member.id === stage.crewId) ?? crew.find((member) => member.role === stage.crewRole) ?? crew[0]
}

/** Ticket detail and outputs, refreshed on the ticket's events; outputs at most every 2 s while agents write. */
function useTicket(ticketId: number): { detail: TicketDetail | undefined; outputs: TicketOutputs | undefined; error: string | null } {
  const [detail, setDetail] = useState<TicketDetail>()
  const [outputs, setOutputs] = useState<TicketOutputs>()
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    let cancelled = false
    const loadDetail = (): void => {
      window.eregion.getTicket(ticketId).then(
        (result) => !cancelled && setDetail(result),
        (caught: Error) => !cancelled && setError(caught.message)
      )
    }
    const loadOutputs = (): void => {
      window.eregion.getTicketOutputs(ticketId).then(
        (result) => !cancelled && setOutputs(result),
        () => undefined
      )
    }
    loadDetail()
    loadOutputs()
    const unsubscribe = window.eregion.onEvent((event) => {
      if (event.type === 'ticket-changed' && event.ticketId === ticketId) {
        loadDetail()
        loadOutputs()
      } else if (event.type === 'environment' && event.environment.key === `ticket:${ticketId}`) {
        setDetail((current) => (current ? { ...current, environment: event.environment } : current))
      } else if (event.type === 'run-event' && event.event.kind === 'tool' && !timer.current) {
        timer.current = setTimeout(() => {
          timer.current = null
          loadOutputs()
        }, 2000)
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [ticketId])
  return { detail, outputs, error }
}

/** How a run ended, in a word or two: a usage limit isn't the agent failing. */
function runOutcome(run: RunSummary): string {
  return run.result === 'failed' && usageLimitMessage(run.endNote) ? 'usage limit' : run.result
}

function runLabel(run: RunSummary, stages: StageConfig[], crew: CrewMember[]): string {
  const stage = stages.find((item) => item.id === run.stage)
  const member = crew.find((item) => item.id === run.crewId)
  const pass = stage && isGenericStage(stage) ? ` ${run.loop}` : ''
  return `${stage?.name ?? run.stage}${pass} · ${member?.name ?? run.model}`
}

/** One output file: its name (and anything worth seeing at a glance) as a row that opens and closes it. */
function OutputFile({ name, badge, children }: { name: string; badge?: ReactNode; children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <article className="panel er-output">
      <button type="button" className="er-output-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`er-tool-chevron${open ? ' open' : ''}`} aria-hidden>›</span>
        <span className="mono" style={{ fontWeight: 500 }}>{name}</span>
        {badge}
      </button>
      {open && children}
    </article>
  )
}

function OutputsTab({ ticketId, outputs }: { ticketId: number; outputs: TicketOutputs | undefined }): ReactElement {
  if (!outputs) return <span className="muted">Loading…</span>
  const review = outputs.review?.review
  const files = [
    outputs.plan && (
      <OutputFile key="plan" name="plan.md">
        <Markdown source={outputs.plan.markdown} />
      </OutputFile>
    ),
    outputs.buildNotes && (
      <OutputFile key="notes" name="build-notes.md">
        <Markdown source={outputs.buildNotes.markdown} />
      </OutputFile>
    ),
    outputs.review && (
      <OutputFile
        key="review"
        name="review.json"
        badge={
          review && (
            <StatusPill status={review.verdict === 'pass' ? 'passed' : 'failed'}>
              {review.verdict === 'pass' ? 'Pass' : 'Fail'} · loop {review.loop}
            </StatusPill>
          )
        }
      >
        {review?.summary && <span>{review.summary}</span>}
        {review?.issues.map((issue) => (
          <div key={issue.id} style={{ display: 'flex', gap: 10, fontSize: 14 }}>
            <Severity severity={issue.severity} />
            <span>
              <span className="mono">
                {issue.repo}/{issue.file}
                {issue.line ? `:${issue.line}` : ''}
              </span>{' '}
              · {issue.problem} <span className="muted">Fix: {issue.fix}</span>
            </span>
            {issue.file && issue.repo && <OpenFileButton ticketId={ticketId} repo={issue.repo} file={issue.file} />}
          </div>
        ))}
        {outputs.review.problems.length > 0 && <span className="error-text">{outputs.review.problems.join('; ')}</span>}
        <pre className="mono" style={{ margin: 0, padding: '14px 16px', background: 'var(--forge-900)', color: 'var(--term-text, #D6ECEF)', borderRadius: 10, overflowX: 'auto', fontSize: 12.5 }}>
          {outputs.review.text}
        </pre>
      </OutputFile>
    ),
    outputs.fixes && (
      <OutputFile key="fixes" name="fixes.json">
        {outputs.fixes.fixes?.map((fix) => (
          <div key={fix.issueId} style={{ fontSize: 14 }}>
            <span className="mono">{fix.issueId}</span> · {fix.fixed ? `fixed in ${fix.files.join(', ')}` : `not fixed: ${fix.note}`}
          </div>
        ))}
      </OutputFile>
    ),
    outputs.buildLog && (
      <OutputFile key="build-log" name="build-log.md">
        <Markdown source={outputs.buildLog} />
      </OutputFile>
    )
  ].filter(Boolean)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {files.length ? files : <span className="muted">No output files yet.</span>}
      {outputs.history.length > 0 && (
        <span className="muted" style={{ fontSize: 13 }}>
          Earlier versions in <span className="mono">{outputs.dir}/history</span>: {outputs.history.join(', ')}
        </span>
      )}
    </div>
  )
}

function patchLineColor(line: string): string {
  if (/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(line)) return 'var(--ink-300, #8FA6B2)'
  if (line.startsWith('@@')) return 'var(--aqua-400)'
  if (line.startsWith('+')) return 'var(--term-add, #9FE8D8)'
  if (line.startsWith('-')) return 'var(--term-del, #FFB4A8)'
  return 'var(--term-text, #D6ECEF)'
}

function DiffTab({ ticketId }: { ticketId: number }): ReactElement {
  const [diffs, setDiffs] = useState<RepoDiff[]>()
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => {
    void window.eregion.getTicketDiff(ticketId).then(setDiffs)
  }, [ticketId])
  if (!diffs) return <span className="muted">Loading…</span>
  if (diffs.length === 0) return <span className="muted">No repo is marked as changing yet.</span>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {diffs.map((repo) => (
        <section key={repo.repo} className="panel" aria-label={`${repo.repo} diff`}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
            <h2 style={{ fontSize: 16 }}>{repo.repo}</h2>
            <span className="mono muted">
              {repo.base} … {repo.branch}
            </span>
            <div style={{ flex: 1 }} />
            {repo.files.length > 0 && <OpenInEditor ticketId={ticketId} repos={[repo.repo]} changes />}
          </div>
          {repo.error && <span className="error-text">{repo.error}</span>}
          {!repo.error && repo.files.length === 0 && <span className="muted">No changes on the branch yet.</span>}
          {repo.files.map((file) => (
            <div key={file.path} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button type="button" onClick={() => setOpen(open === `${repo.repo}/${file.path}` ? null : `${repo.repo}/${file.path}`)} style={{ display: 'flex', gap: 10, alignItems: 'center', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
                  <span className="mono">{file.path}</span>
                  <span className="mono" style={{ color: 'var(--primary-700)' }}>+{file.additions}</span>
                  <span className="mono" style={{ color: 'var(--red-700, #B42318)' }}>−{file.deletions}</span>
                  {file.fixes.map((fix) => (
                    <span key={fix.issueId} style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: 'var(--aqua-50)', color: '#2F6F8F' }}>
                      Fixes review issue · {fix.severity === 'medium' ? 'MED' : fix.severity.toUpperCase()}
                    </span>
                  ))}
                </button>
                {!/^deleted file mode/m.test(file.patch) && <OpenFileButton ticketId={ticketId} repo={repo.repo} file={file.path} />}
              </div>
              {open === `${repo.repo}/${file.path}` && (
                <pre className="mono" style={{ margin: 0, padding: '12px 14px', background: 'var(--forge-900)', borderRadius: 10, overflowX: 'auto', fontSize: 12.5, lineHeight: 1.5 }}>
                  {file.patch.split('\n').map((line, index) => (
                    <div key={index} style={{ color: patchLineColor(line) }}>
                      {line || ' '}
                    </div>
                  ))}
                </pre>
              )}
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

function LogTab({ detail, crew }: { detail: TicketDetail; crew: CrewMember[] }): ReactElement {
  const connectors = useConnectors()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <section className="panel" aria-label="Runs">
        <h2 style={{ fontSize: 16 }}>Runs</h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--ink-600)' }}>
              <th>Run</th>
              <th>Model</th>
              <th>Started</th>
              <th>Result</th>
              <th style={{ textAlign: 'right' }}>Tokens</th>
              <th style={{ textAlign: 'right' }}>Cost</th>
            </tr>
          </thead>
          <tbody>
            {detail.runs.map((run) => (
              <tr key={run.id} style={{ borderTop: '1px solid var(--divider-100)' }}>
                <td style={{ padding: '6px 4px' }}>{runLabel(run, detail.stages, crew)}</td>
                <td className="mono">{run.model}</td>
                <td>{run.startedAt}</td>
                <td title={run.endNote ?? undefined}>{runOutcome(run)}</td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {run.tokensIn !== null ? `${(((run.tokensIn ?? 0) + (run.tokensOut ?? 0) + (run.tokensCached ?? 0)) / 1000).toFixed(0)}k` : ''}
                </td>
                <td className="mono" style={{ textAlign: 'right' }}>
                  {run.costUsd !== null ? `${run.costUsd.toFixed(2)}` : noCostLabel(connectors.find((item) => item.id === run.adapter))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="panel" aria-label="Log">
        <h2 style={{ fontSize: 16 }}>Log</h2>
        <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12.5 }}>
          {detail.log.map((entry) => `${entry.ts}  ${entry.kind.padEnd(12)} ${entry.message}`).join('\n') || 'Nothing logged yet.'}
        </pre>
      </section>
    </div>
  )
}

export function TicketScreen({ projectId, ticketId, tab }: { projectId: number; ticketId: number; tab: TicketTab }): ReactElement {
  const { detail, outputs, error } = useTicket(ticketId)
  const crew = useCrew()
  const [selectedRun, setSelectedRun] = useState<number | null>(null)
  const start = useAction(() => window.eregion.startTicket(ticketId))
  const stopRun = useAction(() => window.eregion.stopTicketRun(ticketId))
  const pause = useAction(() => window.eregion.pauseTicket(ticketId))
  const resume = useAction(() => window.eregion.resumeTicket(ticketId))
  const restart = useAction(() => window.eregion.retryTicket(ticketId))
  const discard = useAction(async () => {
    if (window.confirm('Move this ticket back to the Backlog? Its environment is torn down; its branch is kept.')) await window.eregion.discardTicket(ticketId)
  })
  const reset = useAction(async () => {
    if (window.confirm('Reset this ticket to Plan? Every run since the plan was approved is removed from the ticket (Costs still counts them), the code they wrote and the ticket branch are deleted, and the plan waits for your approval again.')) await window.eregion.resetToPlan(ticketId)
  })
  const ticket = detail?.card.ticket
  // A finished ticket opens on its summary; its runs stay one click away.
  const runId = selectedRun ?? ticket?.currentRunId ?? (ticket?.stage === 'done' ? null : (detail?.runs.at(-1)?.id ?? null))
  const view = useRun(runId)
  const prs = usePrs(ticketId)

  useEffect(() => setSelectedRun(null), [ticket?.currentRunId])

  if (error) return <main style={{ padding: 28 }} className="error-text">{error}</main>
  if (!detail || !ticket) return <main style={{ padding: 28 }} className="muted">Loading…</main>

  const stages = detail.stages.filter((stage) => stage.enabled)
  const currentIndex = stages.findIndex((stage) => stage.id === ticket.stage)
  const steps: Step[] = stages.map((stage, index) => {
    const member = crewForStage(stage, crew)
    return {
      label: `${stage.name}${member ? ` · ${member.name}` : ''}`,
      state: ticket.stage === 'done' || (currentIndex >= 0 && index < currentIndex) ? 'done' : index === currentIndex ? 'current' : 'todo'
    }
  })
  const stage = stages[currentIndex]
  const viewedRun = detail.runs.find((run) => run.id === runId)
  const viewedStage = detail.stages.find((item) => item.id === viewedRun?.stage) ?? stage
  const nextStage = currentIndex >= 0 ? (stages[currentIndex + 1] ?? null) : null
  const builder = crewForStage(nextStage ?? undefined, crew)
  const tabs: { id: TicketTab; label: string }[] = [
    { id: 'conversation', label: 'Conversation' },
    { id: 'outputs', label: 'Outputs' },
    { id: 'diff', label: 'Diff' },
    { id: 'log', label: 'Raw log' }
  ]

  return (
    <main style={{ flex: 1, minWidth: 0, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <a href={href({ name: 'board', projectId })} style={{ fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
        ← Board
      </a>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <span className="mono muted" style={{ fontSize: 14 }}>
          {ticket.key}
        </span>
        <h1 style={{ fontSize: 26 }}>{ticket.title}</h1>
        {detail.card.pill && <StatusPill status={detail.card.pill.status}>{detail.card.pill.label}</StatusPill>}
        <div style={{ flex: '1 1 100px' }} />
        {ticket.url && (
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void window.eregion.openExternal(ticket.url as string)}>
            Open in {SOURCE_NAMES[ticket.linear.source ?? 'linear']}
          </button>
        )}
        {ticket.status === 'running' && ticket.currentRunId !== null && (
          <>
            <button type="button" className="er-btn" onClick={() => void pause.run()} disabled={pause.pending} title="Stops the agent but keeps its conversation, so Resume carries on where it was">
              Pause
            </button>
            <button type="button" className="er-btn" onClick={() => void stopRun.run()} disabled={stopRun.pending} title="Ends the run; Start again begins the stage afresh">
              Stop run
            </button>
          </>
        )}
        {ticket.stage !== 'backlog' && ticket.stage !== 'done' && stages[0]?.kind === 'plan' && ticket.stage !== stages[0].id && prs.length === 0 && (
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void reset.run()} disabled={reset.pending}>
            Reset to Plan
          </button>
        )}
        {ticket.stage !== 'backlog' && ticket.stage !== 'done' && (
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void discard.run()} disabled={discard.pending}>
            Move back to Backlog
          </button>
        )}
      </header>

      {ticket.stage !== 'backlog' && <Stepper steps={steps} />}
      {(stopRun.error || discard.error || reset.error || pause.error) && <span className="error-text">{stopRun.error ?? discard.error ?? reset.error ?? pause.error}</span>}

      {ticket.status === 'stopped' && stage && (
        <section className="panel" aria-label="Paused" style={{ border: '2px solid var(--primary-600)' }}>
          <h2 style={{ fontSize: 17 }}>{stage.name} is paused</h2>
          <span className="muted">The agent's conversation and what it wrote are kept, and the environment is still running. Resume carries on where it stopped; starting again begins the stage afresh.</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="er-btn er-btn-primary" onClick={() => void resume.run()} disabled={resume.pending}>
              Resume
            </button>
            <button type="button" className="er-btn" onClick={() => void restart.run()} disabled={restart.pending}>
              Start the stage again
            </button>
          </div>
          {(resume.error || restart.error) && <span className="error-text">{resume.error ?? restart.error}</span>}
        </section>
      )}

      {ticket.stage === 'backlog' && (
        <section className="panel" aria-label="Start">
          <h2 style={{ fontSize: 17 }}>In the Backlog</h2>
          {ticket.description ? <Markdown source={ticket.description} /> : <span className="muted">No description.</span>}
          <div>
            <button type="button" className="er-btn er-btn-primary" onClick={() => void start.run()} disabled={start.pending}>
              Start planning
            </button>
          </div>
          {start.error && <span className="error-text">{start.error}</span>}
        </section>
      )}
      {ticket.stage === 'backlog' && <LinearDetails ticket={ticket} />}
      {ticket.stage === 'done' && <DoneSummary prs={prs} runs={detail.runs} />}

      <StopBanner ticket={ticket} crew={crewForStage(stage, crew)} />
      {ticket.waitingFor === 'slot' && (
        <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--aqua-50)', color: 'var(--ink-deep)' }}>
          Waiting for a free slot. This starts by itself when another ticket's environment is torn down, or raise the live cap in the project's Variables.
        </div>
      )}

      {ticket.stage !== 'backlog' && (
        <>
          <div role="tablist" className="er-tabs" aria-label="Ticket sections">
            {tabs.map((item) => (
              <a key={item.id} role="tab" aria-selected={item.id === tab} className={`er-tab${item.id === tab ? ' er-tab-selected' : ''}`} href={href({ name: 'ticket', projectId, ticketId, tab: item.id })}>
                {item.label}
              </a>
            ))}
          </div>

          {tab === 'conversation' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {(detail.runs.length > 1 || (ticket.stage === 'done' && detail.runs.length > 0)) && (
                <div role="group" aria-label="Runs" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {detail.runs.map((run, index) => {
                    const label = runLabel(run, detail.stages, crew)
                    // A stage started again keeps its pass number, so repeats get a try count.
                    const tries = detail.runs.slice(0, index).filter((other) => runLabel(other, detail.stages, crew) === label).length
                    return (
                      <button key={run.id} type="button" className={`er-btn er-btn-sm${run.id === runId ? ' er-btn-primary' : ''}`} onClick={() => setSelectedRun(run.id)}>
                        {tries > 0 ? `${label} · try ${tries + 1}` : label}
                        {run.result === 'failed' || run.result === 'stopped' ? ` · ${runOutcome(run)}` : ''}
                      </button>
                    )
                  })}
                </div>
              )}
              {(ticket.stage !== 'done' || runId !== null) && (
                <SessionPanel
                  crew={crew.find((member) => member.id === viewedRun?.crewId) ?? crewForStage(viewedStage, crew)}
                  view={view}
                  stageLabel={`${viewedStage?.name ?? 'Stage'} · ${ticket.key}`}
                  placeholder={<span>Nothing has run yet.</span>}
                />
              )}
              {stage?.kind === 'plan' && <PlanPanel ticket={ticket} outputs={outputs} builder={builder} nextStage={nextStage} />}
              {stage?.kind === 'pr' && <PrPanel ticket={ticket} prs={prs} descriptions={outputs?.prDescriptions ?? {}} nextStage={nextStage} sendBackTo={sendBackTarget(stages, stage.id) ?? null} />}
              {stage?.kind === 'ci' && <CiPanel ticket={ticket} prs={prs} stage={stage} sendBackTo={sendBackTarget(stages, stage.id) ?? null} />}
              {ticket.waitingFor === 'manual-review' && stage && <ReviewDecision ticket={ticket} outputs={outputs} stage={stage} sendBackTo={sendBackTarget(stages, stage.id) ?? null} nextStage={nextStage} />}
              {stage && isGenericStage(stage) && ticket.waitingFor === 'approval' && (
                <button type="button" className="er-btn er-btn-primary" onClick={() => void window.eregion.approveStage(ticketId).then(() => navigate({ name: 'ticket', projectId, ticketId, tab: 'conversation' }))}>
                  Approve {stage.name}
                </button>
              )}
              <EnvironmentPanel ticket={ticket} environment={detail.environment} repoNames={ticket.affectedRepos} />
            </div>
          )}
          {tab === 'outputs' && <OutputsTab ticketId={ticketId} outputs={outputs} />}
          {tab === 'diff' && <DiffTab ticketId={ticketId} />}
          {tab === 'log' && <LogTab detail={detail} crew={crew} />}
        </>
      )}
    </main>
  )
}
