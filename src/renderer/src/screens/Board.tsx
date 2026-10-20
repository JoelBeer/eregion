import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react'
import type { StageConfig } from '@shared/pipeline'
import type { CrewMember } from '@shared/runs'
import type { TicketCard } from '@shared/tickets'
import { BoardCard } from '../components/BoardCard'
import { CrewAvatar } from '../components/RobotAvatar'
import { useAction, useQuery } from '../hooks'
import { navigate } from '../router'
import { useQuiet } from '../quiet'
import type { Project } from '@shared/model'
import { timeAgo, useLinearStatus } from './settings/IntegrationsSettings'

export function useCrew(): CrewMember[] {
  return useQuery(() => window.eregion.listCrew(), [], (event) => event.type === 'crew-changed').data ?? []
}

/** Board data that refreshes on ticket and environment changes, and at most every 1.5 s while agents talk. */
function useBoard(projectId: number): { cards: TicketCard[] | undefined; reload: () => void } {
  const [cards, setCards] = useState<TicketCard[]>()
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  const load = useRef(() => undefined as unknown)
  load.current = () => window.eregion.listTickets(projectId).then(setCards)

  useEffect(() => {
    void load.current()
    const unsubscribe = window.eregion.onEvent((event) => {
      const relevant =
        (event.type === 'ticket-changed' && event.projectId === projectId) ||
        (event.type === 'environment' && event.environment.projectId === projectId) ||
        event.type === 'run-event' ||
        event.type === 'run-state'
      if (!relevant) return
      if (pending.current) return
      pending.current = setTimeout(() => {
        pending.current = null
        void load.current()
      }, event.type === 'run-event' ? 1500 : 150)
    })
    return () => {
      unsubscribe()
      if (pending.current) clearTimeout(pending.current)
    }
  }, [projectId])
  return { cards, reload: () => void load.current() }
}

function LinearBar({ project }: { project: Project }): ReactElement | null {
  const { status } = useLinearStatus()
  const [key, setKey] = useState('')
  const sync = useAction(() => window.eregion.syncLinear())
  const importKey = useAction(async () => {
    const ticket = await window.eregion.importLinearIssue(project.id, key)
    setKey('')
    navigate({ name: 'ticket', projectId: project.id, ticketId: ticket.id, tab: 'conversation' })
  })
  if (!project.linear.teamId || !status?.method) return null
  const manual = project.linear.pullFrom === 'manual'
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 13 }}>
      <span className="muted">
        Linear {project.linear.teamName ?? project.linear.teamKey}: {manual ? 'import issues by key' : `issues assigned to ${status.importAssignees.mode === 'me' ? 'you' : 'the people you chose'} come in by themselves`} · synced {timeAgo(status.lastSyncAt)}
      </span>
      {status.error && <span className="error-text">Sync failed: {status.error}</span>}
      {!manual && (
        <button type="button" className="er-btn er-btn-sm er-btn-ghost" disabled={sync.pending} onClick={() => void sync.run()}>
          {sync.pending ? 'Syncing…' : 'Sync now'}
        </button>
      )}
      <form
        style={{ display: 'flex', gap: 6 }}
        onSubmit={(event) => {
          event.preventDefault()
          if (key.trim()) void importKey.run()
        }}
      >
        <input className="input mono" aria-label="Linear issue key" placeholder={`${project.linear.teamKey ?? 'WM'}-123`} value={key} onChange={(event) => setKey(event.target.value)} style={{ width: 120, padding: '4px 8px' }} />
        <button type="submit" className="er-btn er-btn-sm" disabled={!key.trim() || importKey.pending}>
          Import
        </button>
      </form>
      {importKey.error && <span className="error-text">{importKey.error}</span>}
    </div>
  )
}

function NewTicket({ projectId, linked, onDone }: { projectId: number; linked: boolean; onDone: () => void }): ReactElement {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const create = useAction(async () => {
    const ticket = await window.eregion.createTicket(projectId, title, description)
    onDone()
    navigate({ name: 'ticket', projectId, ticketId: ticket.id, tab: 'conversation' })
  })
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void create.run()
  }
  return (
    <form className="panel" style={{ maxWidth: 640 }} onSubmit={submit} aria-label="New ticket">
      <div className="field">
        <label htmlFor="ticket-title">Title</label>
        <input id="ticket-title" className="input" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="ticket-description">What needs doing</label>
        <textarea id="ticket-description" className="textarea" rows={4} value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>
      <span className="muted" style={{ fontSize: 13 }}>
        {linked ? 'Creates the issue in Linear, assigned to you, and adds it to the Backlog.' : "For work that isn't in Linear. It gets a key from the project's initials."}
      </span>
      {create.error && <span className="error-text">{create.error}</span>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="er-btn er-btn-primary" disabled={!title.trim() || create.pending}>
          Add to Backlog
        </button>
        <button type="button" className="er-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

export function Board({ projectId }: { projectId: number }): ReactElement {
  const project = useQuery(() => window.eregion.getProject(projectId), [projectId], (event) => event.type === 'project-changed' && event.projectId === projectId)
  const pipeline = useQuery(() => window.eregion.getPipeline(projectId), [projectId])
  const crew = useCrew()
  const { cards, reload } = useBoard(projectId)
  const [adding, setAdding] = useState(false)
  const { quiet } = useQuiet()
  const { status: linearStatus } = useLinearStatus()
  const [search, setSearch] = useState('')

  if (!project.data || !pipeline.data || !cards) return <main style={{ padding: 28 }} className="muted">Loading…</main>

  const query = search.trim().toLowerCase()
  const visible = cards.filter((card) => !query || card.ticket.key.toLowerCase().includes(query) || card.ticket.title.toLowerCase().includes(query))
  const stages = pipeline.data.stages.filter((stage) => stage.enabled)
  const columns: { id: string; name: string; stage: StageConfig | null }[] = [{ id: 'backlog', name: 'Backlog', stage: null }, ...stages.map((stage) => ({ id: stage.id, name: stage.name, stage })), { id: 'done', name: 'Done', stage: null }]
  const crewFor = (stage: StageConfig | null): CrewMember | undefined => (stage ? (crew.find((member) => member.id === stage.crewId) ?? crew.find((member) => member.role === stage.crewRole) ?? crew[0]) : undefined)
  const runtimes = [...new Set(project.data.repos.map((repo) => (repo.runtime.startsWith('wsl:') ? `WSL ${repo.runtime.slice(4)}` : 'this machine')))].join(', ')

  return (
    <main style={{ flex: 1, minWidth: 0, padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <h1 style={{ fontSize: 20 }}>{project.data.name}</h1>
        <span className="muted" style={{ fontSize: 13 }}>
          {project.data.repos.map((repo) => repo.name).join(' + ')} · {runtimes}
        </span>
        <div style={{ flex: '1 1 200px' }} />
        <input type="search" className="input" aria-label="Search tickets" placeholder="Search tickets" value={search} onChange={(event) => setSearch(event.target.value)} style={{ width: 240 }} />
        <button type="button" className="er-btn er-btn-primary" onClick={() => setAdding(true)}>
          + New ticket
        </button>
      </header>
      <LinearBar project={project.data} />
      {adding && (
        <NewTicket
          projectId={projectId}
          linked={Boolean(project.data.linear.teamId && linearStatus?.method)}
          onDone={() => {
            setAdding(false)
            reload()
          }}
        />
      )}
      <div style={{ overflowX: 'auto', paddingBottom: 8 }}>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columns.length}, minmax(250px, 1fr))`, gap: 16, minWidth: columns.length * 266, alignItems: 'start' }}>
          {columns.map((column) => {
            const columnCards = visible.filter((card) => card.ticket.stage === column.id)
            const member = crewFor(column.stage)
            return (
              <section key={column.id} aria-label={column.name} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 2px 4px', borderTop: '3px solid var(--aqua-400)' }}>
                  {member && !quiet && <CrewAvatar member={member} size={22} />}
                  <h2 style={{ fontSize: 15 }}>{column.name}</h2>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {member ? `${member.name} · ${columnCards.length}` : columnCards.length}
                  </span>
                </div>
                {columnCards.map((card) => (
                  <BoardCard key={card.ticket.id} card={card} crew={crew.find((item) => item.id === card.crewId)} />
                ))}
                {columnCards.length === 0 && column.id === 'backlog' && (
                  <div style={{ border: '1px dashed var(--border-300)', borderRadius: 12, padding: 14, fontSize: 13 }} className="muted">
                    No tickets waiting. Add one with New ticket.
                  </div>
                )}
              </section>
            )
          })}
        </div>
      </div>
    </main>
  )
}
