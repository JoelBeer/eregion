import type { CSSProperties, ReactElement } from 'react'
import { PALETTES, robotFromSeed, type Mood, type Palette, type RobotParts } from '@shared/robot'

const HEADS = {
  rounded: { x: 5, y: 9, w: 22, h: 18, rx: 6, face: [9, 14, 14, 7] },
  round: { x: 5, y: 8, w: 22, h: 20, rx: 10, face: [9, 14, 14, 7] },
  square: { x: 5, y: 9, w: 22, h: 18, rx: 2.5, face: [9, 13.5, 14, 7.5] },
  tall: { x: 7, y: 7, w: 18, h: 21, rx: 5, face: [9.5, 13, 13, 8] },
  wide: { x: 3, y: 11, w: 26, h: 15, rx: 6, face: [8, 15, 16, 6.5] }
} as const

function tv(name: string, fallback: string): string {
  return `var(--${name}, ${fallback})`
}

function colours(id: Palette): { head: string; accent: string; tint: string } {
  const p = PALETTES[id] ?? PALETTES.teal
  return { head: tv(`crew-${id}-head`, p.head), accent: tv(`crew-${id}-accent`, p.accent), tint: tv(`crew-${id}-tint`, p.tint) }
}

export interface RobotAvatarProps extends Partial<RobotParts> {
  seed?: number
  mood?: Mood
  size?: number
  background?: boolean
  onDark?: boolean
  title?: string
  style?: CSSProperties
}

/** A crew member's robot. A seed picks every part; explicit parts override the seed. */
export function RobotAvatar(props: RobotAvatarProps): ReactElement {
  let p: RobotParts = { palette: 'teal', head: 'rounded', eyes: 'round', mouth: 'none', antenna: 'single', ears: 'none', accessory: 'none' }
  if (props.seed !== undefined) {
    p = { ...p, ...robotFromSeed(props.seed) }
  }
  for (const key of ['palette', 'head', 'eyes', 'mouth', 'antenna', 'ears', 'accessory'] as const) {
    if (props[key]) {
      p = { ...p, [key]: props[key] }
    }
  }
  const size = props.size ?? 32
  const c = colours(p.palette)
  const H = HEADS[p.head] ?? HEADS.rounded
  const f = { x: H.face[0], y: H.face[1], w: H.face[2], h: H.face[3] }
  const cy = f.y + f.h / 2
  const ink = '#0B3640'
  const glow = tv('term-glow', '#76E1EF')
  const line = props.onDark ? '#CDEBF7' : ink
  let bulb = c.accent
  const mood = props.mood ?? 'working'
  let eyes: string = p.eyes
  if (mood === 'idle') {
    eyes = 'sleepy'
    bulb = c.head
  }
  if (mood === 'stuck') {
    eyes = 'stuck'
    bulb = tv('red-700', '#B42318')
  }
  if (mood === 'shipped') {
    eyes = 'happy'
    bulb = tv('accent-400', '#76E1EF')
  }
  if (mood === 'needsYou') {
    bulb = tv('amber-400', '#F2C46D')
  }

  const parts: ReactElement[] = []
  const add = (tag: string, attrs: Record<string, unknown>): void => {
    const Tag = tag as 'rect'
    parts.push(<Tag key={parts.length} {...(attrs as object)} />)
  }
  const top = H.y
  if (props.background) add('rect', { x: 0, y: 0, width: 32, height: 32, rx: 8, style: { fill: c.tint } })
  if (p.antenna === 'single') {
    add('line', { x1: 16, y1: top - 5, x2: 16, y2: top, stroke: line, strokeWidth: 1.5 })
    add('circle', { cx: 16, cy: top - 5, r: 2.5, style: { fill: bulb } })
  } else if (p.antenna === 'double') {
    add('line', { x1: 12, y1: top, x2: 10, y2: top - 4.5, stroke: line, strokeWidth: 1.5 })
    add('line', { x1: 20, y1: top, x2: 22, y2: top - 4.5, stroke: line, strokeWidth: 1.5 })
    add('circle', { cx: 10, cy: top - 4.5, r: 2, style: { fill: bulb } })
    add('circle', { cx: 22, cy: top - 4.5, r: 2, style: { fill: bulb } })
  } else if (p.antenna === 'spring') {
    add('path', { d: `M16 ${top} l-1.6 -1.1 l3.2 -1.1 l-3.2 -1.1 l3.2 -1.1 l-1.6 -0.6`, stroke: line, strokeWidth: 1.2, fill: 'none' })
    add('circle', { cx: 16, cy: top - 5.6, r: 1.9, style: { fill: bulb } })
  } else if (p.antenna === 'dish') {
    add('line', { x1: 16, y1: top - 2.5, x2: 16, y2: top, stroke: line, strokeWidth: 1.5 })
    add('path', { d: `M12 ${top - 4.5} q4 4 8 0 z`, style: { fill: bulb } })
  }
  const ey = H.y + H.h / 2
  if (p.ears === 'bolts') {
    add('rect', { x: H.x - 2, y: ey - 3, width: 2, height: 6, rx: 1, style: { fill: c.accent } })
    add('rect', { x: H.x + H.w, y: ey - 3, width: 2, height: 6, rx: 1, style: { fill: c.accent } })
  } else if (p.ears === 'discs') {
    add('circle', { cx: H.x - 0.5, cy: ey, r: 2.4, style: { fill: c.accent } })
    add('circle', { cx: H.x + H.w + 0.5, cy: ey, r: 2.4, style: { fill: c.accent } })
  }
  add('rect', { x: H.x, y: H.y, width: H.w, height: H.h, rx: H.rx, style: { fill: c.head } })
  add('rect', { x: f.x, y: f.y, width: f.w, height: f.h, rx: Math.min(3.5, f.h / 2), style: { fill: ink } })
  if (eyes === 'round') {
    add('circle', { cx: 13, cy, r: 1.7, style: { fill: glow } })
    add('circle', { cx: 19, cy, r: 1.7, style: { fill: glow } })
  } else if (eyes === 'happy') {
    add('path', { d: `M11 ${cy + 1} q2 -2.5 4 0 M17 ${cy + 1} q2 -2.5 4 0`, fill: 'none', strokeWidth: 1.6, style: { stroke: glow } })
  } else if (eyes === 'sleepy') {
    add('path', { d: `M11 ${cy} h4 M17 ${cy} h4`, strokeWidth: 1.6, style: { stroke: glow } })
  } else if (eyes === 'visor') {
    add('rect', { x: f.x + 1.5, y: cy - 1.3, width: f.w - 3, height: 2.6, rx: 1.3, style: { fill: glow } })
  } else if (eyes === 'wink') {
    add('circle', { cx: 13, cy, r: 1.7, style: { fill: glow } })
    add('path', { d: `M17 ${cy} h4`, strokeWidth: 1.6, style: { stroke: glow } })
  } else if (eyes === 'stuck') {
    add('path', { d: `M11.5 ${cy - 1.5} l3 3 m0 -3 l-3 3 M17.5 ${cy - 1.5} l3 3 m0 -3 l-3 3`, strokeWidth: 1.4, style: { stroke: glow } })
  }
  const my = Math.min(f.y + f.h + 2.6, H.y + H.h - 2.2)
  if (p.mouth === 'smile') add('path', { d: `M13.5 ${my - 0.8} q2.5 2 5 0`, stroke: ink, strokeWidth: 1.3, fill: 'none' })
  else if (p.mouth === 'flat') add('path', { d: `M14 ${my} h4`, stroke: ink, strokeWidth: 1.3 })
  else if (p.mouth === 'grille') add('path', { d: `M14 ${my - 1} v2 M16 ${my - 1} v2 M18 ${my - 1} v2`, stroke: ink, strokeWidth: 1.1 })
  else if (p.mouth === 'o') add('circle', { cx: 16, cy: my, r: 1.1, fill: 'none', stroke: ink, strokeWidth: 1.2 })
  if (p.accessory === 'goggles') {
    add('rect', { x: H.x, y: H.y + 1.6, width: H.w, height: 2.2, style: { fill: ink } })
    add('circle', { cx: 12.5, cy: H.y + 2.7, r: 2.3, fill: '#CDEBF7', stroke: ink, strokeWidth: 1 })
    add('circle', { cx: 19.5, cy: H.y + 2.7, r: 2.3, fill: '#CDEBF7', stroke: ink, strokeWidth: 1 })
  } else if (p.accessory === 'hardhat') {
    add('path', { d: `M${H.x - 1} ${H.y + 2} q${H.w / 2 + 1} -9 ${H.w + 2} 0 z`, style: { fill: tv('amber-400', '#F2C46D') } })
    add('rect', { x: H.x - 2, y: H.y + 1, width: H.w + 4, height: 2, rx: 1, fill: '#C99A1E' })
  } else if (p.accessory === 'headset') {
    add('path', { d: `M${H.x + 1} ${H.y + 6} q${H.w / 2 - 1} -13 ${H.w - 2} 0`, stroke: ink, strokeWidth: 1.6, fill: 'none' })
    add('rect', { x: H.x - 1.5, y: H.y + 5, width: 3, height: 5, rx: 1.2, style: { fill: ink } })
    add('rect', { x: H.x + H.w - 1.5, y: H.y + 5, width: 3, height: 5, rx: 1.2, style: { fill: ink } })
    add('path', { d: `M${H.x + H.w} ${H.y + 10} q-1 5 -6 6`, stroke: ink, strokeWidth: 1.2, fill: 'none' })
    add('circle', { cx: H.x + H.w - 6, cy: H.y + 16, r: 0.9, style: { fill: ink } })
  } else if (p.accessory === 'bowtie') {
    const by = H.y + H.h + 2
    add('path', { d: `M16 ${by} l-3.2 -1.8 v3.6 z M16 ${by} l3.2 -1.8 v3.6 z`, style: { fill: c.accent } })
    add('circle', { cx: 16, cy: by, r: 1, style: { fill: c.accent } })
  }
  if (mood === 'needsYou') add('path', { d: 'M28 6l2-3M29 9l3-1', strokeWidth: 1.5, style: { stroke: tv('primary-600', '#0B6594') } })

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role={props.title ? 'img' : undefined}
      aria-label={props.title}
      aria-hidden={props.title ? undefined : true}
      style={{ flex: 'none', display: 'block', overflow: 'visible', ...props.style }}
    >
      {parts}
    </svg>
  )
}
