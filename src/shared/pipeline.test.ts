import { describe, expect, it } from 'vitest'
import { defaultPipeline, moveStage, nextStage, stageAccess, stageFromTemplate, validatePipeline, verdictFile, type StageConfig } from './pipeline'

function custom(id: string): StageConfig {
  return { ...defaultPipeline()[1], id, name: id, kind: 'custom', goal: 'Do it' }
}

const ids = (stages: StageConfig[]): string[] => stages.map((stage) => stage.id)

describe('checkIgnored', () => {
  it('matches a check by name in any case, from the ticket or the stage', async () => {
    const { checkIgnored } = await import('./pipeline')
    expect(checkIgnored('codecov/patch', ['Codecov/Patch'])).toBe(true)
    expect(checkIgnored('coverage', [], ['coverage'])).toBe(true)
    expect(checkIgnored('tests', ['coverage'], ['lint'])).toBe(false)
  })
})

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
    expect(validatePipeline(stages)).toEqual(['Build has no goal', "Review goes back to a stage that doesn't exist"])
  })
})

describe('generic stages', () => {
  it('needs a verdict file, a done command, and an earlier stage to go back to', () => {
    const stages = defaultPipeline()
    stages[2] = { ...stages[2], outputs: ['notes.md'] }
    stages.splice(2, 0, { ...custom('tests'), doneWhen: 'command', onFailure: { returnTo: 'review', maxLoops: 2 } })
    expect(validatePipeline(stages)).toEqual([
      'tests is done when a command passes, but has no command',
      'tests can only go back to an earlier stage',
      'Review reads a verdict, so it needs a .json output to write it in'
    ])
    expect(validatePipeline([...defaultPipeline().slice(0, 4), { ...defaultPipeline()[3], id: 'pr-2' }, defaultPipeline()[4]])).toEqual(['There can only be one Pull requests stage'])
    const backToPlan = defaultPipeline()
    backToPlan[2] = { ...backToPlan[2], onFailure: { returnTo: 'plan', maxLoops: 2 } }
    expect(validatePipeline(backToPlan)).toEqual(["Review can't go back to Plan"])
  })

  it('makes stages from templates with ids of their own, a Review going back to the nearest stage that changes files', () => {
    const stages = defaultPipeline()
    const build = stageFromTemplate('build', stages, 3)
    expect(build).toMatchObject({ id: 'build-2', name: 'Build', kind: 'build', outputs: ['build-notes.md'] })
    const withBuild = [...stages.slice(0, 3), build, ...stages.slice(3)]
    expect(stageFromTemplate('review', withBuild, 4)).toMatchObject({ id: 'review-2', onFailure: { returnTo: 'build-2', maxLoops: 2 }, access: 'read-only' })
    expect(stageFromTemplate('custom', stages, 1)).toMatchObject({ id: 'custom-1', name: 'New stage', goal: '', doneWhen: 'agent-finishes' })
    expect(stageFromTemplate('custom', [...stages, stageFromTemplate('custom', stages, 1)], 1).id).toBe('custom-2')
  })

  it('reads access and the verdict file from the fields', () => {
    const [plan, build, review] = defaultPipeline()
    expect([stageAccess(plan), stageAccess(build), stageAccess(review)]).toEqual(['read-only', 'changes', 'read-only'])
    expect(stageAccess({ ...review, access: 'changes' })).toBe('changes')
    expect([verdictFile(build), verdictFile(review), verdictFile({ ...build, doneWhen: 'verdict', outputs: ['notes.md', 'check.json'] })]).toEqual([null, 'review.json', 'check.json'])
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
