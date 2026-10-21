import { useEffect, useState, type ReactElement } from 'react'
import type { EditorChoice } from '@shared/editors'
import { StatusPill } from '../../components/ui'
import { useAction, useQuery } from '../../hooks'

/** Which code editor "View code in editor" opens a ticket's worktree in. */
export function EditorSettings(): ReactElement {
  const choice = useQuery(() => window.eregion.getEditor(), [])
  const editors = useQuery(() => window.eregion.listEditors(), [])
  const [command, setCommand] = useState('')
  useEffect(() => setCommand(choice.data?.command ?? ''), [choice.data])
  const save = useAction(async (next: EditorChoice) => {
    await window.eregion.setEditor(next)
    choice.reload()
  })
  const current = choice.data?.id
  return (
    <section className="panel" aria-label="Code editor" style={{ maxWidth: 820 }}>
      <h2 style={{ fontSize: 18 }}>Code editor</h2>
      <span>View code in editor opens a ticket's worktree here: when you check a stage's work, while its pull requests wait as drafts, and from its Environment panel.</span>
      <div role="radiogroup" aria-label="Editor" style={{ display: 'flex', flexDirection: 'column' }}>
        {(editors.data ?? []).map((editor) => (
          <label key={editor.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--divider-100)' }}>
            <input type="radio" name="editor" checked={current === editor.id} onChange={() => void save.run({ id: editor.id })} />
            <strong style={{ minWidth: 120 }}>{editor.name}</strong>
            <span className="mono muted" style={{ fontSize: 13 }}>
              {editor.command}
            </span>
            <div style={{ flex: 1 }} />
            <StatusPill status={editor.found ? 'passed' : 'idle'}>{editor.found ? 'Found' : 'Not found'}</StatusPill>
          </label>
        ))}
        {editors.loading && <span className="muted">Looking for editors…</span>}
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--divider-100)' }}>
          <input type="radio" name="editor" checked={current === 'custom'} onChange={() => void save.run({ id: 'custom', command })} />
          <strong style={{ minWidth: 120 }}>Another editor</strong>
          <input
            className="input mono"
            aria-label="Editor command"
            placeholder="idea {{path}}"
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            onBlur={() => current === 'custom' && command !== (choice.data?.command ?? '') && void save.run({ id: 'custom', command })}
            style={{ flex: 1 }}
          />
        </label>
      </div>
      <span className="muted" style={{ fontSize: 13 }}>
        For another editor, give its command with <span className="mono">{'{{path}}'}</span> where the folder goes (at the end if you leave it out). On macOS the editors above open their app, so their command-line launcher needn't be installed. Running inside WSL, a Windows editor takes <span className="mono">{'{{windowsPath}}'}</span>, the folder as Windows sees it: <span className="mono">{'"/mnt/c/Program Files/JetBrains/PhpStorm/bin/phpstorm64.exe" {{windowsPath}}'}</span>.
      </span>
      {(save.error || editors.error) && <span className="error-text">{save.error ?? editors.error}</span>}
    </section>
  )
}
