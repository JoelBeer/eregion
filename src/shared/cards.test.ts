import { describe, expect, it } from 'vitest'
import { ticketCard, type CardInputs } from './cards'
import { defaultPipeline, stageFromTemplate } from './pipeline'
import type { Ticket } from './tickets'

const base: Ticket = {
  id: 1,
  projectId: 1,
  linearId: null,
  key: 'WM-1',
  title: 'Hints',
  url: null,
  description: '',
  linear: {},
  pipelineVersion: 1,
  stage: 'build',
  status: 'running',
  stopReason: null,
  stopDetail: null,
  waitingFor: null,
  loop: 1,
  loops: {},
  returnedFrom: null,
  slot: 1,
  branch: 'wm-1-hints',
  affectedRepos: ['app'],
  currentRunId: 3,
  planApprovedAt: null,
  createdAt: '',
  updatedAt: ''
}

function card(ticket: Partial<Ticket>, extra: Partial<CardInputs> = {}) {
  return ticketCard({ ticket: { ...base, ...ticket }, stages: defaultPipeline(), crewId: 2, environment: undefined, lastAgentText: null, openQuestions: 0, prLinks: [], ...extra })
}

describe('ticketCard', () => {
  it("uses the agent's first sentence while it works", () => {
    expect(card({}, { lastAgentText: '2 tests failing. Fixing the UTC offset now.' })).toMatchObject({ pill: { status: 'running', label: 'Running' }, mood: 'working', bubble: '2 tests failing.' })
  })

  it('counts open plan questions', () => {
    expect(card({ stage: 'plan', status: 'needs_you', waitingFor: 'answers' }, { openQuestions: 3 }).bubble).toBe('3 questions waiting for you.')
  })

  it('shows the stop reason with the first sentence of its detail', () => {
    expect(card({ status: 'needs_you', stopReason: 'blocked', stopDetail: "web needs a change the plan doesn't include. More detail." })).toMatchObject({
      pill: { status: 'needsYou', label: 'Blocked' },
      mood: 'stuck',
      bubble: "Blocked: web needs a change the plan doesn't include."
    })
    expect(card({ stage: 'review', status: 'needs_you', stopReason: 'loop_limit', loops: { review: { failures: 2, extra: 0 } }, returnedFrom: 'review' }).bubble).toBe('Review failed 2 times. Your call: one more loop, or back to Plan.')
    expect(card({ status: 'needs_you', stopReason: 'setup_failed', stopDetail: 'A setup step failed' }).pill).toEqual({ status: 'failed', label: 'Setup failed' })
  })

  it('tags a Build that came back from review', () => {
    expect(card({ loops: { review: { failures: 1, extra: 0 } }, returnedFrom: 'review', loop: 2 }).tags).toEqual(['Back from review · loop 1 of 2'])
    expect(card({ loop: 2 }).tags).toEqual(['Build · pass 2'])
  })

  it('tags whichever stage a custom verdict stage sent the work back to, counting its own loops', () => {
    const check = { ...stageFromTemplate('review', defaultPipeline(), 3), id: 'security', name: 'Security check', onFailure: { returnTo: 'build', maxLoops: 3 } }
    const stages = [...defaultPipeline().slice(0, 3), check, ...defaultPipeline().slice(3)]
    expect(card({ loops: { security: { failures: 2, extra: 1 } }, returnedFrom: 'security', loop: 3 }, { stages }).tags).toEqual(['Back from security check · loop 2 of 4'])
  })

  it('says it is your turn after the AI review passes', () => {
    expect(card({ stage: 'review', status: 'needs_you', waitingFor: 'manual-review' })).toMatchObject({ pill: { label: 'Your turn' }, bubble: 'Review passed. Your turn to click around.' })
  })

  it('shows the setup step that is running, and an Open app link once ready', () => {
    const environment = {
      key: 'ticket:1',
      projectId: 1,
      ticketKey: 'WM-1',
      slot: 1,
      phase: 'setting-up' as const,
      error: null,
      values: {},
      repos: [{ repoId: 1, name: 'app', path: '/w', branch: 'b', steps: [{ label: 'php artisan migrate --seed --force', status: 'running' as const, output: '' }], teardown: [] }],
      services: []
    }
    expect(card({}, { environment }).bubble).toBe('Running: php artisan migrate --seed --force')
    const ready = { ...environment, phase: 'ready' as const, services: [{ repoName: 'app', name: 'app', state: 'ready' as const, openUrl: 'http://localhost:8101', log: [] }] }
    expect(card({}, { environment: ready }).openUrl).toBe('http://localhost:8101')
  })

  it('shows backlog tickets plainly and done tickets as shipped', () => {
    expect(card({ stage: 'backlog', status: 'idle' })).toMatchObject({ pill: null, bubble: null, mood: 'idle' })
    expect(card({ stage: 'done', status: 'done' })).toMatchObject({ mood: 'shipped', bubble: 'Merged. Environment torn down.' })
  })
})

describe('ticketCard in Watch CI and from Linear', () => {
  const check = (bucket: 'pass' | 'fail' | 'pending') => ({ name: 'tests', workflow: 'CI', bucket, link: '' })
  const ci = { stage: 'ci', status: 'idle' as const, currentRunId: null }

  it('watches checks without a running agent', () => {
    expect(card(ci, { prs: [{ state: 'open', checks: [check('pass'), check('pending')], autofix: true, autofixPausedReason: null }] })).toMatchObject({
      pill: { status: 'waiting', label: 'Watching CI' },
      bubble: '1 of 2 checks done.'
    })
    expect(card(ci, { prs: [{ state: 'open', checks: [check('pass')], autofix: true, autofixPausedReason: null }] }).bubble).toBe('All checks green. Waiting for the merge.')
  })

  it('shows failing checks and when autofix is off', () => {
    expect(card(ci, { prs: [{ state: 'open', checks: [check('fail')], autofix: false, autofixPausedReason: null }] })).toMatchObject({
      pill: { status: 'fixing', label: 'Checks failing' },
      bubble: '1 check failing.',
      tags: ['Autofix off']
    })
  })

  it('tags new imports and issues reassigned in Linear', () => {
    expect(card({ stage: 'backlog', status: 'idle', linear: { isNew: true } }).tags).toEqual(['New'])
    expect(card({ linear: { reassigned: true } }).tags).toEqual(['Reassigned in Linear'])
  })
})
