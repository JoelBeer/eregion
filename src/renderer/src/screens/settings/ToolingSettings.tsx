import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { McpServerInfo } from '@shared/tooling'
import { Chip, StatusPill, Switch } from '../../components/ui'
import { useAction, useQuery } from '../../hooks'

const SOURCE_LABELS = { project: 'Repo', personal: 'Yours', synced: 'Synced from claude.ai' } as const

/** Which skills agents may use. New ones start off. */
export function SkillsSettings(): ReactElement {
  const query = useQuery(() => window.eregion.listSkills(), [])
  const toggle = useAction(async (name: string, allowed: boolean) => {
    await window.eregion.setSkillAllowed(name, allowed)
    await query.reload()
  })
  const setDefault = useAction(async (on: boolean) => {
    await window.eregion.setSkillDefault(on ? 'on' : 'off')
    await query.reload()
  })
  const marked = useRef(false)
  // The New flags show on this visit, then clear for the next one.
  useEffect(() => {
    if (query.data && !marked.current) {
      marked.current = true
      void window.eregion.markSkillsSeen(query.data.skills.map((skill) => skill.name))
    }
  }, [query.data])
  const skills = query.data?.skills ?? []
  const fresh = skills.filter((skill) => skill.isNew).length
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 960 }}>
      <section className="panel" aria-label="Skills">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 18 }}>Skills</h2>
          <span className="muted" style={{ fontSize: 13 }}>
            {query.data ? `${skills.length} found${fresh ? ` · ${fresh} new` : ''} · ${skills.filter((skill) => skill.allowed).length} allowed` : 'Looking for skills…'}
          </span>
          <div style={{ flex: 1 }} />
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void query.reload()}>
            Rescan
          </button>
        </div>
        {query.error && <span className="error-text">{query.error}</span>}
        {skills.map((skill) => (
          <div key={skill.name} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, borderTop: '1px solid var(--divider-100)', paddingTop: 10 }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="mono" style={{ fontWeight: 600 }}>
                  {skill.name}
                </span>
                <Chip tone="neutral">{SOURCE_LABELS[skill.source]}</Chip>
                <span className="muted mono" style={{ fontSize: 12 }}>
                  {skill.where}
                </span>
                {skill.isNew && <Chip tone="info">New</Chip>}
              </span>
              <span className="muted" style={{ fontSize: 13 }}>
                {skill.description}
              </span>
            </div>
            <Switch label={skill.allowed ? 'Allowed' : 'Off'} checked={skill.allowed} onChange={(on) => void toggle.run(skill.name, on)} />
          </div>
        ))}
        {query.data && skills.length === 0 && <span className="muted">No skills found yet.</span>}
        {(toggle.error || setDefault.error) && <span className="error-text">{toggle.error ?? setDefault.error}</span>}
      </section>
      <section className="panel" aria-label="How skills reach runs">
        <Switch label="Allow new skills as soon as they're found" checked={query.data?.defaultForNew === 'on'} onChange={(on) => void setDefault.run(on)} />
        <span className="muted" style={{ fontSize: 13 }}>
          Eregion looks in each project repo's <span className="mono">.claude/skills</span>, in <span className="mono">~/.claude/skills</span> and in skills synced from claude.ai. A skill you haven't allowed is switched off for Eregion's runs only; nothing changes in your own Claude Code settings. Built-in and plugin skills are managed in Claude Code itself (/plugin).
        </span>
      </section>
    </div>
  )
}

function describeServer(server: McpServerInfo): string {
  const { spec } = server
  if (spec.url) return `${spec.type ?? 'http'} · ${spec.url}`
  return [spec.command, ...(spec.args ?? [])].join(' ')
}

/** Which MCP servers are passed to runs. */
export function McpSettings(): ReactElement {
  const servers = useQuery(() => window.eregion.listMcpServers(), [])
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const toggle = useAction(async (key: string, allowed: boolean) => {
    await window.eregion.setMcpServerAllowed(key, allowed)
    await servers.reload()
  })
  const add = useAction(async () => {
    const value = target.trim()
    const spec = /^https?:\/\//.test(value) ? { type: 'http' as const, url: value } : { command: value.split(/\s+/)[0], args: value.split(/\s+/).slice(1) }
    await window.eregion.addMcpServer(name, spec)
    setName('')
    setTarget('')
    await servers.reload()
  })
  const remove = useAction(async (serverName: string) => {
    await window.eregion.removeMcpServer(serverName)
    await servers.reload()
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 960 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="muted">Only the servers you allow are passed to Eregion's Claude Code runs, and nothing else is loaded.</span>
        <div style={{ flex: 1 }} />
        <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void servers.reload()}>
          Rescan
        </button>
      </div>
      {servers.error && <span className="error-text">{servers.error}</span>}
      {!servers.data && !servers.error && <span className="muted">Looking for MCP servers…</span>}
      {servers.data?.map((server) => (
        <section key={server.key} className="panel" aria-label={server.name}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h2 className="mono" style={{ fontSize: 16 }}>
              {server.name}
            </h2>
            <Chip tone="neutral">{server.source}</Chip>
            <StatusPill status={server.allowed ? 'passed' : 'neutral'}>{server.allowed ? 'Allowed' : 'Off'}</StatusPill>
            <div style={{ flex: 1 }} />
            {server.source === 'Eregion' && (
              <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void remove.run(server.name)}>
                Remove
              </button>
            )}
            <Switch label="Allowed" checked={server.allowed} onChange={(on) => void toggle.run(server.key, on)} />
          </div>
          <code className="mono muted" style={{ fontSize: 12.5, wordBreak: 'break-all' }}>
            {describeServer(server)}
          </code>
          {Object.keys(server.spec.env ?? {}).length > 0 && (
            <span className="muted" style={{ fontSize: 13 }}>
              Environment: {Object.keys(server.spec.env ?? {}).join(', ')} (values stay in the file they came from)
            </span>
          )}
          {server.repo && (
            <span className="muted" style={{ fontSize: 13 }}>
              From the {server.repo} repo: each run starts it inside its own copy of {server.repo} (the ticket's worktree, or the plan checkout), not your checkout.
            </span>
          )}
        </section>
      ))}
      {servers.data && servers.data.length === 0 && <span className="muted">No MCP servers found in your Claude Code or Cursor setup, or in the project repos.</span>}
      <section className="panel" aria-label="Add a server">
        <h2 style={{ fontSize: 16 }}>Add a server</h2>
        <form
          style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}
          onSubmit={(event) => {
            event.preventDefault()
            void add.run()
          }}
        >
          <input className="input mono" aria-label="Server name" placeholder="name" value={name} onChange={(event) => setName(event.target.value)} style={{ width: 160 }} />
          <input className="input mono" aria-label="Command or URL" placeholder="npx some-mcp --db {{db_name}}   or   https://…" value={target} onChange={(event) => setTarget(event.target.value)} style={{ flex: '1 1 320px' }} />
          <button type="submit" className="er-btn" disabled={!name.trim() || !target.trim() || add.pending}>
            Add
          </button>
        </form>
        <span className="muted" style={{ fontSize: 13 }}>
          Use {'{{placeholders}}'} for per-ticket values, such as a database named after the ticket. Cursor reads its own mcp.json files; these choices apply to Claude Code runs.
        </span>
        {(add.error || toggle.error || remove.error) && <span className="error-text">{add.error ?? toggle.error ?? remove.error}</span>}
      </section>
    </div>
  )
}
