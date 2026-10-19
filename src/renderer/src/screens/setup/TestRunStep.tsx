import { useState, type ReactElement } from 'react'
import { ServiceRows, StepRows, useEnvironment } from '../../components/EnvironmentView'
import { StatusPill } from '../../components/ui'
import { useAction } from '../../hooks'
import { navigate } from '../../router'
import { SetupFooter, type StepProps } from './ProjectSetup'

const PHASE_TEXT = {
  'setting-up': { status: 'running', label: 'Setting up' },
  ready: { status: 'passed', label: 'Ready' },
  failed: { status: 'failed', label: 'Failed' },
  'tearing-down': { status: 'running', label: 'Tearing down' },
  'torn-down': { status: 'idle', label: 'Torn down' },
  'teardown-failed': { status: 'failed', label: 'Teardown failed' }
} as const

export function TestRunStep({ project }: StepProps): ReactElement {
  const [environment, setEnvironment] = useEnvironment(`test:${project.id}`)
  const [reachedReady, setReachedReady] = useState(false)
  if (environment?.phase === 'ready' && !reachedReady) setReachedReady(true)

  const start = useAction(async () => {
    setReachedReady(false)
    setEnvironment(await window.eregion.startTestRun(project.id))
  })
  const tearDown = useAction(async () => setEnvironment(await window.eregion.tearDownTestRun(project.id)))
  const finish = useAction(async () => {
    await window.eregion.finishSetup(project.id)
    navigate({ name: 'board', projectId: project.id })
  })

  const phase = environment?.phase
  const busy = phase === 'setting-up' || phase === 'tearing-down'
  const passed = reachedReady && phase === 'torn-down'
  const finished = project.setupStep >= 8

  return (
    <>
      <section className="panel" aria-label="Test run">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 17 }}>Test run</h2>
          {environment && (
            <>
              <span className="mono muted">
                {environment.ticketKey} · slot {environment.slot}
              </span>
              <StatusPill status={PHASE_TEXT[environment.phase].status}>{PHASE_TEXT[environment.phase].label}</StatusPill>
            </>
          )}
          <div style={{ flex: 1 }} />
          {(!environment || phase === 'torn-down') && (
            <button type="button" className="er-btn er-btn-primary" onClick={() => void start.run()} disabled={start.pending}>
              {environment ? 'Run again' : 'Start test run'}
            </button>
          )}
          {(phase === 'ready' || phase === 'failed' || phase === 'teardown-failed') && (
            <button type="button" className="er-btn" onClick={() => void tearDown.run()} disabled={tearDown.pending}>
              Tear down
            </button>
          )}
        </div>
        {!environment && (
          <span className="muted">
            A throwaway ticket, TEST-1, is set up in a free slot exactly as a real ticket would be: worktrees on a test branch, every setup step, then the services. Check the app, then tear it down. Nothing is pushed and the test branch is
            deleted afterwards.
          </span>
        )}
        {environment && Object.keys(environment.values).length > 0 && (
          <span className="mono muted" style={{ fontSize: 13 }}>
            {Object.entries(environment.values)
              .map(([name, value]) => `${name} = ${value}`)
              .join(' · ')}
          </span>
        )}
        {environment?.error && <span className="error-text">{environment.error}</span>}
        {(start.error || tearDown.error) && <span className="error-text">{start.error ?? tearDown.error}</span>}
      </section>

      {environment?.repos.map((repo) => (
        <section key={repo.repoId} className="panel" aria-label={`${repo.name} test run`}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <h3 style={{ fontSize: 15 }}>{repo.name}</h3>
            <span className="mono muted">{repo.path}</span>
          </div>
          <StepRows steps={repo.steps} />
          {repo.teardown.length > 0 && (
            <>
              <span className="label" style={{ marginTop: 6 }}>
                Teardown
              </span>
              <StepRows steps={repo.teardown} />
            </>
          )}
        </section>
      ))}

      {environment && environment.services.length > 0 && (
        <section className="panel" aria-label="Services">
          <h3 style={{ fontSize: 15 }}>Services</h3>
          <ServiceRows environment={environment} />
        </section>
      )}

      {phase === 'ready' && (
        <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--aqua-50)', color: 'var(--ink-deep)' }}>Everything came up. Open the app to check it, then tear down to finish the test.</div>
      )}
      {passed && <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--aqua-50)', color: 'var(--ink-deep)' }}>The test run passed: set up, ready and torn down cleanly.</div>}
      {finish.error && <span className="error-text">{finish.error}</span>}

      <SetupFooter project={project} step="test" onNext={() => void finish.run()} disabled={busy || (!passed && !finished) || finish.pending} nextLabel={finished ? 'Back to the board' : 'Finish setup'} />
    </>
  )
}
