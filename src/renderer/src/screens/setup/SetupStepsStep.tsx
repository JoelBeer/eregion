import { useEffect, useState, type ReactElement } from 'react'
import type { RepoDetection, RepoRecipe, StepInput, VariablePreview } from '@shared/api'
import { describeStep } from '@shared/recipe'
import { useAction, useQuery } from '../../hooks'
import { previewLookup } from './preview'
import { SetupFooter, type StepProps } from './ProjectSetup'
import { StepList } from './StepList'

function toInputs(recipe: RepoRecipe, phase: 'setup' | 'teardown'): StepInput[] {
  return recipe[phase].map((step) => ({ config: step.config, options: step.options }))
}

export function useRecipe(projectId: number): { recipes: RepoRecipe[] | undefined; preview: VariablePreview | undefined } {
  const recipes = useQuery(() => window.eregion.getRecipe(projectId), [projectId])
  const preview = useQuery(() => window.eregion.previewVariables(projectId), [projectId], (event) => event.type === 'project-changed' && event.projectId === projectId)
  return { recipes: recipes.data, preview: preview.data }
}

function Suggestions({ repoId, current, onUse }: { repoId: number; current: StepInput[]; onUse: (steps: StepInput[]) => void }): ReactElement | null {
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
  if (!detection || detection.recipe.setup.length === 0) return null
  const same = JSON.stringify(detection.recipe.setup) === JSON.stringify(current)
  if (same) return null
  return (
    <div style={{ padding: 12, borderRadius: 10, background: 'var(--aqua-50, #D8F6FA)', color: 'var(--ink-deep)', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 }}>
      <strong>Suggested from what's in the repo</strong>
      <ol style={{ margin: 0, paddingLeft: 18 }}>
        {detection.recipe.setup.map((step, index) => (
          <li key={index} className="mono">
            {describeStep(step.config)}
            {step.options.onlyIfMissing ? ` (only if ${step.options.onlyIfMissing} is missing)` : ''}
          </li>
        ))}
      </ol>
      <button type="button" className="er-btn er-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => onUse(detection.recipe.setup)}>
        {current.length === 0 ? 'Use these steps' : 'Replace my steps with these'}
      </button>
    </div>
  )
}

export function SetupStepsStep({ project, next }: StepProps): ReactElement {
  const { recipes, preview } = useRecipe(project.id)
  const [drafts, setDrafts] = useState<Record<number, StepInput[]>>({})
  const [parallel, setParallel] = useState(project.setupInParallel)

  useEffect(() => {
    if (recipes) setDrafts(Object.fromEntries(recipes.map((recipe) => [recipe.repo.id, toInputs(recipe, 'setup')])))
  }, [recipes])

  const save = useAction(async () => {
    for (const [repoId, steps] of Object.entries(drafts)) {
      await window.eregion.saveSteps(Number(repoId), 'setup', steps)
    }
    if (parallel !== project.setupInParallel) await window.eregion.updateProject(project.id, { setupInParallel: parallel })
    await next()
  })

  if (!recipes) return <span className="muted">Loading…</span>

  return (
    <>
      {preview && (
        <div className="muted" style={{ fontSize: 13 }}>
          Previewing for {preview.sample.key}, slot {preview.sample.slot}:{' '}
          <span className="mono">{Object.entries(preview.values).map(([name, value]) => `${name} = ${value}`).join(' · ') || 'no variables yet'}</span>
        </div>
      )}
      {recipes.map((recipe) => (
        <section key={recipe.repo.id} aria-label={`${recipe.repo.name} setup`} className="panel">
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <h2 style={{ fontSize: 17 }}>{recipe.repo.name}</h2>
            <span className="mono muted">{recipe.repo.runtime}</span>
            <span className="mono muted">{recipe.repo.path}</span>
          </div>
          <Suggestions repoId={recipe.repo.id} current={drafts[recipe.repo.id] ?? []} onUse={(steps) => setDrafts({ ...drafts, [recipe.repo.id]: steps })} />
          <StepList steps={drafts[recipe.repo.id] ?? []} onChange={(steps) => setDrafts({ ...drafts, [recipe.repo.id]: steps })} lookup={previewLookup(preview, recipe.repo)} />
        </section>
      ))}
      {recipes.length > 1 && (
        <fieldset className="panel" style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <legend className="label">Repo order</legend>
          <label style={{ display: 'inline-flex', gap: 6 }}>
            <input type="radio" name="order" checked={!parallel} onChange={() => setParallel(false)} />
            {recipes.map((recipe) => recipe.repo.name).join(', then ')}
          </label>
          <label style={{ display: 'inline-flex', gap: 6 }}>
            <input type="radio" name="order" checked={parallel} onChange={() => setParallel(true)} />
            In parallel
          </label>
        </fieldset>
      )}
      {save.error && <span className="error-text">{save.error}</span>}
      <SetupFooter project={project} step="setup" onNext={() => void save.run()} disabled={save.pending} />
    </>
  )
}
