import { describe, expect, it } from 'vitest'
import { BUILD_PROMPT, CI_FIX_PROMPT, composePrompt, FORMATS, PLAN_PROMPT, PR_PROMPT, REVIEW_PROMPT } from './prompts'
import { fromRecord, render } from './template'

const values = {
  'crew.name': 'Rivet',
  'user.name': 'Joel',
  'ticket.key': 'WM-12',
  'ticket.title': 'Add hints',
  'ticket.url': 'https://linear.app/x/issue/WM-12',
  'ticket.description': 'Show a hint after two wrong tries.',
  'project.name': 'Word Magic',
  'workspace.repos': '- word-magic: /w/word-magic (changes)',
  'outputs.dir': '/o/WM-12',
  'outputs.plan': '# plan',
  'outputs.build_notes': '# notes',
  'outputs.review': '{}',
  loop: '1',
  branch: 'wm-12-add-hints',
  'base.ref': 'origin/master',
  'env.summary': 'app on http://localhost:8101',
  'ci.attempt': '1',
  'ci.max_attempts': '3',
  'ci.pr': 'word-magic #4',
  'ci.repo': 'word-magic',
  'ci.check': 'tests',
  'ci.log': 'FAILED'
}

describe('stage prompts', () => {
  it('fill every placeholder for each stage, with formats inlined and house rules last', () => {
    for (const stage of [PLAN_PROMPT, BUILD_PROMPT, REVIEW_PROMPT, PR_PROMPT, CI_FIX_PROMPT]) {
      const text = composePrompt(stage, 'Use Pest for tests.')
      const rendered = render(text, fromRecord(values))
      expect(rendered.missing).toEqual([])
      expect(rendered.text).not.toContain('{{')
      expect(rendered.text.endsWith('House rules:\nUse Pest for tests.')).toBe(true)
      expect(rendered.text.startsWith('You are Rivet, one of the agents in Eregion')).toBe(true)
    }
  })

  it('drops the re-review and fix sections on the first pass', () => {
    const first = render(composePrompt(BUILD_PROMPT, ''), fromRecord(values)).text
    expect(first).not.toContain('The last review failed')
    expect(first).not.toContain('fixes.json')
    const second = render(composePrompt(BUILD_PROMPT, ''), fromRecord({ ...values, 'review.previous': '{"issues":[]}', loop: '2' })).text
    expect(second).toContain('The last review failed')
    expect(second).toContain('/o/WM-12/fixes.json')
    expect(second).toContain('Build, pass 2')
  })

  it('puts the ticket key into the plan template heading', () => {
    expect(render(FORMATS.plan, fromRecord(values)).text.split('\n')[0]).toBe('# WM-12 · Add hints')
  })
})
