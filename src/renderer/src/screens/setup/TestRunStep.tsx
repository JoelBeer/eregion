import type { ReactElement } from 'react'
import { SetupFooter, type StepProps } from './ProjectSetup'

/** Interim: the Test run step is built in a later phase of docs/build-plan.md. */
export function TestRunStep({ project, next }: StepProps): ReactElement {
  return (
    <>
      <section className="panel">
        <span className="muted">The Test run step isn't built yet.</span>
      </section>
      <SetupFooter project={project} step="test" onNext={() => void next()} />
    </>
  )
}
