import { useEffect, useState, type ReactElement } from 'react'
import type { RepoDetection, ServiceInput, StepInput } from '@shared/api'
import type { ReadyCheck } from '@shared/model'
import { describeStep } from '@shared/recipe'
import { render, type Lookup } from '@shared/template'
import { NavIcon } from '../../components/icons'
import { useAction } from '../../hooks'
import { previewLookup } from './preview'
import { SetupFooter, type StepProps } from './ProjectSetup'
import { useRecipe } from './SetupStepsStep'
import { StepList } from './StepList'

function ServiceEditor({ service, onChange, onRemove, lookup }: { service: ServiceInput; onChange: (service: ServiceInput) => void; onRemove: () => void; lookup: Lookup }): ReactElement {
  const check = service.readyCheck
  const setCheck = (readyCheck: ReadyCheck): void => onChange({ ...service, readyCheck })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, border: '1px solid var(--divider-100)', borderRadius: 10, background: 'var(--surface-25, #F7F8FB)' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input className="input" aria-label="Service name" style={{ width: 160, fontWeight: 600 }} placeholder="app" value={service.name} onChange={(event) => onChange({ ...service, name: event.target.value })} />
        <span className="muted" style={{ fontSize: 12 }}>
          long-running process
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="er-btn er-btn-ghost er-btn-sm" aria-label={`Delete ${service.name || 'service'}`} onClick={onRemove}>
          <NavIcon name="trash" size={16} />
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '120px minmax(0,1fr)', gap: '8px 10px', alignItems: 'center' }}>
        <span className="muted">Start</span>
        <div className="field">
          <input className="input mono" aria-label="Start command" placeholder="php artisan serve --port={{app_port}}" value={service.command} onChange={(event) => onChange({ ...service, command: event.target.value })} />
          {service.command.includes('{{') && (
            <span className="mono muted" style={{ fontSize: 12 }}>
              → {render(service.command, lookup).text}
            </span>
          )}
        </div>
        <span className="muted">Ready when</span>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            className="select"
            aria-label="Ready check"
            value={check.kind}
            onChange={(event) => {
              const kind = event.target.value as ReadyCheck['kind']
              setCheck(kind === 'http' ? { kind, url: 'http://localhost:{{app_port}}', timeoutSec: 60 } : kind === 'port' ? { kind, port: '{{app_port}}', timeoutSec: 60 } : { kind: 'none' })
            }}
          >
            <option value="http">A URL responds</option>
            <option value="port">A port accepts connections</option>
            <option value="none">Straight away</option>
          </select>
          {check.kind === 'http' && <input className="input mono" style={{ flex: 1, minWidth: 220 }} aria-label="URL" value={check.url} onChange={(event) => setCheck({ ...check, url: event.target.value })} />}
          {check.kind === 'port' && <input className="input mono" style={{ width: 160 }} aria-label="Port" value={check.port} onChange={(event) => setCheck({ ...check, port: event.target.value })} />}
          {check.kind !== 'none' && (
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              within
              <input className="input" type="number" min={5} style={{ width: 80 }} value={check.timeoutSec} onChange={(event) => setCheck({ ...check, timeoutSec: Math.max(5, Number(event.target.value) || 60) })} />
              seconds
            </label>
          )}
        </div>
        <span className="muted">Open button</span>
        <input className="input mono" aria-label="Open URL" placeholder="http://localhost:{{app_port}} (leave blank for none)" value={service.openUrl ?? ''} onChange={(event) => onChange({ ...service, openUrl: event.target.value || null })} />
      </div>
    </div>
  )
}

function SuggestedServices({ repoId, onUse }: { repoId: number; onUse: (services: ServiceInput[], teardown: StepInput[]) => void }): ReactElement | null {
  const [detection, setDetection] = useState<RepoDetection | null>(null)
  useEffect(() => {
    let cancelled = false
    window.eregion.suggestRecipe(repoId).then(
      (result) => !cancelled && setDetection(result),
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [repoId])
  if (!detection || (detection.recipe.services.length === 0 && detection.recipe.teardown.length === 0)) return null
  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'var(--aqua-50, #D8F6FA)', color: 'var(--ink-deep)', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
      <strong>Suggested from what's in the repo</strong>
      {detection.recipe.services.map((service) => (
        <span key={service.name} className="mono">
          {service.name}: {service.command}
        </span>
      ))}
      {detection.recipe.teardown.map((step, index) => (
        <span key={index} className="mono">
          teardown: {describeStep(step.config)}
        </span>
      ))}
      <button type="button" className="er-btn er-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onUse(detection.recipe.services, detection.recipe.teardown)}>
        Use these
      </button>
    </div>
  )
}

export function ServicesStep({ project, next }: StepProps): ReactElement {
  const { recipes, preview } = useRecipe(project.id)
  const [services, setServices] = useState<Record<number, ServiceInput[]>>({})
  const [teardown, setTeardown] = useState<Record<number, StepInput[]>>({})

  useEffect(() => {
    if (!recipes) return
    setServices(Object.fromEntries(recipes.map((recipe) => [recipe.repo.id, recipe.services.map(({ name, command, readyCheck, openUrl }) => ({ name, command, readyCheck, openUrl }))])))
    setTeardown(Object.fromEntries(recipes.map((recipe) => [recipe.repo.id, recipe.teardown.map(({ config, options }) => ({ config, options }))])))
  }, [recipes])

  const save = useAction(async () => {
    for (const [repoId, list] of Object.entries(services)) await window.eregion.saveServices(Number(repoId), list.filter((service) => service.name.trim() && service.command.trim()))
    for (const [repoId, list] of Object.entries(teardown)) await window.eregion.saveSteps(Number(repoId), 'teardown', list)
    await next()
  })

  if (!recipes) return <span className="muted">Loading…</span>

  return (
    <>
      <section aria-label="Services" className="panel">
        <h2 style={{ fontSize: 17 }}>Services</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          Started after setup, kept running while the ticket has its environment, and stopped at teardown.
        </span>
        {recipes.map((recipe) => (
          <div key={recipe.repo.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <strong>{recipe.repo.name}</strong>
            {(services[recipe.repo.id] ?? []).length === 0 && (teardown[recipe.repo.id] ?? []).length === 0 && (
              <SuggestedServices
                repoId={recipe.repo.id}
                onUse={(suggestedServices, suggestedTeardown) => {
                  setServices({ ...services, [recipe.repo.id]: suggestedServices })
                  setTeardown({ ...teardown, [recipe.repo.id]: suggestedTeardown })
                }}
              />
            )}
            {(services[recipe.repo.id] ?? []).map((service, index) => (
              <ServiceEditor
                key={index}
                service={service}
                lookup={previewLookup(preview, recipe.repo)}
                onChange={(changed) => setServices({ ...services, [recipe.repo.id]: services[recipe.repo.id].map((item, i) => (i === index ? changed : item)) })}
                onRemove={() => setServices({ ...services, [recipe.repo.id]: services[recipe.repo.id].filter((_, i) => i !== index) })}
              />
            ))}
            <button
              type="button"
              className="er-btn er-btn-dashed er-btn-sm"
              style={{ alignSelf: 'flex-start' }}
              onClick={() =>
                setServices({ ...services, [recipe.repo.id]: [...(services[recipe.repo.id] ?? []), { name: '', command: '', readyCheck: { kind: 'http', url: 'http://localhost:{{app_port}}', timeoutSec: 60 }, openUrl: null }] })
              }
            >
              + Add service
            </button>
          </div>
        ))}
      </section>

      <section aria-label="Teardown" className="panel">
        <h2 style={{ fontSize: 17 }}>Teardown</h2>
        <span className="muted" style={{ fontSize: 13 }}>
          Runs when a ticket's PRs merge, or when you discard a ticket. Eregion always stops the ticket's services first, then runs your steps, then removes the worktrees and frees the slot.
        </span>
        {recipes.map((recipe) => (
          <div key={recipe.repo.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <strong>{recipe.repo.name}</strong>
            <StepList steps={teardown[recipe.repo.id] ?? []} onChange={(steps) => setTeardown({ ...teardown, [recipe.repo.id]: steps })} lookup={previewLookup(preview, recipe.repo)} addLabel="+ Add teardown step" />
          </div>
        ))}
      </section>
      {save.error && <span className="error-text">{save.error}</span>}
      <SetupFooter project={project} step="services" onNext={() => void save.run()} disabled={save.pending} />
    </>
  )
}
