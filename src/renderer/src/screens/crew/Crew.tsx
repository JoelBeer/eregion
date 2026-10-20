import { useEffect, useState, type ReactElement } from 'react'
import { ADAPTER_LABELS, type AdapterId } from '@shared/agent'
import { candidateSeeds, rank, ROLES } from '@shared/crew'
import { PALETTES, PARTS, randomSeed, robotFromSeed, type Mood, type RobotParts } from '@shared/robot'
import type { CrewMember } from '@shared/runs'
import { CrewAvatar, RobotAvatar } from '../../components/RobotAvatar'
import { Chip, Switch } from '../../components/ui'
import { useAction, useQuery } from '../../hooks'
import { useQuiet } from '../../quiet'
import { href, navigate } from '../../router'
import { useCrew } from '../Board'

type Look = { seed: number; parts: Partial<RobotParts> }

/** A look picked in the catalogue, carried over to a new crew member. */
let pendingLook: Look | null = null

const MOODS: { mood: Mood; label: string }[] = [
  { mood: 'working', label: 'Working' },
  { mood: 'needsYou', label: 'Needs you' },
  { mood: 'idle', label: 'Idle' },
  { mood: 'stuck', label: 'Stuck' },
  { mood: 'shipped', label: 'Shipped' }
]

const PART_ROWS: { key: keyof RobotParts; label: string; options: readonly string[] }[] = [
  { key: 'palette', label: 'Palette', options: PARTS.palettes },
  { key: 'head', label: 'Head', options: PARTS.heads },
  { key: 'eyes', label: 'Eyes', options: PARTS.eyes },
  { key: 'mouth', label: 'Mouth', options: PARTS.mouths },
  { key: 'antenna', label: 'Antenna', options: PARTS.antennae },
  { key: 'ears', label: 'Ears', options: PARTS.ears },
  { key: 'accessory', label: 'Accessory', options: PARTS.accessories }
]

/** The parts that differ from what the seed would pick, so only real choices are stored. */
function overrides(seed: number, parts: Partial<RobotParts>): Partial<RobotParts> {
  const base = robotFromSeed(seed)
  return Object.fromEntries(Object.entries(parts).filter(([key, value]) => base[key as keyof RobotParts] !== value)) as Partial<RobotParts>
}

function PartRows({ look, onChange }: { look: Look; onChange: (look: Look) => void }): ReactElement {
  const current = { ...robotFromSeed(look.seed), ...look.parts }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {PART_ROWS.map((row) => (
        <div key={row.key} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span className="muted" style={{ width: 80, fontSize: 13 }}>
            {row.label}
          </span>
          {row.options.map((option) => {
            const chosen = current[row.key] === option
            return (
              <button
                key={option}
                type="button"
                title={row.key === 'palette' ? PALETTES[option as keyof typeof PALETTES].name : option}
                aria-label={`${row.label}: ${option}`}
                aria-pressed={chosen}
                onClick={() => onChange({ seed: look.seed, parts: overrides(look.seed, { ...look.parts, [row.key]: option }) })}
                style={{ border: chosen ? '2px solid var(--primary-600)' : '2px solid transparent', borderRadius: 10, padding: 2, background: 'var(--surface-0, #fff)', cursor: 'pointer' }}
              >
                <RobotAvatar seed={look.seed} {...look.parts} {...{ [row.key]: option }} size={36} />
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function CrewList(): ReactElement {
  const crew = useCrew()
  const stats = useQuery(() => window.eregion.crewStats(), [], (event) => event.type === 'crew-changed' || event.type === 'run-state').data ?? []
  const { quiet, setQuiet, chime, setChime } = useQuiet()
  const reroll = useAction((member: CrewMember) => window.eregion.updateCrew(member.id, { seed: randomSeed(), parts: {} }))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 26 }}>Crew</h1>
        <span className="muted">Shared across projects</span>
        <div style={{ flex: 1 }} />
        <Switch label="Needs-you chime" checked={chime && !quiet} onChange={setChime} />
        <Switch label="Quiet mode" checked={quiet} onChange={setQuiet} />
        <a className="er-btn" href={href({ name: 'crew', view: 'catalogue', id: null })}>
          Avatar catalogue
        </a>
        <a className="er-btn er-btn-primary" href={href({ name: 'crew', view: 'new', id: null })}>
          + New crew member
        </a>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
        {crew.map((member) => {
          const memberStats = stats.find((item) => item.crewId === member.id)
          return (
            <section key={member.id} className="panel" aria-label={member.name} style={{ alignItems: 'center', textAlign: 'center' }}>
              <CrewAvatar member={member} size={88} background />
              <h2 style={{ fontSize: 20 }}>{member.name}</h2>
              <span>{member.role}</span>
              <span className="muted" style={{ fontSize: 13 }}>
                {ADAPTER_LABELS[member.adapter]} · <span className="mono">{member.model}</span>
              </span>
              <Chip tone="info">
                {rank(memberStats?.shipped ?? 0)} · {memberStats?.shipped ?? 0} shipped
              </Chip>
              <span className="muted" style={{ fontSize: 12 }}>
                {memberStats ? `${memberStats.runs} runs · $${memberStats.costUsd.toFixed(2)}` : 'No runs yet'}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <a className="er-btn er-btn-sm" href={href({ name: 'crew', view: 'edit', id: member.id })}>
                  Edit
                </a>
                <button type="button" className="er-btn er-btn-sm er-btn-ghost" onClick={() => void reroll.run(member)}>
                  Re-roll
                </button>
              </div>
            </section>
          )
        })}
      </div>
      {reroll.error && <span className="error-text">{reroll.error}</span>}
      {crew[0] && (
        <section className="panel" aria-label="Moods">
          <span className="label">Moods on the board</span>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            {MOODS.map((item) => (
              <span key={item.mood} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, fontSize: 13 }}>
                <CrewAvatar member={crew[0]} mood={item.mood} size={44} />
                {item.label}
              </span>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 13 }}>
            Quiet mode takes the robots and their speech bubbles off the board and silences the chime; status stays.
          </span>
        </section>
      )}
    </div>
  )
}

function MemberEditor({ member }: { member: CrewMember | null }): ReactElement {
  const [look, setLook] = useState<Look>(() => (member ? { seed: member.seed, parts: member.parts ?? {} } : (pendingLook ?? { seed: randomSeed(), parts: {} })))
  const suggested = robotFromSeed(look.seed).name
  const [name, setName] = useState(member?.name ?? '')
  const [role, setRole] = useState<CrewMember['role']>(member?.role ?? 'Builder')
  const [adapter, setAdapter] = useState<AdapterId>(member?.adapter ?? 'claude-code')
  const [model, setModel] = useState(member?.model ?? 'claude-sonnet-5-5')
  const [building, setBuilding] = useState(Object.keys(look.parts).length > 0)
  const models = useQuery(() => window.eregion.listModels(adapter), [adapter]).data ?? []
  useEffect(() => {
    pendingLook = null
  }, [])
  useEffect(() => {
    if (models.length > 0 && !models.some((option) => option.id === model)) setModel(models[0].id)
  }, [models, model])
  const save = useAction(async () => {
    const fields = { name: name.trim() || suggested, role, adapter, model, seed: look.seed, parts: look.parts }
    if (member) await window.eregion.updateCrew(member.id, fields)
    else await window.eregion.createCrew(fields)
    navigate({ name: 'crew', view: 'list', id: null })
  })
  const remove = useAction(async () => {
    if (member && window.confirm(`Remove ${member.name} from the crew? Stages that named ${member.name} go back to whoever has their role.`)) {
      await window.eregion.deleteCrew(member.id)
      navigate({ name: 'crew', view: 'list', id: null })
    }
  })
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <a href={href({ name: 'crew', view: 'list', id: null })} style={{ fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
        ← Crew
      </a>
      <h1 style={{ fontSize: 26 }}>{member ? `Edit ${member.name}` : 'New crew member'}</h1>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <section className="panel" aria-label="Look" style={{ flex: '1 1 380px', alignItems: 'center' }}>
          <RobotAvatar seed={look.seed} {...look.parts} size={150} background />
          <span className="mono muted" style={{ fontSize: 12 }}>
            seed {robotFromSeed(look.seed).seedHex}
            {Object.keys(look.parts).length > 0 ? ` · ${Object.keys(look.parts).length} parts picked by hand` : ''}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="er-btn er-btn-sm" onClick={() => setLook({ seed: randomSeed(), parts: {} })}>
              Re-roll
            </button>
            <button type="button" className="er-btn er-btn-sm er-btn-ghost" aria-pressed={building} onClick={() => setBuilding(!building)}>
              Build one part by part
            </button>
          </div>
          {building ? (
            <PartRows look={look} onChange={setLook} />
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, auto)', gap: 8 }}>
              {candidateSeeds(look.seed).map((seed) => (
                <button key={seed} type="button" aria-label={`Use ${robotFromSeed(seed).name}`} onClick={() => setLook({ seed, parts: {} })} style={{ border: '1px solid var(--divider-100)', borderRadius: 12, padding: 6, background: 'var(--surface-0, #fff)', cursor: 'pointer' }}>
                  <RobotAvatar seed={seed} size={52} />
                </button>
              ))}
            </div>
          )}
        </section>
        <section className="panel" aria-label="Details" style={{ flex: '1 1 320px' }}>
          <div className="field">
            <label htmlFor="crew-name">Name</label>
            <input id="crew-name" className="input" placeholder={suggested} value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="crew-role">Role</label>
            <select id="crew-role" className="select" value={role} onChange={(event) => setRole(event.target.value as CrewMember['role'])}>
              {ROLES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="crew-agent">Agent</label>
            <select id="crew-agent" className="select" value={adapter} onChange={(event) => setAdapter(event.target.value as AdapterId)}>
              {(Object.keys(ADAPTER_LABELS) as AdapterId[]).map((item) => (
                <option key={item} value={item}>
                  {ADAPTER_LABELS[item]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="crew-model">Model</label>
            <select id="crew-model" className="select" value={model} onChange={(event) => setModel(event.target.value)}>
              {models.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="muted" style={{ fontSize: 12 }}>
              Add more models in Settings › Agents.
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="er-btn er-btn-primary" disabled={save.pending} onClick={() => void save.run()}>
              {member ? 'Save' : 'Add to the crew'}
            </button>
            <a className="er-btn" href={href({ name: 'crew', view: 'list', id: null })}>
              Cancel
            </a>
            {member && (
              <button type="button" className="er-btn er-btn-ghost" style={{ marginLeft: 'auto' }} onClick={() => void remove.run()}>
                Remove
              </button>
            )}
          </div>
          {(save.error || remove.error) && <span className="error-text">{save.error ?? remove.error}</span>}
        </section>
      </div>
    </div>
  )
}

function Catalogue(): ReactElement {
  const [look, setLook] = useState<Look>({ seed: randomSeed(), parts: {} })
  const [size, setSize] = useState(120)
  const [background, setBackground] = useState(true)
  const [mood, setMood] = useState<Mood>('working')
  const [wallSeed] = useState(randomSeed)
  const wall = Array.from({ length: 32 }, (_, index) => (wallSeed + index * 0x9e3779b1) >>> 0)
  const code = `<RobotAvatar seed={0x${robotFromSeed(look.seed).seedHex}}${Object.entries(look.parts)
    .map(([key, value]) => ` ${key}="${value}"`)
    .join('')}${mood !== 'working' ? ` mood="${mood}"` : ''} size={${size}} />`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <a href={href({ name: 'crew', view: 'list', id: null })} style={{ fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
        ← Crew
      </a>
      <header style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 26 }}>Avatar catalogue</h1>
        <div style={{ flex: 1 }} />
        <button type="button" className="er-btn" onClick={() => setLook({ seed: randomSeed(), parts: {} })}>
          Surprise me
        </button>
        <button
          type="button"
          className="er-btn er-btn-primary"
          onClick={() => {
            pendingLook = look
            navigate({ name: 'crew', view: 'new', id: null })
          }}
        >
          Use for a new crew member
        </button>
      </header>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <section className="panel" aria-label="Preview" style={{ flex: '0 1 320px', alignItems: 'center' }}>
          <div style={{ minHeight: 170, display: 'grid', placeItems: 'center' }}>
            <RobotAvatar seed={look.seed} {...look.parts} mood={mood} size={size} background={background} />
          </div>
          <span style={{ fontWeight: 600 }}>{robotFromSeed(look.seed).name}</span>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            Size
            <input type="range" min={22} max={160} value={size} onChange={(event) => setSize(Number(event.target.value))} />
            {size}px
          </label>
          <Switch label="Background tile" checked={background} onChange={setBackground} />
          <select className="select" aria-label="Mood" value={mood} onChange={(event) => setMood(event.target.value as Mood)}>
            {MOODS.map((item) => (
              <option key={item.mood} value={item.mood}>
                {item.label}
              </option>
            ))}
          </select>
          <code className="mono" style={{ fontSize: 11.5, wordBreak: 'break-all', background: 'var(--surface-25, #F7F8FB)', padding: 8, borderRadius: 8 }}>
            {code}
          </code>
        </section>
        <section className="panel" aria-label="Parts" style={{ flex: '1 1 480px' }}>
          <PartRows look={look} onChange={setLook} />
        </section>
      </div>
      <section className="panel" aria-label="Seeded robots">
        <span className="label">Seeded robots</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {wall.map((seed) => (
            <button key={seed} type="button" title={robotFromSeed(seed).name} onClick={() => setLook({ seed, parts: {} })} style={{ border: '1px solid var(--divider-100)', borderRadius: 10, padding: 4, background: 'var(--surface-0, #fff)', cursor: 'pointer' }}>
              <RobotAvatar seed={seed} size={44} />
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}

export function CrewScreen({ view, id }: { view: 'list' | 'new' | 'catalogue' | 'edit'; id: number | null }): ReactElement {
  const crew = useCrew()
  const member = view === 'edit' ? crew.find((item) => item.id === id) : null
  return (
    <main style={{ flex: 1, minWidth: 0, padding: '24px 28px' }}>
      {view === 'list' && <CrewList />}
      {view === 'new' && <MemberEditor member={null} />}
      {view === 'edit' && (member ? <MemberEditor key={member.id} member={member} /> : <span className="muted">Loading…</span>)}
      {view === 'catalogue' && <Catalogue />}
    </main>
  )
}
