import { useState, type ReactElement } from 'react'
import type { ProjectSummary } from '@shared/model'
import { Chip, ProjectBadge, StatusPill } from '../components/ui'
import { errorMessage, useAction } from '../hooks'
import { href, navigate, SETUP_STEPS } from '../router'

function runtimeText(runtimes: string[]): string {
  if (runtimes.length === 0) return 'No repos yet'
  return runtimes.map((runtime) => (runtime.startsWith('wsl:') ? `WSL · ${runtime.slice(4)}` : 'This machine')).join(', ')
}

/** Setting up = setup unfinished; Active = a ticket past Backlog and not Done; Idle otherwise. */
export function projectStatus(project: ProjectSummary): { status: 'settingUp' | 'passed' | 'idle'; label: string } {
  if (project.setupStep < 8) return { status: 'settingUp', label: 'Setting up' }
  if (project.ticketsInProgress > 0) return { status: 'passed', label: 'Active' }
  return { status: 'idle', label: 'Idle' }
}

function ProjectCard({ project, current }: { project: ProjectSummary; current: boolean }): ReactElement {
  const { status, label } = projectStatus(project)
  const settingUp = project.setupStep < 8
  const step = SETUP_STEPS[Math.min(project.setupStep, 7) - 1]
  const [saved, setSaved] = useState<string | null>(null)
  const exporter = useAction(async () => setSaved(await window.eregion.exportProject(project.id)))
  return (
    <article
      style={{
        background: 'var(--surface-0, #FFFFFF)',
        border: current ? '2px solid var(--aqua-400, #76E1EF)' : settingUp ? '1px dashed var(--border-300)' : '1px solid var(--border-200)',
        borderRadius: 16,
        padding: 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 14
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <ProjectBadge initials={project.initials} color={project.color} size={40} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
          <h2 style={{ fontSize: 19 }}>{project.name}</h2>
          <span className="muted" style={{ fontSize: 12 }}>
            {settingUp
              ? `Setup not finished · step ${project.setupStep} of 7`
              : [current ? 'Current project' : null, project.linearTeamKey ? `Linear team ${project.linearTeamKey}` : 'No Linear team connected'].filter(Boolean).join(' · ')}
          </span>
        </div>
        <StatusPill status={status}>{label}</StatusPill>
      </div>
      <dl style={{ display: 'grid', gridTemplateColumns: '110px minmax(0,1fr)', gap: '6px 10px', margin: 0, fontSize: 14 }}>
        <dt className="muted">Repos</dt>
        <dd style={{ margin: 0, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {project.repoNames.length ? project.repoNames.map((name) => <Chip key={name}>{name}</Chip>) : <span className="muted">None yet</span>}
        </dd>
        <dt className="muted">Runs on</dt>
        <dd style={{ margin: 0 }}>{runtimeText(project.runtimes)}</dd>
        {!settingUp && (
          <>
            <dt className="muted">Live slots</dt>
            <dd style={{ margin: 0 }}>
              {project.slotsInUse} of {project.liveSlots} in use
            </dd>
            <dt className="muted">In progress</dt>
            <dd style={{ margin: 0 }}>
              {project.ticketsInProgress === 0 ? 'No tickets' : `${project.ticketsInProgress} tickets · ${project.ticketsNeedYou} need you`}
            </dd>
          </>
        )}
      </dl>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {settingUp ? (
          <a className="er-btn er-btn-primary" href={href({ name: 'setup', projectId: project.id, step })}>
            Continue setup
          </a>
        ) : (
          <>
            <a className="er-btn er-btn-primary" href={href({ name: 'board', projectId: project.id })}>
              Open board
            </a>
            <a className="er-btn" href={href({ name: 'setup', projectId: project.id, step: 'repos' })}>
              Settings
            </a>
          </>
        )}
        <button type="button" className="er-btn" disabled={exporter.pending} onClick={() => void exporter.run()} title="Save this project's setup and pipeline to share with another developer">
          Export
        </button>
      </div>
      {saved && (
        <span className="muted" style={{ fontSize: 13, wordBreak: 'break-all' }}>
          Saved to {saved}. Whoever imports it adds their own repo folders and GitHub account.
        </span>
      )}
      {exporter.error && <span className="error-text">Couldn't export: {errorMessage(exporter.error)}</span>}
    </article>
  )
}

export function Projects({ projects, currentProjectId }: { projects: ProjectSummary[]; currentProjectId: number | null }): ReactElement {
  const importer = useAction(async () => {
    const project = await window.eregion.importProject()
    if (project) navigate({ name: 'setup', projectId: project.id, step: 'repos' })
  })
  const live = projects.reduce((sum, project) => sum + project.slotsInUse, 0)

  return (
    <main style={{ flex: 1, minWidth: 0, padding: 28, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <h1 style={{ fontSize: 28 }}>Projects</h1>
        <span className="muted" style={{ fontSize: 13 }}>
          {projects.length} {projects.length === 1 ? 'project' : 'projects'} on this machine · {live} live {live === 1 ? 'environment' : 'environments'} in total
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="er-btn" onClick={() => void importer.run()} disabled={importer.pending}>
          Import project
        </button>
        <a className="er-btn er-btn-primary" href={href({ name: 'new-project' })}>
          + New project
        </a>
      </header>
      {importer.error && <span className="error-text">Couldn't import that file: {errorMessage(importer.error)}</span>}
      {projects.length === 0 ? (
        <div className="panel" style={{ alignItems: 'flex-start' }}>
          <h2 style={{ fontSize: 18 }}>No projects yet</h2>
          <span className="muted">A project is one or more repos that run together, like an API and a web app.</span>
          <a className="er-btn er-btn-primary" href={href({ name: 'new-project' })}>
            Set up a project
          </a>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 18 }}>
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} current={project.id === currentProjectId} />
          ))}
        </div>
      )}
    </main>
  )
}
