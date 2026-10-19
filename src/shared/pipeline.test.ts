import { describe, expect, it } from 'vitest'
import { defaultPipeline, moveStage, nextStage, validatePipeline, type StageConfig } from './pipeline'

function custom(id: string): StageConfig {
  return { ...defaultPipeline()[1], id, name: id, kind: 'custom', goal: 'Do it' }
}

const ids = (stages: StageConfig[]): string[] => stages.map((stage) => stage.id)

describe('defaultPipeline', () => {
  it('is valid', () => {
    expect(validatePipeline(defaultPipeline())).toEqual([])
  })
})

describe('moveStage', () => {
  const stages = [...defaultPipeline().slice(0, 3), custom('docs'), ...defaultPipeline().slice(3)]

  it('moves a stage', () => {
    expect(ids(moveStage(stages, 3, 1))).toEqual(['plan', 'docs', 'build', 'review', 'pr', 'ci'])
  })

  it('never moves a stage before Plan or after Watch CI', () => {
    expect(ids(moveStage(stages, 3, 0))).toEqual(['plan', 'docs', 'build', 'review', 'pr', 'ci'])
    expect(ids(moveStage(stages, 3, 9))).toEqual(['plan', 'build', 'review', 'pr', 'docs', 'ci'])
  })

  it('leaves Plan and Watch CI where they are', () => {
    expect(moveStage(stages, 0, 2)).toBe(stages)
    expect(moveStage(stages, 5, 1)).toBe(stages)
  })
})

describe('validatePipeline', () => {
  it('wants Plan first and Watch CI last', () => {
    const [plan, build, ...rest] = defaultPipeline()
    expect(validatePipeline([build, plan, ...rest])).toContain('The pipeline must start with exactly one Plan stage')
    const stages = defaultPipeline()
    expect(validatePipeline([...stages.slice(0, 3), stages[4], stages[3]])).toContain('Watch CI must be the last stage')
  })

  it('needs a goal and a real stage to return to', () => {
    const stages = defaultPipeline()
    stages[1] = { ...stages[1], goal: ' ' }
    stages[2] = { ...stages[2], onFailure: { returnTo: 'nowhere', maxLoops: 2 } }
    expect(validatePipeline(stages)).toEqual(['Build has no goal', "Review returns to a stage that doesn't exist"])
  })
})

describe('nextStage', () => {
  it('skips a switched-off Watch CI', () => {
    const stages = defaultPipeline()
    stages[4] = { ...stages[4], enabled: false }
    expect(nextStage(stages, 'pr')).toBeNull()
    expect(nextStage(stages, 'review')?.id).toBe('pr')
  })
})
