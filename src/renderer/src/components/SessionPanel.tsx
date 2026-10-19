import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { ADAPTER_LABELS, type AgentEvent } from '@shared/agent'
import type { CrewMember, RunView } from '@shared/runs'
import { NavIcon } from './icons'
import { RobotAvatar } from './RobotAvatar'
import { Chip } from './ui'

/** Follows a run: loads it, then applies its events and state changes as they arrive. */
export function useRun(runId: number | null): RunView | null {
  const [view, setView] = useState<RunView | null>(null)
  useEffect(() => {
    if (runId === null) {
      setView(null)
      return
    }
    let cancelled = false
    void window.eregion.getRun(runId).then((result) => !cancelled && setView(result))
    const unsubscribe = window.eregion.onEvent((event) => {
      if (event.type === 'run-event' && event.runId === runId) {
        setView((current) => (current ? { ...current, events: [...current.events, event.event] } : current))
      } else if (event.type === 'run-state' && event.runId === runId) {
        setView((current) => (current ? { ...current, state: event.state, queued: event.queued } : current))
      }
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [runId])
  return view
}

function Line({ kind, children, tag }: { kind: 'agent' | 'user' | 'tool' | 'system' | 'error'; children: ReactNode; tag?: string }): ReactElement {
  return (
    <div className={`er-line-${kind}`}>
      {children}
      {tag && <span className="er-tag">{tag}</span>}
    </div>
  )
}

/** Groups consecutive tool calls with their results, so a burst of work reads as one block. */
function renderEvents(events: AgentEvent[]): ReactElement[] {
  const lines: ReactElement[] = []
  const results = new Map<string, { ok: boolean; output: string }>()
  for (const event of events) if (event.kind === 'tool-result') results.set(event.id, event)
  let tools: ReactElement[] = []
  const flush = (): void => {
    if (tools.length) lines.push(<Line key={`tools-${lines.length}`} kind="tool">{tools}</Line>)
    tools = []
  }
  events.forEach((event, index) => {
    switch (event.kind) {
      case 'tool': {
        const result = results.get(event.id)
        tools.push(
          <span key={index}>
            {event.summary}
            {result && !result.ok && <span className="del"> failed</span>}
          </span>
        )
        return
      }
      case 'tool-result':
      case 'init':
        return
      case 'text':
        flush()
        lines.push(
          <Line key={index} kind="agent">
            <span style={{ whiteSpace: 'pre-wrap' }}>{event.text}</span>
          </Line>
        )
        return
      case 'user':
        flush()
        lines.push(
          <Line key={index} kind="user" tag={[event.dictated ? 'dictated' : null, event.delivery === 'queue' ? 'queued' : event.delivery === 'now' ? 'sent now' : null].filter(Boolean).join(' · ') || undefined}>
            <span style={{ whiteSpace: 'pre-wrap' }}>{event.text}</span>
          </Line>
        )
        return
      case 'result':
        flush()
        if (!event.ok) lines.push(<Line key={index} kind="error">{event.text || 'The agent stopped with an error.'}</Line>)
        return
      case 'system':
        flush()
        lines.push(<Line key={index} kind="system">{event.text}</Line>)
        return
      case 'error':
        flush()
        lines.push(<Line key={index} kind="error">{event.text}</Line>)
    }
  })
  flush()
  return lines
}

export interface SessionPanelProps {
  crew: CrewMember | undefined
  view: RunView | null
  stageLabel: string
  path?: string
  placeholder?: ReactNode
  minHeight?: number
}

export function SessionPanel({ crew, view, stageLabel, path, placeholder, minHeight = 420 }: SessionPanelProps): ReactElement {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const body = useRef<HTMLDivElement>(null)
  const live = view?.state === 'running' || view?.state === 'waiting'
  const name = crew?.name ?? 'Agent'

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight })
  }, [view?.events.length])

  const send = async (delivery: 'now' | 'queue'): Promise<void> => {
    const text = draft.trim()
    if (!text || !view) return
    try {
      await window.eregion.sendToRun(view.run.id, text, delivery, false)
      setDraft('')
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(caught))
    }
  }

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send(event.shiftKey ? 'queue' : 'now')
    }
  }

  const waiting = view?.state === 'waiting'
  const hint = !view
    ? `Nothing running for ${name} yet`
    : !live
      ? 'This run has ended'
      : waiting
        ? `${name} is waiting for you. Enter sends.`
        : view.takesMessagesMidRun
          ? 'Enter sends now · Shift+Enter queues for after this step'
          : `Messages wait until ${name}'s current run ends`

  return (
    <section className="er-session" aria-label={`${name}'s session`} style={{ width: '100%' }}>
      <div className="er-session-head">
        <RobotAvatar seed={crew?.seed} size={26} onDark />
        <span className="er-session-name">{name}</span>
        <span>{[crew ? ADAPTER_LABELS[crew.adapter] : null, view?.run.model ?? crew?.model].filter(Boolean).join(' · ')}</span>
        <Chip tone="forge">{stageLabel}</Chip>
        {path && <span className="er-session-path">{path}</span>}
      </div>
      <div ref={body} className="er-session-body" style={{ minHeight, maxHeight: 640, overflowY: 'auto' }}>
        {view ? renderEvents(view.events) : placeholder}
        {view?.state === 'running' && (
          <div className="er-line-prompt">
            <span className="er-cursor" aria-hidden />
          </div>
        )}
      </div>
      <div className="er-session-foot">
        <button type="button" className="er-mic" aria-label="Dictate" disabled title="Voice dictation is set up in Settings › Voice">
          <NavIcon name="mic" />
        </button>
        <textarea
          aria-label={`Message ${name}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
          disabled={!live}
          rows={1}
          placeholder={hint}
          style={{ flex: 1, minWidth: 200, resize: 'none', font: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 13, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--forge-600)', background: 'var(--forge-900)', color: 'var(--term-text, #D6ECEF)' }}
        />
        {live && view?.takesMessagesMidRun && !waiting && (
          <button type="button" className="er-btn er-btn-onforge er-btn-sm" onClick={() => void send('queue')} disabled={!draft.trim()}>
            Queue
          </button>
        )}
        <button type="button" className="er-btn er-btn-onforge er-btn-sm" onClick={() => void send(waiting || view?.takesMessagesMidRun ? 'now' : 'queue')} disabled={!live || !draft.trim()}>
          Send
        </button>
        <span>
          Queued for {name}: {view?.queued ?? 0}
        </span>
      </div>
      {error && (
        <div className="error-text" style={{ padding: '6px 16px', background: 'var(--surface-0)' }}>
          {error}
        </div>
      )}
    </section>
  )
}
