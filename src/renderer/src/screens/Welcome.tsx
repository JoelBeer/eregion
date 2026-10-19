import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { toolsReady } from '@shared/tools'
import type { ToolCheck } from '@shared/types'
import { RobotAvatar } from '../components/RobotAvatar'
import { Button } from '../components/ui'

const TOOL_NAMES: Record<ToolCheck['tool'], string> = {
  git: 'git',
  gh: 'GitHub CLI (gh)',
  claude: 'Claude Code',
  'cursor-agent': 'Cursor CLI'
}

function ToolsSection(): ReactElement {
  const [checks, setChecks] = useState<ToolCheck[] | null>(null)
  const [checking, setChecking] = useState(false)

  const run = useCallback(async () => {
    setChecking(true)
    try {
      setChecks(await window.eregion.checkTools())
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void run()
  }, [run])

  const ready = checks ? toolsReady(checks) : false

  return (
    <section aria-label="Step 1, tools on this machine" className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h2 style={{ fontSize: 18 }}>Tools on this machine</h2>
        <div style={{ flex: 1 }} />
        <Button size="sm" onClick={() => void run()} disabled={checking}>
          {checking ? 'Checking…' : 'Check again'}
        </Button>
      </div>
      {checks === null ? (
        <span className="muted">Looking for git, gh, Claude Code and the Cursor CLI…</span>
      ) : (
        <table style={{ borderCollapse: 'collapse', width: '100%' }}>
          <tbody>
            {checks.map((check) => (
              <tr key={`${check.runtime}-${check.tool}`} style={{ borderBottom: '1px solid var(--divider-100, #E3E7EE)' }}>
                <td style={{ width: 28, padding: '6px 0', color: check.found ? 'var(--primary-600)' : 'var(--red-700, #B42318)' }}>
                  {check.found ? '✓' : '✕'}
                </td>
                <td style={{ padding: '6px 8px' }}>{TOOL_NAMES[check.tool]}</td>
                <td className="muted" style={{ padding: '6px 8px' }}>
                  {check.runtime}
                </td>
                <td className="mono" style={{ padding: '6px 8px' }}>
                  {check.found ? [check.version, check.detail].filter(Boolean).join(' · ') : 'not found'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <span className="muted" style={{ fontSize: 13 }}>
        {ready
          ? 'Everything Eregion needs is here.'
          : 'You need git, gh signed in, and at least one of Claude Code or the Cursor CLI.'}
      </span>
    </section>
  )
}

export function Welcome(): ReactElement {
  return (
    <div style={{ minHeight: '100%', display: 'flex', justifyContent: 'center', padding: '40px 16px' }}>
      <main style={{ width: '100%', maxWidth: 860, display: 'flex', flexDirection: 'column', gap: 18 }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <RobotAvatar palette="ember" size={64} background />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <h1 style={{ fontSize: 30 }}>Welcome to Eregion</h1>
            <span className="muted" style={{ fontSize: 15 }}>
              A few checks, then your first project. Nothing is installed or changed on your machine without asking.
            </span>
          </div>
        </header>
        <ToolsSection />
      </main>
    </div>
  )
}
