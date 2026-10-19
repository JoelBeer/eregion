import type { ReactElement } from 'react'

type Shape = ['rect' | 'circle' | 'path' | 'line', Record<string, number | string>]

function Icon({ shapes, size = 18 }: { shapes: Shape[]; size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden style={{ flex: 'none' }}>
      {shapes.map(([Tag, attrs], index) => (
        <Tag key={index} {...attrs} />
      ))}
    </svg>
  )
}

const SHAPES = {
  board: [['rect', { x: 3, y: 4, width: 5, height: 16, rx: 1.5 }], ['rect', { x: 10, y: 4, width: 5, height: 11, rx: 1.5 }], ['rect', { x: 17, y: 4, width: 4, height: 7, rx: 1.5 }]],
  crew: [['rect', { x: 5, y: 7, width: 14, height: 12, rx: 4 }], ['path', { d: 'M12 3v4' }], ['circle', { cx: 9.5, cy: 13, r: 1 }], ['circle', { cx: 14.5, cy: 13, r: 1 }]],
  forge: [['path', { d: 'M12 3c1 4 6 6 6 11a6 6 0 0 1-12 0c0-3 2-5 3-7 1 2 2 3 3 3 1-2 0-5 0-7z' }]],
  pipeline: [['circle', { cx: 5, cy: 12, r: 2 }], ['circle', { cx: 12, cy: 12, r: 2 }], ['circle', { cx: 19, cy: 12, r: 2 }], ['path', { d: 'M7 12h3M14 12h3' }]],
  costs: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1-3 2.3c0 3 6 1.6 6 4.6 0 1.4-1.3 2.6-3 2.6s-3-1.1-3-2.5M12 5.5v13' }]],
  projects: [['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }], ['rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }]],
  settings: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  updown: [['path', { d: 'M8 9l4-4 4 4M8 15l4 4 4-4' }]],
  collapse: [['path', { d: 'M11 17l-5-5 5-5M18 17l-5-5 5-5' }]],
  expand: [['path', { d: 'M13 17l5-5-5-5M6 17l5-5-5-5' }]],
  up: [['path', { d: 'M6 15l6-6 6 6' }]],
  down: [['path', { d: 'M6 9l6 6 6-6' }]],
  trash: [['path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13' }]],
  folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  mic: [['rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }], ['path', { d: 'M5 11a7 7 0 0 0 14 0M12 18v3' }]]
} satisfies Record<string, Shape[]>

export type IconName = keyof typeof SHAPES

export function NavIcon({ name, size }: { name: IconName; size?: number }): ReactElement {
  return <Icon shapes={SHAPES[name] as Shape[]} size={size} />
}

export function Logo(): ReactElement {
  return (
    <svg width={28} height={28} viewBox="0 0 28 28" aria-hidden style={{ flex: 'none' }}>
      <rect width={28} height={28} rx={8} style={{ fill: 'var(--accent-400, #76E1EF)' }} />
      <path d="M3 9.5H24V13H19.5L17.5 15.5V18H20.5V21H7.5V18H10.5V15.5L9 13.5Q5.5 13 3 9.5Z" style={{ fill: 'var(--ink-deep, #06304A)' }} />
      <circle cx={21.5} cy={5.5} r={1.5} style={{ fill: 'var(--aqua-100, #C9F0F6)' }} />
      <circle cx={18} cy={4.5} r={1} style={{ fill: 'var(--aqua-100, #C9F0F6)' }} />
    </svg>
  )
}
