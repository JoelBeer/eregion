import { useEffect, useState, type ReactElement } from 'react'
import type { VariablePreview } from '@shared/api'
import { BUILTIN_PLACEHOLDERS, type Variable } from '@shared/model'
import { NavIcon } from '../../components/icons'
import { useAction } from '../../hooks'
import { SetupFooter, type StepProps } from './ProjectSetup'

export function VariablesStep({ project, next }: StepProps): ReactElement {
  const [variables, setVariables] = useState<Variable[]>(project.variables)
  const [liveSlots, setLiveSlots] = useState(project.liveSlots)
  const [preview, setPreview] = useState<VariablePreview>()
  useEffect(() => {
    setVariables(project.variables)
    setLiveSlots(project.liveSlots)
  }, [project.id])

  useEffect(() => {
    let cancelled = false
    void window.eregion.previewVariables(project.id, variables).then((result) => !cancelled && setPreview(result))
    return () => {
      cancelled = true
    }
  }, [project.id, variables])

  const update = (index: number, patch: Partial<Variable>): void => setVariables(variables.map((variable, i) => (i === index ? { ...variable, ...patch } : variable)))
  const hasErrors = preview ? Object.keys(preview.errors).length > 0 : false
  const save = useAction(async () => {
    const kept = variables.filter((variable) => variable.name.trim() || variable.formula.trim())
    await window.eregion.updateProject(project.id, { variables: kept, liveSlots })
    await next()
  })

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, alignItems: 'flex-start' }}>
        <section aria-label="Your variables" className="panel" style={{ flex: '3 1 560px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h2 style={{ fontSize: 17 }}>Your variables</h2>
            {preview && (
              <span className="muted" style={{ fontSize: 13 }}>
                Previewing for {preview.sample.key} · slot {preview.sample.slot}
              </span>
            )}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', fontSize: 12, color: 'var(--ink-600)' }}>
                <th style={{ padding: '6px 4px' }}>Name</th>
                <th style={{ padding: '6px 4px' }}>Formula</th>
                <th style={{ padding: '6px 4px' }}>Preview</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {variables.map((variable, index) => {
                const error = preview?.errors[variable.name]
                return (
                  <tr key={index} style={{ borderTop: '1px solid var(--divider-100)' }}>
                    <td style={{ padding: '6px 4px', width: 180 }}>
                      <input className="input mono" aria-label="Variable name" placeholder="app_port" value={variable.name} onChange={(event) => update(index, { name: event.target.value })} />
                    </td>
                    <td style={{ padding: '6px 4px' }}>
                      <input className="input mono" style={{ width: '100%' }} aria-label="Formula" placeholder="8100 + {{slot}}" value={variable.formula} onChange={(event) => update(index, { formula: event.target.value })} />
                    </td>
                    <td style={{ padding: '6px 4px', minWidth: 160 }} className="mono">
                      {error ? <span className="error-text">{error}</span> : preview?.values[variable.name] ?? ''}
                    </td>
                    <td style={{ padding: '6px 4px', width: 44 }}>
                      <button type="button" className="er-btn er-btn-ghost er-btn-sm" aria-label={`Delete ${variable.name || 'variable'}`} onClick={() => setVariables(variables.filter((_, i) => i !== index))}>
                        <NavIcon name="trash" size={16} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <button type="button" className="er-btn er-btn-dashed" style={{ alignSelf: 'flex-start' }} onClick={() => setVariables([...variables, { name: '', formula: '' }])}>
            + Add variable
          </button>
          <span className="muted" style={{ fontSize: 13 }}>
            Formulas can use the built-ins and other variables. Plain sums such as 3000 + {'{{slot}}'} are worked out.
          </span>
        </section>

        <aside style={{ flex: '2 1 300px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <section className="panel" aria-label="Built in">
            <h2 style={{ fontSize: 17 }}>Built in</h2>
            {BUILTIN_PLACEHOLDERS.map((builtin) => (
              <div key={builtin.name} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span className="mono">{`{{${builtin.name}}}`}</span>
                <span className="muted" style={{ fontSize: 13 }}>
                  {builtin.describe}
                </span>
              </div>
            ))}
            <span className="muted" style={{ fontSize: 13 }}>
              Filters: <span className="mono">| slug</span> (pp-412), <span className="mono">| snake</span> (pp_412), <span className="mono">| lower</span>, <span className="mono">| upper</span>.
            </span>
          </section>
          <section className="panel" aria-label="Live environments">
            <label className="label" htmlFor="live-slots" style={{ fontSize: 15 }}>
              Live environments at once
            </label>
            <input id="live-slots" className="input" type="number" min={1} max={20} style={{ width: 110 }} value={liveSlots} onChange={(event) => setLiveSlots(Math.max(1, Number(event.target.value) || 1))} />
            <span className="muted" style={{ fontSize: 13 }}>
              Each one is a full copy of the project's repos and running services. Tickets wait in Plan when slots run out.
            </span>
          </section>
        </aside>
      </div>
      {save.error && <span className="error-text">{save.error}</span>}
      <SetupFooter project={project} step="variables" onNext={() => void save.run()} disabled={hasErrors || save.pending} />
    </>
  )
}
