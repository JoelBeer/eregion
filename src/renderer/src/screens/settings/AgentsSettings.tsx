import { useState, type FormEvent, type ReactElement } from 'react'
import type { AgentInfo } from '@shared/agents'
import { customAgentProblems, OUTPUT_FORMAT_LABELS, type AgentCapabilities, type CustomAgent, type OutputFormat } from '@shared/connectors'
import { Chip, StatusPill } from '../../components/ui'
import { useAction, useQuery } from '../../hooks'
import { timeAgo } from './IntegrationsSettings'

const CAPABILITY_LABELS: Record<keyof AgentCapabilities, string> = {
  midRunMessages: 'Takes messages while it works',
  followUps: 'Carries on a conversation',
  tooling: 'Per-run MCP servers and skills',
  blocksGit: "Can be kept from committing and pushing",
  reportsTokens: 'Reports tokens',
  reportsCost: 'Reports cost'
}

function Capabilities({ capabilities }: { capabilities: AgentCapabilities }): ReactElement {
  return (
    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {(Object.keys(CAPABILITY_LABELS) as (keyof AgentCapabilities)[]).map((key) => (
        <span key={key} title={capabilities[key] ? 'Yes' : 'No'} style={{ opacity: capabilities[key] ? 1 : 0.55 }}>
          <Chip tone={capabilities[key] ? 'info' : 'neutral'}>
            {capabilities[key] ? '✓' : '✗'} {CAPABILITY_LABELS[key]}
          </Chip>
        </span>
      ))}
    </span>
  )
}

/** Arguments typed one per line. */
const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

/** Adds an agent Eregion doesn't know, or edits one you added: a command template and how to read its output. */
function CustomAgentForm({ agent, taken, onDone }: { agent: CustomAgent | null; taken: string[]; onDone: () => void }): ReactElement {
  const [id, setId] = useState(agent?.id ?? '')
  const [name, setName] = useState(agent?.name ?? '')
  const [command, setCommand] = useState(agent?.command ?? '')
  const [output, setOutput] = useState<OutputFormat>(agent?.output ?? 'text')
  const [args, setArgs] = useState((agent?.args ?? ['{{prompt}}']).join('\n'))
  const [resumeArgs, setResumeArgs] = useState((agent?.resumeArgs ?? []).join('\n'))
  const [models, setModels] = useState((agent?.models ?? []).join(', '))
  const draft: CustomAgent = { id: id.trim(), name, command: command.trim(), output, args: lines(args), resumeArgs: lines(resumeArgs), models: models.split(',').map((item) => item.trim()).filter(Boolean) }
  const problems = id || name || command ? customAgentProblems(draft, agent ? taken.filter((item) => item !== agent.id) : taken) : []
  const save = useAction(async () => {
    await window.eregion.saveCustomAgent(draft)
    onDone()
  })
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void save.run()
  }
  return (
    <form className="panel" aria-label={agent ? `Edit ${agent.name}` : 'Add an agent'} onSubmit={submit}>
      <h2 style={{ fontSize: 18 }}>{agent ? `Edit ${agent.name}` : 'Add an agent'}</h2>
      <span className="muted" style={{ fontSize: 13 }}>
        For an agent CLI Eregion doesn't know. Eregion runs the command in the ticket's folder with these arguments, one per line. <span className="mono">{'{{prompt}}'}</span> is the
        stage's message (without it, the message goes to the command's input) and <span className="mono">{'{{model}}'}</span> the crew member's model.
      </span>
      <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: '10px 12px', alignItems: 'center' }}>
        <label htmlFor="agent-name">Name</label>
        <input id="agent-name" className="input" placeholder="Aider" value={name} onChange={(event) => setName(event.target.value)} />
        <label htmlFor="agent-id">Id</label>
        <input id="agent-id" className="input mono" placeholder="aider" value={id} disabled={Boolean(agent)} onChange={(event) => setId(event.target.value)} />
        <label htmlFor="agent-command">Command</label>
        <input id="agent-command" className="input mono" placeholder="aider" value={command} onChange={(event) => setCommand(event.target.value)} />
        <label htmlFor="agent-args">Arguments</label>
        <textarea id="agent-args" className="textarea mono" rows={4} placeholder={'--yes\n--message\n{{prompt}}'} value={args} onChange={(event) => setArgs(event.target.value)} />
        <label htmlFor="agent-output">Its output</label>
        <select id="agent-output" className="select" value={output} onChange={(event) => setOutput(event.target.value as OutputFormat)}>
          {(Object.keys(OUTPUT_FORMAT_LABELS) as OutputFormat[]).map((format) => (
            <option key={format} value={format}>
              {OUTPUT_FORMAT_LABELS[format]}
            </option>
          ))}
        </select>
        <label htmlFor="agent-resume">Follow-up arguments</label>
        <textarea
          id="agent-resume"
          className="textarea mono"
          rows={3}
          placeholder={'Optional. To carry on a conversation:\n--resume\n{{session}}\n{{prompt}}'}
          value={resumeArgs}
          onChange={(event) => setResumeArgs(event.target.value)}
        />
        <label htmlFor="agent-models">Models</label>
        <input id="agent-models" className="input mono" placeholder="Comma-separated; the first is used for tests" value={models} onChange={(event) => setModels(event.target.value)} />
      </div>
      <span className="muted" style={{ fontSize: 13 }}>
        {output === 'text'
          ? "Plain text: each line it prints is shown as something it said. It can't report tokens or carry on a conversation, so it can't plan, chat in the Forge, or be asked to fix a file."
          : resumeArgs.trim()
            ? 'With follow-up arguments it can carry on a conversation; {{session}} is the id it printed when it started.'
            : "Without follow-up arguments it can't carry on a conversation, so it can't plan, chat in the Forge, or be asked to fix a file."}
      </span>
      {problems.length > 0 && <span className="error-text">{problems.join('. ')}.</span>}
      {save.error && <span className="error-text">{save.error}</span>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="er-btn er-btn-primary" disabled={problems.length > 0 || !id || !name || !command || save.pending}>
          {agent ? 'Save' : 'Add the agent'}
        </button>
        <button type="button" className="er-btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function AgentCard({ agent, reload, onEdit }: { agent: AgentInfo; reload: () => void; onEdit: () => void }): ReactElement {
  const [model, setModel] = useState('')
  const test = useAction(async () => {
    await window.eregion.testAgent(agent.id)
    reload()
  })
  const add = useAction(async () => {
    await window.eregion.addModel(agent.id, model)
    setModel('')
    reload()
  })
  const remove = useAction(async (id: string) => {
    await window.eregion.removeModel(agent.id, id)
    reload()
  })
  const removeAgent = useAction(async () => {
    if (!window.confirm(`Remove ${agent.name}? Crew members on it keep the setting and say it's gone until you pick another agent.`)) return
    await window.eregion.removeCustomAgent(agent.id)
    reload()
  })
  const installed = agent.checks.filter((check) => check.found)
  return (
    <section className="panel" aria-label={agent.name}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18 }}>{agent.name}</h2>
        <code className="mono muted">{agent.command}</code>
        <StatusPill status={installed.length > 0 ? 'passed' : 'neutral'}>{installed.length > 0 ? 'Installed' : 'Not installed'}</StatusPill>
        {!agent.builtIn && <Chip>Yours</Chip>}
        <div style={{ flex: 1 }} />
        {!agent.builtIn && (
          <>
            <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={onEdit}>
              Edit
            </button>
            <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void removeAgent.run()}>
              Remove
            </button>
          </>
        )}
        <button type="button" className="er-btn er-btn-sm" disabled={test.pending || installed.length === 0} onClick={() => void test.run()}>
          {test.pending ? 'Waiting for a reply…' : 'Run a test prompt'}
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '170px minmax(0, 1fr)', gap: '8px 12px', fontSize: 14 }}>
        <span className="muted">Found</span>
        <span>{agent.checks.map((check) => `${check.runtime}: ${check.found ? (check.version ?? 'installed') : 'not installed'}`).join(' · ') || 'Checking…'}</span>
        <span className="muted">Projects run it in</span>
        <span>{agent.projects.map((project) => `${project.name}: ${project.runtime}`).join(' · ') || 'No projects yet'}</span>
        <span className="muted">What it can do</span>
        <Capabilities capabilities={agent.capabilities} />
        {!agent.builtIn && (
          <>
            <span className="muted">How it runs</span>
            <span className="mono" style={{ fontSize: 13 }}>
              {[agent.command, ...(agent.args ?? [])].join(' ')}
              {agent.resumeArgs ? ` · then ${[agent.command, ...agent.resumeArgs].join(' ')}` : ''} · {OUTPUT_FORMAT_LABELS[agent.output]}
            </span>
          </>
        )}
        <span className="muted">Last test</span>
        <span>
          {agent.tests.length === 0
            ? 'Not tested yet. The test sends one tiny prompt with the cheapest model.'
            : agent.tests.map((result) => (
                <span key={result.runtime} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <StatusPill status={result.ok ? 'passed' : 'failed'}>{result.ok ? 'Replied' : 'Failed'}</StatusPill>
                  <span>
                    {result.runtime} · {(result.ms / 1000).toFixed(1)} s · {result.signedIn ? 'signed in' : 'not signed in'} · {result.usageReported ? 'usage reported' : 'no usage reported'}
                    {result.costUsd !== null ? ` · $${result.costUsd.toFixed(4)}` : ''} · {timeAgo(result.at)}
                  </span>
                  {!result.ok && <span className="error-text">{result.detail}</span>}
                </span>
              ))}
        </span>
        <span className="muted">Models</span>
        <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {agent.models.map((item) => (
              <span key={item.id} className="er-chip er-chip-mono" title={item.id}>
                {item.label}
                {item.custom && (
                  <button type="button" aria-label={`Remove ${item.id}`} onClick={() => void remove.run(item.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, marginLeft: 2 }}>
                    ×
                  </button>
                )}
              </span>
            ))}
          </span>
          <form
            style={{ display: 'flex', gap: 6 }}
            onSubmit={(event) => {
              event.preventDefault()
              if (model.trim()) void add.run()
            }}
          >
            <input className="input mono" aria-label={`Add a ${agent.name} model`} placeholder="Add a model by name" value={model} onChange={(event) => setModel(event.target.value)} style={{ width: 240, padding: '4px 8px' }} />
            <button type="submit" className="er-btn er-btn-sm" disabled={!model.trim() || add.pending}>
              Add
            </button>
          </form>
        </span>
      </div>
      <span className="muted" style={{ fontSize: 13 }}>
        {agent.note}
      </span>
      {(test.error || add.error || remove.error || removeAgent.error) && <span className="error-text">{test.error ?? add.error ?? remove.error ?? removeAgent.error}</span>}
    </section>
  )
}

/** The agent CLIs Eregion runs: Claude Code, Cursor and Codex built in, and any you add. It never installs, updates or signs in to them. */
export function AgentsSettings(): ReactElement {
  const agents = useQuery(() => window.eregion.listAgents(), [])
  const [editing, setEditing] = useState<CustomAgent | 'new' | null>(null)
  const taken = agents.data?.map((agent) => agent.id) ?? []
  const done = (): void => {
    setEditing(null)
    void agents.reload()
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span className="muted" style={{ flex: '1 1 400px' }}>
          Eregion runs these command-line agents. It never installs, updates or signs in to them: do that in a terminal in the runtime shown.
        </span>
        <button type="button" className="er-btn" onClick={() => setEditing('new')} disabled={editing !== null}>
          + Add an agent
        </button>
      </div>
      {editing && <CustomAgentForm agent={editing === 'new' ? null : editing} taken={taken} onDone={done} />}
      {agents.error && <span className="error-text">{agents.error}</span>}
      {!agents.data && !agents.error && <span className="muted">Checking the agents on this machine…</span>}
      {agents.data?.map((agent) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          reload={() => void agents.reload()}
          onEdit={() =>
            setEditing({ id: agent.id, name: agent.name, command: agent.command, output: agent.output, args: agent.args ?? [], resumeArgs: agent.resumeArgs ?? [], models: agent.models.filter((item) => !item.custom).map((item) => item.id) })
          }
        />
      ))}
    </div>
  )
}
