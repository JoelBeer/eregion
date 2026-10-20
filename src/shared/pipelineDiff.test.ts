import { describe, expect, it } from 'vitest'
import { defaultPipeline, type StageConfig } from './pipeline'
import { diffLines, diffPipelines } from './pipelineDiff'

describe('diffLines', () => {
  it('marks added and removed lines around the shared ones', () => {
    expect(diffLines('a\nb\nc', 'a\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'removed', text: 'b' },
      { kind: 'same', text: 'c' },
      { kind: 'added', text: 'd' }
    ])
  })
})

describe('diffPipelines', () => {
  it('says what restoring an older version would change', () => {
    const older = defaultPipeline()
    const custom: StageConfig = { ...older[1], id: 'docs', name: 'Docs', kind: 'custom', goal: 'Write docs' }
    const now = defaultPipeline()
    now[1] = { ...now[1], goal: `${now[1].goal}\nRun pint.`, after: [{ type: 'commit' }] }
    now.splice(3, 0, custom)
    const changes = diffPipelines(now, older)
    const build = changes.find((change) => change.stageId === 'build')
    expect(build?.change).toBe('changed')
    expect(build?.fields).toEqual([{ label: 'Afterwards', now: 'commit', then: 'commit, push' }])
    expect(build?.prompt?.filter((line) => line.kind !== 'same')).toEqual([{ kind: 'removed', text: 'Run pint.' }])
    expect(changes.find((change) => change.stageId === 'docs')?.change).toBe('removed')
    expect(changes.find((change) => change.stageId === 'plan')?.change).toBe('same')
  })
})
