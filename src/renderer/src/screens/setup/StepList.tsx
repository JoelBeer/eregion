import type { ReactElement } from 'react'
import type { StepInput } from '@shared/api'
import type { StepConfig } from '@shared/model'
import { render, type Lookup } from '@shared/template'
import { NavIcon } from '../../components/icons'

const TYPE_LABELS: Record<StepConfig['type'], string> = {
  command: 'Command',
  set_env: 'Set .env values',
  copy_file: 'Copy file from main repo',
  script: 'Run script'
}

function emptyConfig(type: StepConfig['type']): StepConfig {
  switch (type) {
    case 'command':
      return { type, command: '' }
    case 'set_env':
      return { type, file: '.env', values: [{ key: '', value: '' }] }
    case 'copy_file':
      return { type, from: '.env', to: '.env' }
    case 'script':
      return { type, path: '', args: '' }
  }
}

function Preview({ text, lookup }: { text: string; lookup: Lookup }): ReactElement | null {
  if (!text.includes('{{')) return null
  const result = render(text, lookup)
  const problems = [...result.missing.map((name) => `unknown ${name}`), ...result.unknownFilters.map((name) => `unknown filter ${name}`)]
  return (
    <span className="mono" style={{ fontSize: 12, color: problems.length ? 'var(--red-700)' : 'var(--ink-600)' }}>
      → {problems.length ? problems.join(', ') : result.text}
    </span>
  )
}

function ConfigFields({ config, onChange, lookup }: { config: StepConfig; onChange: (config: StepConfig) => void; lookup: Lookup }): ReactElement {
  switch (config.type) {
    case 'command':
      return (
        <div className="field" style={{ flex: 1 }}>
          <input className="input mono" aria-label="Command" placeholder="composer install" value={config.command} onChange={(event) => onChange({ ...config, command: event.target.value })} />
          <Preview text={config.command} lookup={lookup} />
        </div>
      )
    case 'script':
      return (
        <div style={{ display: 'flex', gap: 8, flex: 1, flexWrap: 'wrap' }}>
          <input className="input mono" style={{ flex: 2 }} aria-label="Script path on this machine" placeholder="/home/you/scripts/setup.sh" value={config.path} onChange={(event) => onChange({ ...config, path: event.target.value })} />
          <input className="input mono" style={{ flex: 1 }} aria-label="Arguments" placeholder="arguments" value={config.args} onChange={(event) => onChange({ ...config, args: event.target.value })} />
        </div>
      )
    case 'copy_file':
      return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flex: 1 }}>
          <input className="input mono" aria-label="File in the main repo" value={config.from} onChange={(event) => onChange({ ...config, from: event.target.value })} />
          <span className="muted">→</span>
          <input className="input mono" aria-label="Destination in the worktree" value={config.to} onChange={(event) => onChange({ ...config, to: event.target.value })} />
        </div>
      )
    case 'set_env':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
          <input className="input mono" style={{ maxWidth: 200 }} aria-label="File" value={config.file} onChange={(event) => onChange({ ...config, file: event.target.value })} />
          {config.values.map((entry, index) => (
            <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                className="input mono"
                style={{ width: 220 }}
                aria-label="Key"
                placeholder="APP_URL"
                value={entry.key}
                onChange={(event) => onChange({ ...config, values: config.values.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)) })}
              />
              <input
                className="input mono"
                style={{ flex: 1, minWidth: 200 }}
                aria-label="Value"
                placeholder="http://localhost:{{app_port}}"
                value={entry.value}
                onChange={(event) => onChange({ ...config, values: config.values.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)) })}
              />
              <button type="button" className="er-btn er-btn-ghost er-btn-sm" aria-label={`Remove ${entry.key || 'value'}`} onClick={() => onChange({ ...config, values: config.values.filter((_, i) => i !== index) })}>
                Remove
              </button>
              <Preview text={entry.value} lookup={lookup} />
            </div>
          ))}
          <button type="button" className="er-btn er-btn-dashed er-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onChange({ ...config, values: [...config.values, { key: '', value: '' }] })}>
            + Add value
          </button>
        </div>
      )
  }
}

/** Edits an ordered list of setup or teardown steps for one repo. */
export function StepList({ steps, onChange, lookup, addLabel = '+ Add step' }: { steps: StepInput[]; onChange: (steps: StepInput[]) => void; lookup: Lookup; addLabel?: string }): ReactElement {
  const update = (index: number, patch: Partial<StepInput>): void => onChange(steps.map((step, i) => (i === index ? { ...step, ...patch } : step)))
  const move = (index: number, by: number): void => {
    const next = [...steps]
    const [step] = next.splice(index, 1)
    next.splice(index + by, 0, step)
    onChange(next)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {steps.map((step, index) => (
        <div key={index} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: 12, border: '1px solid var(--divider-100)', borderRadius: 10, background: 'var(--surface-25, #F7F8FB)' }}>
          <span style={{ width: 24, height: 24, borderRadius: 999, background: 'var(--primary-50)', color: 'var(--primary-700)', fontSize: 12, fontWeight: 600, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', marginTop: 8 }}>
            {index + 1}
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <select className="select" aria-label="Step type" value={step.config.type} onChange={(event) => update(index, { config: emptyConfig(event.target.value as StepConfig['type']) })}>
                {Object.entries(TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <ConfigFields config={step.config} onChange={(config) => update(index, { config })} lookup={lookup} />
            </div>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                Only if missing
                <input
                  className="input mono"
                  style={{ width: 200, minHeight: 32, padding: '4px 8px' }}
                  placeholder="e.g. vendor"
                  value={step.options.onlyIfMissing ?? ''}
                  onChange={(event) => update(index, { options: { ...step.options, onlyIfMissing: event.target.value || undefined } })}
                />
              </label>
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={step.options.continueOnError ?? false} onChange={(event) => update(index, { options: { ...step.options, continueOnError: event.target.checked || undefined } })} />
                Continue on error
              </label>
              <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                Timeout
                <input
                  className="input"
                  type="number"
                  min={10}
                  style={{ width: 90, minHeight: 32, padding: '4px 8px' }}
                  placeholder="900"
                  value={step.options.timeoutSec ?? ''}
                  onChange={(event) => update(index, { options: { ...step.options, timeoutSec: event.target.value ? Number(event.target.value) : undefined } })}
                />
                seconds
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 2 }}>
            <button type="button" className="er-btn er-btn-ghost er-btn-sm" aria-label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
              <NavIcon name="up" size={16} />
            </button>
            <button type="button" className="er-btn er-btn-ghost er-btn-sm" aria-label="Move down" disabled={index === steps.length - 1} onClick={() => move(index, 1)}>
              <NavIcon name="down" size={16} />
            </button>
            <button type="button" className="er-btn er-btn-ghost er-btn-sm" aria-label="Delete step" onClick={() => onChange(steps.filter((_, i) => i !== index))}>
              <NavIcon name="trash" size={16} />
            </button>
          </div>
        </div>
      ))}
      <button type="button" className="er-btn er-btn-dashed" style={{ alignSelf: 'flex-start' }} onClick={() => onChange([...steps, { config: emptyConfig('command'), options: {} }])}>
        {addLabel}
      </button>
    </div>
  )
}

export function stepTypeLabel(type: StepConfig['type']): string {
  return TYPE_LABELS[type]
}
