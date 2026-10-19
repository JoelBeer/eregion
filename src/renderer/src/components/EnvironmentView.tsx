import { useEffect, useState, type ReactElement } from 'react'
import type { Environment, EnvironmentStep } from '@shared/environment'
import { StatusPill } from './ui'

/** Follows one environment: loads it once, then applies every environment event for its key. */
export function useEnvironment(key: string): [Environment | null, (environment: Environment | null) => void] {
  const [environment, setEnvironment] = useState<Environment | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.eregion.getEnvironment(key).then((result) => !cancelled && setEnvironment(result))
    const unsubscribe = window.eregion.onEvent((event) => {
      if (event.type === 'environment' && event.environment.key === key) setEnvironment(event.environment)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [key])
  return [environment, setEnvironment]
}

const STEP_MARK: Record<EnvironmentStep['status'], { mark: string; color: string; label: string }> = {
  running: { mark: '…', color: 'var(--primary-600)', label: 'Running' },
  done: { mark: '✓', color: 'var(--primary-600)', label: 'Done' },
  skipped: { mark: '–', color: 'var(--ink-600)', label: 'Skipped' },
  failed: { mark: '✕', color: 'var(--red-700, #B42318)', label: 'Failed' },
  'failed-continued': { mark: '!', color: 'var(--amber-800, #92400E)', label: 'Failed, continued' }
}

export function StepRows({ steps }: { steps: EnvironmentStep[] }): ReactElement {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {steps.map((step, index) => {
        const mark = STEP_MARK[step.status]
        const showOutput = step.status === 'failed' || step.status === 'failed-continued' || step.status === 'skipped'
        return (
          <li key={index} style={{ display: 'grid', gridTemplateColumns: '20px minmax(0,1fr) auto', gap: '2px 8px', fontSize: 13 }}>
            <span aria-label={mark.label} style={{ color: mark.color, fontWeight: 700 }}>
              {mark.mark}
            </span>
            <span className="mono" style={{ wordBreak: 'break-word' }}>
              {step.label}
            </span>
            <span className="muted" style={{ fontSize: 12 }}>
              {step.durationMs !== undefined ? `${(step.durationMs / 1000).toFixed(1)} s` : ''}
            </span>
            {showOutput && step.output && (
              <pre className="mono" style={{ gridColumn: '2 / 4', margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, color: step.status === 'skipped' ? 'var(--ink-600)' : 'var(--red-700, #B42318)', maxHeight: 160, overflow: 'auto' }}>
                {step.output.slice(-2000)}
              </pre>
            )}
          </li>
        )
      })}
    </ol>
  )
}

export function ServiceRows({ environment }: { environment: Environment }): ReactElement | null {
  if (environment.services.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {environment.services.map((service) => (
        <div key={`${service.repoName}-${service.name}`} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <strong>{service.name}</strong>
            <span className="muted" style={{ fontSize: 12 }}>
              {service.repoName}
            </span>
            <StatusPill status={service.state === 'ready' ? 'passed' : service.state === 'starting' ? 'running' : service.state === 'failed' ? 'failed' : 'idle'}>
              {service.state === 'ready' ? 'Ready' : service.state === 'starting' ? 'Starting' : service.state === 'failed' ? 'Failed' : 'Stopped'}
            </StatusPill>
            {service.openUrl && service.state === 'ready' && (
              <button type="button" className="er-btn er-btn-sm er-btn-primary" onClick={() => void window.eregion.openExternal(service.openUrl as string)}>
                Open app
              </button>
            )}
            {service.openUrl && <span className="mono muted">{service.openUrl}</span>}
          </div>
          {service.state === 'failed' && service.log.length > 0 && (
            <pre className="mono" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12, color: 'var(--red-700, #B42318)', maxHeight: 160, overflow: 'auto' }}>
              {service.log.slice(-15).join('\n')}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}
