import type { ReactElement } from 'react'
import { SetupFooter, type StepProps } from './ProjectSetup'

/** Interim: the Pipeline step is built in a later phase of docs/build-plan.md. */
export function PipelineStep({ project, next }: StepProps): ReactElement {
  return (
    <>
      <section className="panel">
        <span className="muted">The Pipeline step isn't built yet.</span>
      </section>
      <SetupFooter project={project} step="pipeline" onNext={() => void next()} />
    </>
  )
}
