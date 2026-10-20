import { useEffect, useState, type ReactElement } from 'react'
import type { RuleFile } from '@shared/rules'
import { useAction, useQuery } from '../../hooks'

function Editor({ rule, rules, onSaved }: { rule: RuleFile; rules: RuleFile[]; onSaved: () => void }): ReactElement {
  const [text, setText] = useState(rule.content)
  const [sync, setSync] = useState(false)
  const [pr, setPr] = useState<string | null>(null)
  useEffect(() => {
    setText(rule.content)
    setSync(false)
    setPr(null)
  }, [rule.id, rule.content])
  const dirty = text !== rule.content
  const save = useAction(async () => {
    await window.eregion.saveRule(rule.id, text)
    onSaved()
  })
  const propose = useAction(async () => setPr(await window.eregion.proposeRuleChange(rule.id, text, sync)))
  const file = rule.label.split('/').slice(1).join('/')
  const partnerName = file === 'CLAUDE.md' ? 'AGENTS.md' : file === 'AGENTS.md' ? 'CLAUDE.md' : null
  const partner = partnerName ? rules.find((item) => item.label === rule.label.replace(file, partnerName)) : undefined
  return (
    <section className="panel" aria-label={rule.label} style={{ flex: '1 1 480px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2 className={rule.scope === 'repo' || rule.scope === 'machine' ? 'mono' : undefined} style={{ fontSize: 16 }}>
          {rule.label}
        </h2>
        {dirty && <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--amber-800, #92400E)' }}>Unsaved</span>}
      </div>
      <span className="muted" style={{ fontSize: 13 }}>
        Read by: {rule.readBy}
        {!rule.exists && ' · not created yet'}
      </span>
      <textarea
        className="textarea mono"
        aria-label={`${rule.label} content`}
        rows={22}
        style={{ fontSize: 12.5 }}
        value={text}
        placeholder={rule.scope === 'eregion' ? 'Rules for every stage, in every project. For example: write in British English.' : rule.scope === 'project' ? 'Rules for this project only. For example: run vendor/bin/pint before finishing.' : ''}
        onChange={(event) => setText(event.target.value)}
      />
      {rule.saveBy === 'pr' && partner && (
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
          <input type="checkbox" checked={sync} onChange={(event) => setSync(event.target.checked)} />
          Keep {partnerName} the same as this file
          {partner.exists && partner.content !== rule.content && <span className="muted">(they differ now; {partnerName} would be replaced)</span>}
        </label>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="er-btn" disabled={!dirty} onClick={() => setText(rule.content)}>
          Discard
        </button>
        {rule.saveBy === 'save' ? (
          <button type="button" className="er-btn er-btn-primary" disabled={!dirty || save.pending} onClick={() => void save.run()}>
            Save
          </button>
        ) : (
          <button type="button" className="er-btn er-btn-primary" disabled={(!dirty && !sync) || propose.pending} onClick={() => void propose.run()}>
            {propose.pending ? 'Opening the pull request…' : 'Save and open a PR'}
          </button>
        )}
        {rule.saveBy === 'pr' && (
          <span className="muted" style={{ fontSize: 13 }}>
            Repo rules change through a pull request from the latest base branch. Your checkout isn't touched.
          </span>
        )}
      </div>
      {pr && (
        <span>
          Opened{' '}
          <a
            href={pr}
            onClick={(event) => {
              event.preventDefault()
              void window.eregion.openExternal(pr)
            }}
          >
            {pr}
          </a>
          . Tickets pick the change up once it's merged.
        </span>
      )}
      {(save.error || propose.error) && <span className="error-text">{save.error ?? propose.error}</span>}
    </section>
  )
}

/** The rule files agents read, editable in place. */
export function RulesSettings(): ReactElement {
  const rules = useQuery(() => window.eregion.listRules(), [])
  const [selected, setSelected] = useState('eregion')
  const list = rules.data ?? []
  const rule = list.find((item) => item.id === selected) ?? list[0]
  const groups = [...new Set(list.map((item) => item.group))]
  return (
    <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <nav aria-label="Rule files" className="panel" style={{ flex: '0 1 300px', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <span className="label">Rule files</span>
          <div style={{ flex: 1 }} />
          <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void rules.reload()}>
            Rescan
          </button>
        </div>
        {rules.error && <span className="error-text">{rules.error}</span>}
        {!rules.data && !rules.error && <span className="muted">Looking for rule files…</span>}
        {groups.map((group) => (
          <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>
              {group}
            </span>
            {list
              .filter((item) => item.group === group)
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-current={item.id === rule?.id}
                  onClick={() => setSelected(item.id)}
                  style={{
                    textAlign: 'left',
                    border: 'none',
                    borderRadius: 8,
                    padding: '6px 8px',
                    cursor: 'pointer',
                    font: 'inherit',
                    fontSize: 14,
                    background: item.id === rule?.id ? 'var(--aqua-50)' : 'transparent',
                    color: item.exists ? undefined : 'var(--ink-600)'
                  }}
                >
                  <span className={item.scope === 'repo' || item.scope === 'machine' ? 'mono' : undefined} style={{ fontSize: item.scope === 'repo' ? 13 : 14 }}>
                    {item.label}
                  </span>
                  {!item.exists && <span style={{ fontSize: 12 }}> · create</span>}
                </button>
              ))}
          </div>
        ))}
      </nav>
      {rule && <Editor rule={rule} rules={list} onSaved={() => void rules.reload()} />}
    </div>
  )
}
