import { describe, expect, it } from 'vitest'
import { PARTS, robotFromSeed } from './robot'

describe('robotFromSeed', () => {
  it('gives the same robot for the same seed', () => {
    expect(robotFromSeed(2134567821)).toEqual(robotFromSeed(2134567821))
  })

  it('only uses known parts and formats the seed as eight hex digits', () => {
    for (let seed = 0; seed < 500; seed++) {
      const robot = robotFromSeed(seed * 2654435761)
      expect(PARTS.palettes).toContain(robot.palette)
      expect(PARTS.heads).toContain(robot.head)
      expect(PARTS.eyes).toContain(robot.eyes)
      expect(PARTS.mouths).toContain(robot.mouth)
      expect(PARTS.antennae).toContain(robot.antenna)
      expect(PARTS.ears).toContain(robot.ears)
      expect(PARTS.accessories).toContain(robot.accessory)
      expect(robot.seedHex).toMatch(/^[0-9A-F]{8}$/)
    }
  })

  it('spreads seeds across every palette', () => {
    const seen = new Set(Array.from({ length: 400 }, (_, seed) => robotFromSeed(seed).palette))
    expect(seen.size).toBe(PARTS.palettes.length)
  })
})
