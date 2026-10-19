import { describe, expect, it } from 'vitest'
import { ticketCard, type CardInputs } from './cards'
import { defaultPipeline } from './pipeline'
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
  reviewFailures: 0,
  extraLoops: 0,
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
    expect(card({ stage: 'review', status: 'needs_you', stopReason: 'loop_limit', reviewFailures: 2 }).bubble).toBe('Review failed 2 times. Your call: one more loop, or back to Plan.')
    expect(card({ status: 'needs_you', stopReason: 'setup_failed', stopDetail: 'A setup step failed' }).pill).toEqual({ status: 'failed', label: 'Setup failed' })
  })

  it('tags a Build that came back from review', () => {
    expect(card({ reviewFailures: 1, loop: 2 }).tags).toEqual(['Back from review · loop 1 of 2'])
    expect(card({ loop: 2 }).tags).toEqual(['Build · pass 2'])
  })

  it('says it is your turn after the AI review passes', () => {
    expect(card({ stage: 'review', status: 'needs_you', waitingFor: 'manual-review' })).toMatchObject({ pill: { label: 'Your turn' }, bubble: 'AI review passed. Your turn to click around.' })
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
