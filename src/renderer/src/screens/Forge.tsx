import { useEffect, useState, type ReactElement } from 'react'
import type { AgentEvent } from '@shared/agent'
import { dayLabel, visitor, type Chat } from '@shared/forge'
import type { ModelOption } from '@shared/agents'
import type { CrewMember } from '@shared/runs'
import { CrewAvatar, RobotAvatar } from '../components/RobotAvatar'
import { SessionPanel, useRun } from '../components/SessionPanel'
import { Chip } from '../components/ui'
import { useAction, useQuery } from '../hooks'
import { navigate } from '../router'
import { useCrew } from './Board'

const money = (usd: number): string => `$${usd.toFixed(2)}`

function useChats(projectId: number): Chat[] | undefined {
  return useQuery(() => window.eregion.listChats(projectId), [projectId], (event) => (event.type === 'forge-changed' && event.projectId === projectId) || event.type === 'run-state').data
}

function who(chat: Chat, crew: CrewMember[]): CrewMember {
  return crew.find((member) => member.id === chat.crewId) ?? visitor(chat.adapter, chat.model)
}

function NewChat({ projectId, onCreated }: { projectId: number; onCreated: (chat: Chat) => void }): ReactElement {
  const crew = useCrew()
  const project = useQuery(() => window.eregion.getProject(projectId), [projectId]).data
  const models = useQuery<ModelOption[]>(() => window.eregion.listModels('claude-code'), []).data ?? []
  const [crewId, setCrewId] = useState<number | null>(null)
  const [model, setModel] = useState('claude-sonnet-5-5')
  const [repoIds, setRepoIds] = useState<number[] | null>(null)
  const chosenRepos = repoIds ?? project?.repos.map((repo) => repo.id) ?? []
  const create = useAction(async () => onCreated(await window.eregion.createChat(projectId, { crewId, adapter: 'claude-code', model, repoIds: chosenRepos })))
  return (
    <section className="panel" aria-label="New chat" style={{ gap: 16 }}>
      <h2 style={{ fontSize: 18 }}>New chat</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="label">Talk to</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {crew.map((member) => (
            <button key={member.id} type="button" aria-pressed={crewId === member.id} className={`er-btn${crewId === member.id ? ' er-btn-primary' : ''}`} onClick={() => setCrewId(member.id)} style={{ gap: 8 }}>
              <CrewAvatar member={member} size={22} />
              {member.name}
              <span style={{ fontSize: 12, opacity: 0.8 }}>{member.model.replace('claude-', '')}</span>
            </button>
          ))}
          <button type="button" aria-pressed={crewId === null} className={`er-btn${crewId === null ? ' er-btn-primary' : ''}`} onClick={() => setCrewId(null)} style={{ gap: 8 }}>
            <RobotAvatar seed={visitor('claude-code', model).seed} size={22} />
            Visitor
          </button>
        </div>
        {crewId === null && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="muted">Model</span>
            <select className="select" value={model} onChange={(event) => setModel(event.target.value)} style={{ width: 240 }}>
              {models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="muted" style={{ fontSize: 13 }}>
              A guest with no profile, on whichever model you pick.
            </span>
          </label>
        )}
      </div>
      {project && project.repos.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="label">Can read</span>
          {project.repos.map((repo) => (
            <label key={repo.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input type="checkbox" checked={chosenRepos.includes(repo.id)} onChange={(event) => setRepoIds(event.target.checked ? [...chosenRepos, repo.id] : chosenRepos.filter((id) => id !== repo.id))} />
              <span className="mono">{repo.name}</span>
              <span className="muted" style={{ fontSize: 13 }}>
                read-only, at the latest {repo.defaultBranch}
              </span>
            </label>
          ))}
        </div>
      )}
      <div>
        <button type="button" className="er-btn er-btn-primary" disabled={create.pending} onClick={() => void create.run()}>
          Start chat
        </button>
      </div>
      {create.error && <span className="error-text">{create.error}</span>}
    </section>
  )
}

function ToTicket({ chat, lastAnswer, onDone }: { chat: Chat; lastAnswer: string; onDone: () => void }): ReactElement {
  const project = useQuery(() => window.eregion.getProject(chat.projectId), [chat.projectId]).data
  const linear = useQuery(() => window.eregion.getLinearStatus(), []).data
  const [title, setTitle] = useState(chat.title)
  const [description, setDescription] = useState(lastAnswer)
  const create = useAction(async () => {
    const ticket = await window.eregion.createTicket(chat.projectId, title, description)
    onDone()
    navigate({ name: 'ticket', projectId: chat.projectId, ticketId: ticket.id, tab: 'conversation' })
  })
  const linked = Boolean(project?.linear.teamId && linear?.method)
  return (
    <section className="panel" aria-label="Create a backlog ticket">
      <h2 style={{ fontSize: 16 }}>Create a backlog ticket</h2>
      <div className="field">
        <label htmlFor="chat-ticket-title">Title</label>
        <input id="chat-ticket-title" className="input" value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="chat-ticket-description">What needs doing</label>
        <textarea id="chat-ticket-description" className="textarea" rows={8} value={description} onChange={(event) => setDescription(event.target.value)} />
      </div>
      <span className="muted" style={{ fontSize: 13 }}>
        {linked ? `Creates the issue in Linear (${project?.linear.teamKey}), assigned to you, and adds it to the Backlog.` : 'Adds it to the Backlog.'}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="er-btn er-btn-primary" disabled={!title.trim() || create.pending} onClick={() => void create.run()}>
          Create ticket
        </button>
        <button type="button" className="er-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
      {create.error && <span className="error-text">{create.error}</span>}
    </section>
  )
}

function ChatView({ chat }: { chat: Chat }): ReactElement {
  const crew = useCrew()
  const member = who(chat, crew)
  const project = useQuery(() => window.eregion.getProject(chat.projectId), [chat.projectId]).data
  const skills = useQuery(() => window.eregion.listSkills(), []).data?.skills.filter((skill) => skill.allowed).map((skill) => skill.name) ?? []
  const lastRunId = chat.runIds.at(-1) ?? null
  const view = useRun(lastRunId)
  const [history, setHistory] = useState<AgentEvent[]>([])
  const [ticketing, setTicketing] = useState(false)
  const earlier = chat.runIds.slice(0, -1).join(',')
  useEffect(() => {
    let cancelled = false
    void Promise.all(chat.runIds.slice(0, -1).map((id) => window.eregion.getRun(id))).then((views) => {
      if (!cancelled) setHistory(views.flatMap((item) => [...item.events, { kind: 'system', text: '(chat resumed)' } as AgentEvent]))
    })
    return () => {
      cancelled = true
    }
  }, [earlier])
  const remove = useAction(async () => {
    if (window.confirm('Delete this chat? Its conversation is removed; its cost stays out of Costs too.')) {
      await window.eregion.deleteChat(chat.id)
      navigate({ name: 'forge', projectId: chat.projectId, chatId: null })
    }
  })
  const toggleRepo = useAction((repoId: number, on: boolean) => window.eregion.updateChat(chat.id, { repoIds: on ? [...chat.repoIds, repoId] : chat.repoIds.filter((id) => id !== repoId) }))
  const lastAnswer = [...history, ...(view?.events ?? [])].filter((event) => event.kind === 'text').at(-1)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: 1, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 20 }}>{chat.title}</h1>
        <span className="muted" style={{ fontSize: 13 }}>
          {chat.tokens > 0 ? `${Math.round(chat.tokens / 1000)}k tokens · ${money(chat.costUsd)}` : 'No usage yet'}
        </span>
        <div style={{ flex: 1 }} />
        <button type="button" className="er-btn er-btn-sm" disabled={!lastAnswer} onClick={() => setTicketing(true)}>
          Create backlog ticket
        </button>
        <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void remove.run()}>
          Delete
        </button>
      </header>
      {project && project.repos.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 }}>
          <span className="muted">Can read:</span>
          {project.repos.map((repo) => (
            <label key={repo.id} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <input type="checkbox" checked={chat.repoIds.includes(repo.id)} onChange={(event) => void toggleRepo.run(repo.id, event.target.checked)} />
              <span className="mono">{repo.name}</span>
            </label>
          ))}
          <span className="muted">(read-only; a change applies from the next session)</span>
        </div>
      )}
      {ticketing && lastAnswer?.kind === 'text' && <ToTicket chat={chat} lastAnswer={lastAnswer.text} onDone={() => setTicketing(false)} />}
      <SessionPanel
        crew={member}
        view={view}
        history={history}
        stageLabel="Forge"
        skills={skills}
        onSend={async (text) => {
          await window.eregion.sendToChat(chat.id, text, false)
        }}
        placeholder={<span>Ask {member.name} anything. Nothing here touches a ticket or changes files.</span>}
      />
      {(remove.error || toggleRepo.error) && <span className="error-text">{remove.error ?? toggleRepo.error}</span>}
    </div>
  )
}

/** Quick one-off chats that don't need a ticket. */
export function Forge({ projectId, chatId }: { projectId: number; chatId: number | null }): ReactElement {
  const chats = useChats(projectId)
  const crew = useCrew()
  const [creating, setCreating] = useState(false)
  const chat = chats?.find((item) => item.id === chatId)
  const days = [...new Set((chats ?? []).map((item) => dayLabel(item.updatedAt)))]
  return (
    <main style={{ flex: 1, minWidth: 0, padding: '24px 28px', display: 'flex', gap: 20, alignItems: 'flex-start' }}>
      <nav aria-label="Chats" style={{ flex: '0 0 260px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h1 style={{ fontSize: 22 }}>Forge</h1>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="er-btn er-btn-primary er-btn-sm"
            onClick={() => {
              setCreating(true)
              navigate({ name: 'forge', projectId, chatId: null })
            }}
          >
            + New chat
          </button>
        </div>
        {chats?.length === 0 && <span className="muted">No chats yet.</span>}
        {days.map((day) => (
          <div key={day} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>
              {day}
            </span>
            {(chats ?? [])
              .filter((item) => dayLabel(item.updatedAt) === day)
              .map((item) => {
                const member = who(item, crew)
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={item.id === chatId}
                    onClick={() => {
                      setCreating(false)
                      navigate({ name: 'forge', projectId, chatId: item.id })
                    }}
                    style={{ display: 'flex', gap: 8, alignItems: 'center', textAlign: 'left', border: 'none', borderRadius: 8, padding: '6px 8px', cursor: 'pointer', font: 'inherit', background: item.id === chatId ? 'var(--aqua-50)' : 'transparent' }}
                  >
                    <CrewAvatar member={member} size={22} />
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</span>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {member.name}
                        {item.crewId === null ? ` · ${item.model.replace('claude-', '')}` : ''}
                        {item.costUsd > 0 ? ` · ${money(item.costUsd)}` : ''}
                      </span>
                    </span>
                  </button>
                )
              })}
          </div>
        ))}
      </nav>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {chat && !creating ? (
          <ChatView key={chat.id} chat={chat} />
        ) : (
          <>
            <NewChat
              projectId={projectId}
              onCreated={(created) => {
                setCreating(false)
                navigate({ name: 'forge', projectId, chatId: created.id })
              }}
            />
            <Chip tone="neutral">Chats are read-only: agents here can read the repos you pick but never change files or tickets.</Chip>
          </>
        )}
      </div>
    </main>
  )
}
