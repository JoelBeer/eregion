import { useState, type FormEvent, type ReactElement } from 'react'
import { useAction } from '../hooks'
import { href, navigate } from '../router'

export function NewProject(): ReactElement {
  const [name, setName] = useState('')
  const create = useAction(async (projectName: string) => {
    const project = await window.eregion.createProject(projectName)
    navigate({ name: 'setup', projectId: project.id, step: 'repos' })
  })
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (name.trim()) void create.run(name)
  }

  return (
    <main style={{ flex: 1, minWidth: 0, padding: 28, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <header style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <a href={href({ name: 'projects' })} style={{ fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
          ← All projects
        </a>
        <h1 style={{ fontSize: 26 }}>New project</h1>
      </header>
      <form className="panel" style={{ maxWidth: 560 }} onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-project-name">Project name</label>
          <input id="new-project-name" className="input" autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Word Magic" />
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          A project is one or more repos that run together. Setup takes seven short steps and ends with a test run.
        </span>
        {create.error && <span className="error-text">{create.error}</span>}
        <button type="submit" className="er-btn er-btn-primary" style={{ alignSelf: 'flex-start' }} disabled={!name.trim() || create.pending}>
          Create and add repos
        </button>
      </form>
    </main>
  )
}
