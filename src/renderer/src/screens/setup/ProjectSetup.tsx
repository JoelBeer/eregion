import type { ReactElement, ReactNode } from 'react'
import type { Project } from '@shared/model'
import { useQuery } from '../../hooks'
import { href, navigate, SETUP_STEP_LABELS, SETUP_STEPS, type SetupStep } from '../../router'
import { PipelineStep } from './PipelineStep'
import { IntegrationsStep } from './IntegrationsStep'
import { ReposStep } from './ReposStep'
import { ServicesStep } from './ServicesStep'
import { SetupStepsStep } from './SetupStepsStep'
import { TestRunStep } from './TestRunStep'
import { VariablesStep } from './VariablesStep'

const TITLES: Record<SetupStep, string> = {
  repos: 'Which repos make up this project?',
  variables: 'What changes per ticket?',
  setup: 'How is a ticket environment set up?',
  services: 'What runs, and how do we clean up?',
  pipeline: 'Which stages does a ticket go through?',
  integrations: 'Connect Linear and GitHub',
  test: 'Try the whole setup once'
}

export interface StepProps {
  project: Project
  /** Saves the step and moves to the next one, remembering how far setup has got. */
  next: () => Promise<void>
}

export function SetupFooter({ project, step, onNext, nextLabel, disabled, extra }: { project: Project; step: SetupStep; onNext: () => void; nextLabel?: string; disabled?: boolean; extra?: ReactNode }): ReactElement {
  const index = SETUP_STEPS.indexOf(step)
  const following = SETUP_STEPS[index + 1]
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, marginTop: 'auto', paddingTop: 8 }}>
      {extra}
      {index > 0 && (
        <a className="er-btn" href={href({ name: 'setup', projectId: project.id, step: SETUP_STEPS[index - 1] })}>
          Back
        </a>
      )}
      <button type="button" className="er-btn er-btn-primary" onClick={onNext} disabled={disabled}>
        {nextLabel ?? (following ? `Next: ${SETUP_STEP_LABELS[following]}` : 'Finish setup')}
      </button>
    </div>
  )
}

export function ProjectSetup({ projectId, step }: { projectId: number; step: SetupStep }): ReactElement {
  const project = useQuery(() => window.eregion.getProject(projectId), [projectId], (event) => event.type === 'project-changed' && event.projectId === projectId)

  if (project.error) return <main style={{ padding: 28 }} className="error-text">{project.error}</main>
  if (!project.data) return <main style={{ padding: 28 }} className="muted">Loading…</main>

  const current = project.data
  const finished = current.setupStep >= 8
  const index = SETUP_STEPS.indexOf(step)
  const next = async (): Promise<void> => {
    const reached = Math.max(current.setupStep, index + 2)
    if (reached !== current.setupStep && !finished) await window.eregion.updateProject(current.id, { setupStep: Math.min(reached, 7) })
    const following = SETUP_STEPS[index + 1]
    navigate(following ? { name: 'setup', projectId: current.id, step: following } : { name: 'board', projectId: current.id })
  }

  const props: StepProps = { project: current, next }
  const body = {
    repos: <ReposStep {...props} />,
    variables: <VariablesStep {...props} />,
    setup: <SetupStepsStep {...props} />,
    services: <ServicesStep {...props} />,
    pipeline: <PipelineStep {...props} />,
    integrations: <IntegrationsStep {...props} />,
    test: <TestRunStep {...props} />
  }[step]

  return (
    <main style={{ flex: 1, minWidth: 0, padding: 28, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {finished ? `${current.name} · Settings` : `New project · ${current.name}`}
        </span>
        <h1 style={{ fontSize: 26 }}>{finished ? SETUP_STEP_LABELS[step] : TITLES[step]}</h1>
      </header>
      <ol aria-label="Project setup steps" className="er-steps">
        {SETUP_STEPS.map((id, i) => {
          const state = id === step ? 'current' : finished || i + 1 < current.setupStep ? 'done' : 'todo'
          const reachable = finished || i + 1 <= current.setupStep
          const text = (state === 'done' ? '✓ ' : `${i + 1} · `) + SETUP_STEP_LABELS[id]
          return (
            <li key={id}>
              {reachable ? (
                <a className={`er-step er-step-${state}`} href={href({ name: 'setup', projectId: current.id, step: id })} aria-current={state === 'current' ? 'step' : undefined}>
                  {text}
                </a>
              ) : (
                <span className={`er-step er-step-${state}`}>{text}</span>
              )}
            </li>
          )
        })}
      </ol>
      {body}
    </main>
  )
}
