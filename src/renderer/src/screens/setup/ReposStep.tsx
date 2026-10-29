import { useEffect, useState, type ReactElement } from 'react'
import type { RepoDetection } from '@shared/api'
import { BADGE_COLORS, cleanInitials, type Repo } from '@shared/model'
import { NavIcon } from '../../components/icons'
import { ProjectBadge } from '../../components/ui'
import type { CommitStyle } from '@shared/commits'
import { useAction, useQuery } from '../../hooks'
import { SetupFooter, type StepProps } from './ProjectSetup'

function runtimeLabel(runtime: string): string {
  return runtime.startsWith('wsl:') ? `WSL · ${runtime.slice(4)}` : 'This machine'
}

function RepoCard({ repo, first, last, onMove }: { repo: Repo; first: boolean; last: boolean; onMove: (by: number) => void }): ReactElement {
  const [draft, setDraft] = useState({ name: repo.name, defaultBranch: repo.defaultBranch, githubRepo: repo.githubRepo ?? '' })
  useEffect(() => setDraft({ name: repo.name, defaultBranch: repo.defaultBranch, githubRepo: repo.githubRepo ?? '' }), [repo])
  const save = useAction(() => window.eregion.updateRepo(repo.id, { name: draft.name, defaultBranch: draft.defaultBranch, githubRepo: draft.githubRepo || null }))
  const remove = useAction(() => window.eregion.removeRepo(repo.id))
  // A new folder for the same repo keeps its steps, services and settings.
  const changeFolder = useAction(async () => {
    const folder = await window.eregion.pickFolder()
    if (folder) await window.eregion.moveRepo(repo.id, folder)
  })
  const dirty = draft.name !== repo.name || draft.defaultBranch !== repo.defaultBranch || draft.githubRepo !== (repo.githubRepo ?? '')

  return (
    <section aria-label={`Repo ${repo.name}`} className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <input className="input" aria-label="Repo name" style={{ fontWeight: 600, width: 180 }} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        <span className="mono muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }} title={repo.path}>
          {repo.path}
        </span>
        <button type="button" className="er-btn er-btn-ghost er-btn-sm" onClick={() => void changeFolder.run()} disabled={changeFolder.pending} title="Point this repo at another folder, keeping its steps, services and settings">
          Change folder
        </button>
        <button type="button" className="er-btn er-btn-ghost er-btn-sm" aria-label="Move up" disabled={first} onClick={() => onMove(-1)}>
          <NavIcon name="up" size={16} />
        </button>
        <button type="button" className="er-btn er-btn-ghost er-btn-sm" aria-label="Move down" disabled={last} onClick={() => onMove(1)}>
          <NavIcon name="down" size={16} />
        </button>
        <button type="button" className="er-btn er-btn-ghost er-btn-sm" onClick={() => void remove.run()}>
          Remove
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0,1fr)', gap: '8px 12px', alignItems: 'center' }}>
        <span className="muted">Runtime</span>
        <span>{runtimeLabel(repo.runtime)}</span>
        <label className="muted" htmlFor={`branch-${repo.id}`}>
          Default branch
        </label>
        <input id={`branch-${repo.id}`} className="input mono" style={{ maxWidth: 220 }} value={draft.defaultBranch} onChange={(event) => setDraft({ ...draft, defaultBranch: event.target.value })} />
        <label className="muted" htmlFor={`gh-${repo.id}`}>
          GitHub repo
        </label>
        <input id={`gh-${repo.id}`} className="input mono" style={{ maxWidth: 320 }} placeholder="owner/name" value={draft.githubRepo} onChange={(event) => setDraft({ ...draft, githubRepo: event.target.value })} />
        <CommitSettings repo={repo} />
      </div>
      {dirty && (
        <button type="button" className="er-btn er-btn-primary er-btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => void save.run()} disabled={save.pending}>
          Save changes
        </button>
      )}
      {(save.error || remove.error || changeFolder.error) && <span className="error-text">{save.error ?? remove.error ?? changeFolder.error}</span>}
    </section>
  )
}

const STYLE_LABELS: Record<CommitStyle, string> = {
  detect: "Follow the repo's commitlint config",
  eregion: "Eregion's: PP-123: <ticket title> (build pass 1)",
  conventional: 'Conventional: <type>(PP-123): <summary>'
}

/** How the repo's commit messages and PR titles are written, and what that works out to. */
function CommitSettings({ repo }: { repo: Repo }): ReactElement {
  const [types, setTypes] = useState(repo.commitTypes.join(', '))
  useEffect(() => setTypes(repo.commitTypes.join(', ')), [repo])
  const rules = useQuery(() => window.eregion.getCommitRules(repo.id), [repo.id, repo.commitStyle, repo.commitTypes.join(',')]).data
  const save = useAction((patch: { commitStyle?: CommitStyle; commitTypes?: string[] }) => window.eregion.updateRepo(repo.id, patch))
  const typeList = types.split(',').map((type) => type.trim()).filter(Boolean)
  return (
    <>
      <label className="muted" htmlFor={`commits-${repo.id}`}>
        Commit messages
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <select id={`commits-${repo.id}`} className="select" style={{ maxWidth: 420 }} value={repo.commitStyle} onChange={(event) => void save.run({ commitStyle: event.target.value as CommitStyle })}>
          {(Object.keys(STYLE_LABELS) as CommitStyle[]).map((style) => (
            <option key={style} value={style}>
              {STYLE_LABELS[style]}
            </option>
          ))}
        </select>
        {rules && (
          <span className="muted" style={{ fontSize: 13 }}>
            {rules.conventional
              ? `Conventional, from ${rules.source}: ${rules.types.join(', ')}. Build commits, CI fixes and PR titles look like ${rules.types.includes('feat') ? 'feat' : rules.types[0]}(PP-123): show the hint after two wrong guesses.`
              : repo.commitStyle === 'detect'
                ? "No conventional commitlint config found, so Eregion's own messages are used."
                : "Eregion's own messages."}
          </span>
        )}
        {repo.commitStyle !== 'eregion' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input mono" aria-label="Commit types" style={{ maxWidth: 420, flex: 1 }} placeholder="Types to allow instead (optional): feat, fix, chore" value={types} onChange={(event) => setTypes(event.target.value)} />
            {typeList.join(',') !== repo.commitTypes.join(',') && (
              <button type="button" className="er-btn er-btn-sm" onClick={() => void save.run({ commitTypes: typeList })} disabled={save.pending}>
                Save types
              </button>
            )}
          </div>
        )}
        {save.error && <span className="error-text">{save.error}</span>}
      </div>
    </>
  )
}

function DetectedRepo({ detection, onAdd, onCancel, pending, error }: { detection: RepoDetection; onAdd: (name: string) => void; onCancel: () => void; pending: boolean; error: string | null }): ReactElement {
  const [name, setName] = useState(detection.name)
  return (
    <section aria-label="New repo" className="panel" style={{ border: '2px solid var(--aqua-400)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <input className="input" aria-label="Repo name" style={{ fontWeight: 600, width: 180 }} value={name} onChange={(event) => setName(event.target.value)} />
        <span className="mono muted">{detection.path}</span>
      </div>
      <span className="muted" style={{ fontSize: 13 }}>
        Detected values are suggestions. You can edit them after adding the repo, and its suggested setup steps appear in step 3.
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: '150px minmax(0,1fr) auto', gap: '6px 12px', alignItems: 'center' }}>
        {detection.facts.map((fact) => (
          <div key={fact.label} style={{ display: 'contents' }}>
            <span className="muted">{fact.label}</span>
            <span className="mono">{fact.value}</span>
            <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: 'var(--aqua-50)', color: '#2F6F8F' }}>{fact.source}</span>
          </div>
        ))}
      </div>
      {detection.warnings.map((warning) => (
        <span key={warning} style={{ fontSize: 13, color: 'var(--amber-800, #92400E)' }}>
          {warning}
        </span>
      ))}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="er-btn er-btn-primary" onClick={() => onAdd(name)} disabled={pending || !name.trim()}>
          Add repo
        </button>
        <button type="button" className="er-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {error && <span className="error-text">{error}</span>}
    </section>
  )
}

export function ReposStep({ project, next }: StepProps): ReactElement {
  const [name, setName] = useState(project.name)
  const [initials, setInitials] = useState(project.initials)
  const saveInitials = useAction(() => window.eregion.updateProject(project.id, { initials }))
  const [detection, setDetection] = useState<RepoDetection | null>(null)
  useEffect(() => setName(project.name), [project.name])

  const pick = useAction(async () => {
    const folder = await window.eregion.pickFolder()
    if (folder) setDetection(await window.eregion.detectRepo(folder))
  })
  const add = useAction(async (repoName: string) => {
    if (!detection) return
    await window.eregion.addRepo(project.id, {
      name: repoName,
      path: detection.path,
      runtime: detection.runtime,
      defaultBranch: detection.defaultBranch ?? 'main',
      githubRepo: detection.githubRepo
    })
    if (project.variables.length === 0 && detection.recipe.variables.length > 0) {
      await window.eregion.updateProject(project.id, { variables: detection.recipe.variables })
    }
    setDetection(null)
  })
  const rename = useAction(() => window.eregion.updateProject(project.id, { name }))
  const recolor = useAction((color: string) => window.eregion.updateProject(project.id, { color }))
  const move = useAction(async (index: number, by: number) => {
    const ids = project.repos.map((repo) => repo.id)
    const [id] = ids.splice(index, 1)
    ids.splice(index + by, 0, id)
    await window.eregion.reorderRepos(project.id, ids)
  })
  const proceed = useAction(async () => {
    if (name.trim() !== project.name) await window.eregion.updateProject(project.id, { name })
    await next()
  })

  return (
    <>
      <section className="panel" aria-label="Project">
        <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div className="field">
            <label htmlFor="project-name">Project name</label>
            <input id="project-name" className="input" style={{ width: 280 }} value={name} onChange={(event) => setName(event.target.value)} onBlur={() => name.trim() && name !== project.name && void rename.run()} />
          </div>
          <div className="field">
            <label htmlFor="project-initials">Initials</label>
            <input
              id="project-initials"
              className="input mono"
              style={{ width: 80, textTransform: 'uppercase' }}
              value={initials}
              onChange={(event) => setInitials(cleanInitials(event.target.value))}
              onBlur={() => (initials ? initials !== project.initials && void saveInitials.run() : setInitials(project.initials))}
            />
          </div>
          <div className="field">
            <span className="label">Badge colour</span>
            <div role="radiogroup" aria-label="Badge colour" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <ProjectBadge initials={initials || project.initials} color={project.color} size={32} />
              {BADGE_COLORS.map((swatch) => (
                <button
                  key={swatch.hex}
                  type="button"
                  role="radio"
                  aria-checked={swatch.hex === project.color}
                  aria-label={swatch.name}
                  onClick={() => void recolor.run(swatch.hex)}
                  style={{ width: 26, height: 26, borderRadius: 999, background: swatch.hex, cursor: 'pointer', border: swatch.hex === project.color ? '3px solid var(--ink-deep)' : '2px solid #FFFFFF', boxShadow: '0 0 0 1px var(--border-200)' }}
                />
              ))}
            </div>
          </div>
        </div>
        <span className="muted" style={{ fontSize: 13 }}>
          Up to three letters or digits for the badge. Tickets you add in Eregion take them as their key, like {initials || project.initials}-12; keys already given don't change.
        </span>
        {(rename.error || saveInitials.error) && <span className="error-text">{rename.error ?? saveInitials.error}</span>}
      </section>

      {project.repos.map((repo, index) => (
        <RepoCard key={repo.id} repo={repo} first={index === 0} last={index === project.repos.length - 1} onMove={(by) => void move.run(index, by)} />
      ))}

      {detection ? (
        <DetectedRepo detection={detection} onAdd={(repoName) => void add.run(repoName)} onCancel={() => setDetection(null)} pending={add.pending} error={add.error} />
      ) : (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button type="button" className="er-btn er-btn-dashed" onClick={() => void pick.run()} disabled={pick.pending}>
            <NavIcon name="folder" /> {pick.pending ? 'Looking at the repo…' : '+ Add repo folder'}
          </button>
          {pick.error && <span className="error-text">{pick.error}</span>}
        </div>
      )}

      <SetupFooter project={project} step="repos" onNext={() => void proceed.run()} disabled={project.repos.length === 0 || proceed.pending || !name.trim()} />
    </>
  )
}
