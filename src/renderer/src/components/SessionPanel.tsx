import { useEffect, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { ADAPTER_LABELS, type AgentEvent } from '@shared/agent'
import type { CrewMember, RunView } from '@shared/runs'
import { NavIcon } from './icons'
import { CrewAvatar } from './RobotAvatar'
import { Chip } from './ui'
import { HOLD_TO_TALK } from '@shared/voice'
import { DictationStatus, useDictation, useVoice } from '../voice/voice'

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
  /** Events from earlier runs of the same conversation (a Forge chat that was resumed). */
  history?: AgentEvent[]
  /** Takes over sending, so the composer stays open between runs (the Forge starts one on demand). */
  onSend?: (text: string, dictated: boolean) => Promise<void>
  /** Skills you've allowed, offered by the / button. */
  skills?: string[]
}

export function SessionPanel({ crew, view, stageLabel, path, placeholder, minHeight = 420, history, onSend, skills }: SessionPanelProps): ReactElement {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [picking, setPicking] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const live = view?.state === 'running' || view?.state === 'waiting'
  const name = crew?.name ?? 'Agent'
  const events = [...(history ?? []), ...(view?.events ?? [])]

  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight })
  }, [events.length])

  const [dictated, setDictated] = useState(false)
  const voice = useVoice()

  const send = async (delivery: 'now' | 'queue', text = draft.trim(), byVoice = dictated): Promise<void> => {
    if (!text || (!view && !onSend)) return
    setSending(true)
    try {
      if (onSend) await onSend(text, byVoice)
      else if (view) await window.eregion.sendToRun(view.run.id, text, delivery, byVoice)
      setDraft('')
      setDictated(false)
      setError(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(caught))
    } finally {
      setSending(false)
    }
  }

  const dictation = useDictation((text, viaShortcut) => {
    const next = draft.trim() ? `${draft.trimEnd()} ${text}` : text
    if (viaShortcut && voice.settings.sendOnRelease) {
      void send('now', next, true)
    } else {
      setDraft(next)
      setDictated(true)
    }
  })

  const onKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === ' ' && event.ctrlKey) {
      // Hold Ctrl+Space to talk.
      event.preventDefault()
      if (!event.repeat && voice.usable) void dictation.start(true)
      return
    }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send(event.shiftKey ? 'queue' : 'now')
    }
  }

  const onKeyUp = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.key === ' ' || event.key === 'Control') && dictation.state === 'listening') void dictation.stop()
  }

  const waiting = view?.state === 'waiting'
  const canType = onSend ? !sending : live
  const hint = onSend
    ? view?.state === 'running'
      ? `${name} is answering. Enter sends a follow-up.`
      : `Ask ${name} anything. Enter sends.`
    : !view
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
        <CrewAvatar member={crew} size={26} onDark />
        <span className="er-session-name">{name}</span>
        <span>{[crew ? ADAPTER_LABELS[crew.adapter] : null, view?.run.model ?? crew?.model].filter(Boolean).join(' · ')}</span>
        <Chip tone="forge">{stageLabel}</Chip>
        {path && <span className="er-session-path">{path}</span>}
      </div>
      <div ref={body} className="er-session-body" style={{ minHeight, maxHeight: 640, overflowY: 'auto' }}>
        {events.length > 0 ? renderEvents(events) : placeholder}
        {view?.state === 'running' && (
          <div className="er-line-prompt">
            <span className="er-cursor" aria-hidden />
          </div>
        )}
      </div>
      <DictationStatus dictation={dictation} finishHint={`Click the mic, or let go of ${HOLD_TO_TALK}, to finish`} />
      <div className="er-session-foot">
        {voice.settings.engine === 'whisper' && (
          <button
            type="button"
            className="er-mic"
            aria-label={dictation.state === 'listening' ? 'Stop dictating' : 'Dictate'}
            aria-pressed={dictation.state === 'listening'}
            aria-busy={dictation.state === 'transcribing'}
            disabled={!canType || !voice.usable || dictation.state === 'transcribing'}
            title={dictation.state === 'transcribing' ? 'Transcribing…' : voice.usable ? `Click to dictate, or hold ${HOLD_TO_TALK} in the message box` : voice.modelState === 'checking' ? 'Getting dictation ready…' : 'Download a Whisper model in Settings › Voice to dictate'}
            onClick={() => void (dictation.state === 'listening' ? dictation.stop() : dictation.start())}
            style={dictation.state === 'listening' ? { boxShadow: `0 0 0 ${2 + Math.round(dictation.level * 6)}px var(--aqua-400)` } : undefined}
          >
            {dictation.state === 'transcribing' ? <span className="er-spinner" aria-hidden /> : <NavIcon name="mic" />}
          </button>
        )}
        {skills && skills.length > 0 && (
          <span style={{ position: 'relative' }}>
            <button type="button" className="er-btn er-btn-onforge er-btn-sm" aria-label="Use a skill" aria-expanded={picking} onClick={() => setPicking(!picking)} disabled={!canType}>
              /
            </button>
            {picking && (
              <span role="menu" style={{ position: 'absolute', bottom: '120%', left: 0, zIndex: 5, display: 'flex', flexDirection: 'column', minWidth: 220, maxHeight: 260, overflowY: 'auto', background: 'var(--forge-900)', border: '1px solid var(--forge-600)', borderRadius: 8, padding: 4 }}>
                {skills.map((skill) => (
                  <button
                    key={skill}
                    type="button"
                    role="menuitem"
                    className="mono"
                    style={{ textAlign: 'left', background: 'none', border: 'none', color: 'var(--term-text, #D6ECEF)', padding: '6px 8px', cursor: 'pointer', fontSize: 13 }}
                    onClick={() => {
                      setDraft(`/${skill} ${draft.replace(/^\/\S+\s*/, '')}`)
                      setPicking(false)
                    }}
                  >
                    /{skill}
                  </button>
                ))}
              </span>
            )}
          </span>
        )}
        <textarea
          aria-label={`Message ${name}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
          onKeyUp={onKeyUp}
          disabled={!canType}
          rows={1}
          placeholder={dictation.state === 'idle' ? hint : ''}
          style={{ flex: 1, minWidth: 200, resize: 'none', font: 'inherit', fontFamily: 'var(--font-mono)', fontSize: 13, padding: '10px 12px', borderRadius: 8, border: '1px solid var(--forge-600)', background: 'var(--forge-900)', color: 'var(--term-text, #D6ECEF)' }}
        />
        {!onSend && live && view?.takesMessagesMidRun && !waiting && (
          <button type="button" className="er-btn er-btn-onforge er-btn-sm" onClick={() => void send('queue')} disabled={!draft.trim()}>
            Queue
          </button>
        )}
        <button type="button" className="er-btn er-btn-onforge er-btn-sm" onClick={() => void send(waiting || view?.takesMessagesMidRun ? 'now' : 'queue')} disabled={!canType || !draft.trim()}>
          Send
        </button>
        <span>
          Queued for {name}: {view?.queued ?? 0}
        </span>
      </div>
      {(error || dictation.error) && (
        <div className="error-text" style={{ padding: '6px 16px', background: 'var(--surface-0)' }}>
          {error ?? dictation.error}
        </div>
      )}
    </section>
  )
}
