import { describe, expect, it } from 'vitest'
import { defaultPipeline } from '@shared/pipeline'
import { openDatabase } from '../db'
import { ProjectStore } from '../projects/store'
import { PipelineStore, TicketStore } from './stores'

describe('pipeline versions', () => {
  it('lists versions with their tickets, and restores a version or one stage as a new version', () => {
    const db = openDatabase(':memory:')
    const project = new ProjectStore(db).create('Word Magic')
    const pipelines = new PipelineStore(db)
    const first = pipelines.latest(project.id)
    const edited = defaultPipeline()
    edited[1] = { ...edited[1], name: 'Make', goal: 'Build it differently' }
    edited[2] = { ...edited[2], onFailure: { returnTo: 'build', maxLoops: 4 } }
    pipelines.save(project.id, edited)
    const tickets = new TicketStore(db)
    const ticket = tickets.create({ projectId: project.id, key: 'WM-1', title: 'T' })
    tickets.update(ticket.id, { pipelineVersion: first.version, stage: 'build' })

    expect(pipelines.versions(project.id).map((item) => [item.version, item.tickets, item.stageNames[1]])).toEqual([
      [2, 0, 'Make'],
      [1, 1, 'Build']
    ])

    const stage = pipelines.restoreStage(project.id, 1, 'build')
    expect(stage.version).toBe(3)
    expect(stage.stages[1].name).toBe('Build')
    expect(stage.stages[2].onFailure?.maxLoops).toBe(4)

    const whole = pipelines.restore(project.id, 1)
    expect(whole.version).toBe(4)
    expect(whole.stages).toEqual(first.stages)
    expect(() => pipelines.restore(project.id, 99)).toThrow("There's no version 99")
  })
})
