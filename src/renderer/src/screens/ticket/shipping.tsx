import { useState, type ReactElement } from 'react'
import type { CheckBucket, PullRequest } from '@shared/integrations'
import { DEFAULT_CI, type StageConfig } from '@shared/pipeline'
import type { RunSummary } from '@shared/runs'
import type { Ticket } from '@shared/tickets'
import { Markdown } from '../../components/Markdown'
import { Chip, StatusPill, Switch, type PillStatus } from '../../components/ui'
import { useAction, useQuery } from '../../hooks'

export function usePrs(ticketId: number): PullRequest[] {
  return useQuery(() => window.eregion.getTicketPrs(ticketId), [ticketId], (event) => event.type === 'ticket-changed' && event.ticketId === ticketId).data ?? []
}

function openLink(url: string): void {
  void window.eregion.openExternal(url)
}

const PR_STATE: Record<PullRequest['state'], { status: PillStatus; label: string }> = {
  open: { status: 'running', label: 'Open' },
  merged: { status: 'passed', label: 'Merged' },
  closed: { status: 'failed', label: 'Closed' }
}

function PrRow({ pr }: { pr: PullRequest }): ReactElement {
  const state = pr.state === 'open' && pr.draft ? { status: 'neutral' as PillStatus, label: 'Draft' } : PR_STATE[pr.state]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <span className="mono" style={{ fontWeight: 600 }}>
        {pr.repo} #{pr.number}
      </span>
      <StatusPill status={state.status}>{state.label}</StatusPill>
      <span className="mono muted" style={{ fontSize: 13 }}>
        {pr.base} ← {pr.branch}
      </span>
      <span className="muted" style={{ fontSize: 13 }}>
        {pr.changedFiles} {pr.changedFiles === 1 ? 'file' : 'files'} <span style={{ color: 'var(--primary-700)' }}>+{pr.additions}</span> <span style={{ color: 'var(--red-700, #B42318)' }}>−{pr.deletions}</span>
      </span>
      <div style={{ flex: 1 }} />
      <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => openLink(pr.url)}>
        Open on GitHub
      </button>
    </div>
  )
}

function Description({ ticket, repo, markdown }: { ticket: Ticket; repo: string; markdown: string }): ReactElement {
  const [editing, setEditing] = useState<string | null>(null)
  const save = useAction(async () => {
    await window.eregion.updatePrDescription(ticket.id, repo, editing ?? markdown)
    setEditing(null)
  })
  return (
    <article style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--divider-100)', paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="mono" style={{ fontWeight: 500 }}>
          pr-{repo}.md
        </span>
        <div style={{ flex: 1 }} />
        {editing === null ? (
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => setEditing(markdown)}>
            Edit
          </button>
        ) : (
          <>
            <button type="button" className="er-btn er-btn-sm" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button type="button" className="er-btn er-btn-sm er-btn-primary" disabled={save.pending} onClick={() => void save.run()}>
              Save and update the PR
            </button>
          </>
        )}
      </div>
      {editing === null ? <Markdown source={markdown} /> : <textarea className="textarea mono" aria-label={`pr-${repo}.md`} rows={14} style={{ fontSize: 12.5 }} value={editing} onChange={(event) => setEditing(event.target.value)} />}
      {save.error && <span className="error-text">{save.error}</span>}
    </article>
  )
}

/** The PR stage: the PRs Eregion opened, their descriptions, and Mark ready for review. */
export function PrPanel({ ticket, prs, descriptions, nextStage }: { ticket: Ticket; prs: PullRequest[]; descriptions: Record<string, string>; nextStage: StageConfig | null }): ReactElement | null {
  const ready = useAction(() => window.eregion.markPrsReady(ticket.id))
  if (prs.length === 0 && Object.keys(descriptions).length === 0) return null
  const drafts = prs.filter((pr) => pr.state === 'open' && pr.draft)
  return (
    <section className="panel" aria-label="Pull requests">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ fontSize: 17 }}>Pull requests</h2>
        <div style={{ flex: 1 }} />
        {ticket.waitingFor === 'ready-for-review' && drafts.length > 0 && (
          <button type="button" className="er-btn er-btn-primary" disabled={ready.pending} onClick={() => void ready.run()}>
            {drafts.length === 1 ? 'Mark ready for review' : drafts.length === 2 ? 'Mark both ready for review' : `Mark all ${drafts.length} ready for review`}
          </button>
        )}
      </div>
      {ticket.waitingFor === 'ready-for-review' && <span className="muted">Marking them ready ends this stage{nextStage ? ` and hands the ticket to ${nextStage.name}` : ''}.</span>}
      {ready.error && <span className="error-text">{ready.error}</span>}
      {prs.map((pr) => (
        <PrRow key={pr.id} pr={pr} />
      ))}
      {Object.entries(descriptions).map(([repo, markdown]) => (
        <Description key={repo} ticket={ticket} repo={repo} markdown={markdown} />
      ))}
    </section>
  )
}

const CHECK_MARK: Record<CheckBucket, { mark: string; color: string; label: string }> = {
  pass: { mark: '✓', color: 'var(--primary-600)', label: 'passed' },
  fail: { mark: '✕', color: 'var(--red-700, #B42318)', label: 'failed' },
  pending: { mark: '○', color: 'var(--amber-800, #92400E)', label: 'running' },
  skipping: { mark: '–', color: 'var(--ink-600)', label: 'skipped' },
  cancel: { mark: '–', color: 'var(--ink-600)', label: 'cancelled' }
}

/** A PR's last-seen checks, with how many passed and which checks they are. */
export function ChecksList({ pr, requiredOnly }: { pr: PullRequest; requiredOnly: boolean }): ReactElement {
  const passed = pr.checks.filter((check) => check.bucket === 'pass' || check.bucket === 'skipping').length
  const scope = pr.checksScope === 'all' && requiredOnly ? `all checks: ${pr.repo} has no required ones` : pr.checksScope === 'required' ? 'required checks' : 'all checks'
  if (pr.checks.length === 0) return <span className="muted">{pr.checkedAt ? 'No checks reported yet.' : 'Not checked yet.'}</span>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {pr.checks.map((item) => (
          <li key={`${item.workflow}-${item.name}`} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            <span aria-label={CHECK_MARK[item.bucket].label} style={{ color: CHECK_MARK[item.bucket].color, width: 14, textAlign: 'center' }}>
              {CHECK_MARK[item.bucket].mark}
            </span>
            <span>{item.workflow ? `${item.workflow} / ${item.name}` : item.name}</span>
            {item.link && (
              <button type="button" className="er-btn er-btn-sm er-btn-ghost" style={{ padding: '0 6px', minHeight: 0 }} onClick={() => openLink(item.link)}>
                Details
              </button>
            )}
          </li>
        ))}
      </ul>
      <span className="muted" style={{ fontSize: 13 }}>
        {passed} of {pr.checks.length} passed · {scope}
      </span>
    </div>
  )
}

/** Watch CI: each PR's checks, autofix, attempts used and merge state. */
export function CiPanel({ ticket, prs, stage }: { ticket: Ticket; prs: PullRequest[]; stage: StageConfig }): ReactElement {
  const settings = { ...DEFAULT_CI, ...stage.ci }
  const autofix = useAction((on: boolean) => window.eregion.setAutofix(ticket.id, on))
  const check = useAction(() => window.eregion.checkCiNow(ticket.id))
  const on = prs.some((pr) => pr.autofix)
  const paused = prs.find((pr) => pr.autofixPausedReason)?.autofixPausedReason
  const lastChecked = prs.map((pr) => pr.checkedAt).filter(Boolean).sort().at(-1) ?? null
  return (
    <section className="panel" aria-label="Watch CI">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 17 }}>Watch CI</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          Checking every {settings.intervalSec} seconds
          {lastChecked ? ` · last checked ${new Date(lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : ' · not checked yet'}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="er-btn er-btn-sm" disabled={check.pending || ticket.currentRunId !== null} onClick={() => void check.run()}>
          {check.pending ? 'Checking…' : 'Check now'}
        </button>
      </div>
      {prs.map((pr) => (
        <div key={pr.id} style={{ display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--divider-100)', paddingTop: 10 }}>
          <PrRow pr={pr} />
          {pr.state === 'open' && <ChecksList pr={pr} requiredOnly={!settings.includeOptionalChecks} />}
          {pr.state === 'open' && (
            <span className="muted" style={{ fontSize: 13 }}>
              Fix attempts used: {pr.attempts} of {settings.maxAttempts}
            </span>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, borderTop: '1px solid var(--divider-100)', paddingTop: 10 }}>
        <Switch label="Fix failing checks automatically" checked={on && !paused} onChange={(value) => void autofix.run(value)} />
        {paused && <span className="muted">Paused: {paused}. Turn it back on to let Eregion fix checks again.</span>}
        <span className="muted" style={{ fontSize: 13 }}>
          A failed check is re-run once first, in case it's flaky. Eregion never force-pushes. When every PR merges, the environment is torn down and the ticket is done.
        </span>
      </div>
      {(autofix.error || check.error) && <span className="error-text">{autofix.error ?? check.error}</span>}
    </section>
  )
}

/** What a finished ticket shows first: what merged, its last checks, and what it cost. */
export function DoneSummary({ prs, runs }: { prs: PullRequest[]; runs: RunSummary[] }): ReactElement {
  const mergedAt = prs
    .map((pr) => pr.mergedAt)
    .filter(Boolean)
    .sort()
    .at(-1)
  const cost = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0)
  const tokens = runs.reduce((sum, run) => sum + (run.tokensIn ?? 0) + (run.tokensOut ?? 0) + (run.tokensCached ?? 0), 0)
  const merged = prs.length > 0 && prs.every((pr) => pr.state === 'merged')
  return (
    <section className="panel" aria-label="Done">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 17 }}>Done</h2>
        <StatusPill status="passed">{merged ? (prs.length === 1 ? 'Merged' : 'All merged') : 'Done'}</StatusPill>
        {mergedAt && (
          <span className="muted" style={{ fontSize: 13 }}>
            {new Date(mergedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}
          </span>
        )}
      </div>
      {prs.map((pr) => (
        <div key={pr.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <PrRow pr={pr} />
          {pr.checks.length > 0 && <ChecksList pr={pr} requiredOnly={false} />}
        </div>
      ))}
      <span>The environment was torn down and its slot freed. The branch is kept.</span>
      <span className="muted" style={{ fontSize: 13 }}>
        {runs.length} {runs.length === 1 ? 'run' : 'runs'}
        {cost > 0 ? ` · $${cost.toFixed(2)} of Claude usage` : ''}
        {tokens > 0 ? ` · ${Math.round(tokens / 1000)}k tokens` : ''}
        {runs.length > 0 ? ' · open a run below to read its conversation' : ''}
      </span>
    </section>
  )
}

/** A ticket from Linear before work starts: what came in, and Pull again. */
export function LinearDetails({ ticket }: { ticket: Ticket }): ReactElement | null {
  const pull = useAction(() => window.eregion.pullTicket(ticket.id))
  if (!ticket.linearId) return null
  const { linear } = ticket
  const facts = [linear.state, linear.priority && linear.priority !== 'No priority' ? `${linear.priority} priority` : null, linear.estimate ? `Estimate ${linear.estimate}` : null, linear.assignee ? `Assigned to ${linear.assignee}` : null].filter(Boolean)
  return (
    <section className="panel" aria-label="From Linear">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 17 }}>From Linear</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          {facts.join(' · ')}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="er-btn er-btn-sm" disabled={pull.pending} onClick={() => void pull.run()}>
          {pull.pending ? 'Pulling…' : 'Pull again'}
        </button>
      </div>
      {(linear.labels ?? []).length > 0 && (
        <div className="er-row">
          {linear.labels?.map((label) => (
            <Chip key={label} tone="info">
              {label}
            </Chip>
          ))}
        </div>
      )}
      {(linear.comments ?? []).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span className="label">Comments</span>
          {linear.comments?.map((comment) => (
            <div key={`${comment.createdAt}-${comment.author}`} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14 }}>
              <span className="muted" style={{ fontSize: 12 }}>
                {comment.author} · {new Date(comment.createdAt).toLocaleString()}
              </span>
              <Markdown source={comment.body} />
            </div>
          ))}
        </div>
      )}
      {pull.error && <span className="error-text">{pull.error}</span>}
    </section>
  )
}
