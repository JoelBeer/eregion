/** Crew avatar parts and the seeded generator, ported from the Eregion design system. Same seed, same robot. */

export const PALETTES = {
  ember: { name: 'Ember', head: '#FFB27A', accent: '#FF8A4C', tint: '#FFF1E6' },
  teal: { name: 'Teal', head: '#5FC4B8', accent: '#0E7C86', tint: '#E3F6F3' },
  periwinkle: { name: 'Periwinkle', head: '#9DB4F2', accent: '#4C6FD9', tint: '#ECF0FC' },
  brass: { name: 'Brass', head: '#F2D06B', accent: '#C99A1E', tint: '#FCF5DD' },
  sky: { name: 'Sky', head: '#7CC6E6', accent: '#2F8FB8', tint: '#E6F4FB' },
  rose: { name: 'Rose', head: '#F29BB8', accent: '#D9567F', tint: '#FCEAF0' },
  moss: { name: 'Moss', head: '#A8D97A', accent: '#5FA33A', tint: '#EEF8E4' },
  lilac: { name: 'Lilac', head: '#C6A6F2', accent: '#8A5FD9', tint: '#F2ECFC' }
} as const

export type Palette = keyof typeof PALETTES
export type Head = 'rounded' | 'round' | 'square' | 'tall' | 'wide'
export type Eyes = 'round' | 'happy' | 'sleepy' | 'visor' | 'wink'
export type Mouth = 'none' | 'smile' | 'flat' | 'grille' | 'o'
export type Antenna = 'single' | 'double' | 'spring' | 'dish' | 'none'
export type Ears = 'none' | 'bolts' | 'discs'
export type Accessory = 'none' | 'goggles' | 'hardhat' | 'headset' | 'bowtie'
export type Mood = 'working' | 'needsYou' | 'idle' | 'stuck' | 'shipped'

export const PARTS = {
  palettes: Object.keys(PALETTES) as Palette[],
  heads: ['rounded', 'round', 'square', 'tall', 'wide'] as Head[],
  eyes: ['round', 'happy', 'sleepy', 'visor', 'wink'] as Eyes[],
  mouths: ['none', 'smile', 'flat', 'grille', 'o'] as Mouth[],
  antennae: ['single', 'double', 'spring', 'dish', 'none'] as Antenna[],
  ears: ['none', 'bolts', 'discs'] as Ears[],
  accessories: ['none', 'goggles', 'hardhat', 'headset', 'bowtie'] as Accessory[],
  moods: ['working', 'needsYou', 'idle', 'stuck', 'shipped'] as Mood[]
}

const NAMES = [
  'Flux', 'Tongs', 'Bellows', 'Quench', 'Cinder', 'Temper', 'Billet', 'Spark', 'Crucible', 'Slag',
  'Hammer', 'Chisel', 'Ingot', 'Rivet', 'Anvil', 'Ember', 'Forge', 'Ladle', 'Filament', 'Brazier'
]

export interface RobotParts {
  palette: Palette
  head: Head
  eyes: Eyes
  mouth: Mouth
  antenna: Antenna
  ears: Ears
  accessory: Accessory
}

export interface Robot extends RobotParts {
  name: string
  seed: number
  seedHex: string
}

/** mulberry32: small, fast and deterministic. */
function rng(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let x = t
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(random: () => number, list: readonly T[]): T {
  return list[Math.floor(random() * list.length)]
}

export function robotFromSeed(seed: number): Robot {
  const s = Number(seed) >>> 0
  const random = rng(s)
  return {
    palette: pick(random, PARTS.palettes),
    head: pick(random, PARTS.heads),
    eyes: pick(random, PARTS.eyes),
    mouth: pick(random, PARTS.mouths),
    antenna: pick(random, PARTS.antennae),
    ears: pick(random, PARTS.ears),
    accessory: pick(random, ['none', 'none', 'none', 'goggles', 'hardhat', 'headset', 'bowtie'] as Accessory[]),
    name: pick(random, NAMES),
    seed: s,
    seedHex: s.toString(16).toUpperCase().padStart(8, '0')
  }
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 4294967296)
}
