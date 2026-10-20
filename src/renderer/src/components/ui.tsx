import type { ButtonHTMLAttributes, CSSProperties, ReactElement, ReactNode } from 'react'
import type { Mood, Palette, RobotParts } from '@shared/robot'
import { RobotAvatar } from './RobotAvatar'

function cx(...names: (string | false | undefined | null)[]): string {
  return names.filter(Boolean).join(' ')
}

type ButtonVariant = 'primary' | 'secondary' | 'dashed' | 'ghost' | 'onforge'

export function Button({
  variant = 'secondary',
  size,
  className,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }): ReactElement {
  return (
    <button
      type={type}
      className={cx('er-btn', variant !== 'secondary' && `er-btn-${variant}`, size === 'sm' && 'er-btn-sm', className)}
      {...rest}
    />
  )
}

export function Chip({ tone = 'teal', mono, children, style }: { tone?: 'teal' | 'info' | 'neutral' | 'forge'; mono?: boolean; children: ReactNode; style?: CSSProperties }): ReactElement {
  return (
    <span className={cx('er-chip', tone !== 'teal' && `er-chip-${tone}`, mono && 'er-chip-mono')} style={style}>
      {children}
    </span>
  )
}

export type PillStatus = 'running' | 'passed' | 'needsYou' | 'settingUp' | 'failed' | 'fixing' | 'waiting' | 'info' | 'idle' | 'backlog' | 'neutral'

const PILL_LABELS: Record<PillStatus, string> = {
  running: 'Running',
  needsYou: 'Needs you',
  failed: 'Failed',
  fixing: 'Fixing CI',
  waiting: 'Waiting',
  passed: 'Passed',
  idle: 'Idle',
  backlog: 'Backlog',
  settingUp: 'Setting up',
  info: 'Info',
  neutral: ''
}

export function StatusPill({ status, children }: { status: PillStatus; children?: ReactNode }): ReactElement {
  return <span className={`er-pill er-pill-${status}`}>{children ?? PILL_LABELS[status]}</span>
}

export function ProjectBadge({ initials, color, size = 26, label }: { initials: string; color?: string; size?: number; label?: string }): ReactElement {
  return (
    <span
      className="er-badge"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.27), background: color ?? 'var(--aqua-400, #76E1EF)', fontSize: Math.round(size * 0.42) }}
    >
      {initials}
    </span>
  )
}

export function SpeechBubble({ palette, seed, parts, mood, children }: { palette?: Palette; seed?: number; parts?: Partial<RobotParts>; mood?: Mood; children: ReactNode }): ReactElement {
  const bubble = <span className="er-bubble">{children}</span>
  if (!palette && seed === undefined) {
    return bubble
  }
  return (
    <div className="er-said">
      <RobotAvatar palette={palette} seed={seed} {...parts} mood={mood} size={30} />
      {bubble}
    </div>
  )
}

export function Card({ tone = 'default', children, style, label }: { tone?: 'default' | 'amber' | 'red' | 'sky' | 'faded'; children: ReactNode; style?: CSSProperties; label?: string }): ReactElement {
  return (
    <article className={cx('er-card', tone !== 'default' && `er-card-${tone}`)} style={style} aria-label={label}>
      {children}
    </article>
  )
}

export interface Step {
  label: string
  state: 'done' | 'current' | 'todo'
}

export function Stepper({ steps, label = 'Stages' }: { steps: Step[]; label?: string }): ReactElement {
  return (
    <ol className="er-steps" aria-label={label}>
      {steps.map((step, index) => (
        <li key={step.label} className={cx('er-step', `er-step-${step.state}`)} aria-current={step.state === 'current' ? 'step' : undefined}>
          {(step.state === 'done' ? '✓ ' : `${index + 1} · `) + step.label}
        </li>
      ))}
    </ol>
  )
}

export function Tabs<T extends string>({ items, selected, onSelect, label = 'Sections' }: { items: { id: T; label: string }[]; selected: T; onSelect: (id: T) => void; label?: string }): ReactElement {
  return (
    <div role="tablist" className="er-tabs" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={item.id === selected}
          className={cx('er-tab', item.id === selected && 'er-tab-selected')}
          style={{ background: 'transparent', borderTop: 'none', borderLeft: 'none', borderRight: 'none', cursor: 'pointer', font: 'inherit' }}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}

export function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }): ReactElement {
  return (
    <label className="er-switch">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="er-switch-track" aria-hidden />
      <span>{label}</span>
    </label>
  )
}
