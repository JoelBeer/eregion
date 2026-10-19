import type { ReactElement } from 'react'
import { SetupFooter, type StepProps } from './ProjectSetup'

/** Interim: the Linear and GitHub step is built in a later phase of docs/build-plan.md. */
export function IntegrationsStep({ project, next }: StepProps): ReactElement {
  return (
    <>
      <section className="panel">
        <span className="muted">The Linear and GitHub step isn't built yet.</span>
      </section>
      <SetupFooter project={project} step="integrations" onNext={() => void next()} />
    </>
  )
}
