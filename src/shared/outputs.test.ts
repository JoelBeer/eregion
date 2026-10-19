import { describe, expect, it } from 'vitest'
import { parseBuildNotes, parseCiFix, parseFixes, parsePlan, parsePrDescription, parseReview, planApprovalBlockers } from './outputs'

const PLAN = `# WM-12 · Hints after two wrong tries

Children see a hint after two wrong attempts at a word.

## Affected repos
- word-magic: changes · new hint logic and UI

## Steps
1. [word-magic] Add a hint column to spellings
2. [word-magic] Feature test: hint shows after two misses

## Open questions
- [x] Should hints show the first letter?
- [ ] Can teachers turn hints off?

## Decided while planning
- Hints show the first letter

## Done when
- After two wrong tries the first letter appears
`

describe('parsePlan', () => {
  it('reads every section of a valid plan', () => {
    const plan = parsePlan(PLAN, ['word-magic'])
    expect(plan.problems).toEqual([])
    expect(plan.title).toBe('WM-12 · Hints after two wrong tries')
    expect(plan.summary).toBe('Children see a hint after two wrong attempts at a word.')
    expect(plan.repos).toEqual([{ name: 'word-magic', changes: true, why: 'new hint logic and UI' }])
    expect(plan.steps).toEqual([
      { repo: 'word-magic', text: 'Add a hint column to spellings' },
      { repo: 'word-magic', text: 'Feature test: hint shows after two misses' }
    ])
    expect(plan.questions).toEqual([
      { text: 'Should hints show the first letter?', answered: true },
      { text: 'Can teachers turn hints off?', answered: false }
    ])
    expect(plan.doneWhen).toEqual(['After two wrong tries the first letter appears'])
  })

  it('blocks approval while a question is open, and passes once answered', () => {
    expect(planApprovalBlockers(parsePlan(PLAN, ['word-magic']))).toEqual(['1 open question still needs an answer'])
    expect(planApprovalBlockers(parsePlan(PLAN.replace('- [ ] Can', '- [x] Can'), ['word-magic']))).toEqual([])
  })

  it('reports missing headings, unknown and missing repos, and steps for unchanged repos', () => {
    const plan = parsePlan('# X\n\n## Affected repos\n- api: changes · x\n- other: none · y\n\n## Steps\n1. [web] Do it\n2. No repo here\n', ['api', 'web'])
    expect(plan.problems).toEqual([
      'Missing the "## Open questions" heading',
      'Missing the "## Decided while planning" heading',
      'Missing the "## Done when" heading',
      "web isn't listed under Affected repos",
      '"other" isn\'t a repo in this project',
      'The step "Do it" is for web, which isn\'t marked "changes"',
      'The step "No repo here" doesn\'t name a repo in [brackets]'
    ])
  })

  it('needs at least one repo to change', () => {
    expect(parsePlan(PLAN.replace('word-magic: changes', 'word-magic: none').replace(/\[word-magic\] /g, '[word-magic] '), ['word-magic']).problems).toContain('No repo is marked "changes"')
  })
})

describe('parseBuildNotes', () => {
  const notes = (blocked: string) =>
    `# Build notes · WM-12 · pass 1\n\n## Summary\nAdded hints.\n\n## Changes\n### word-magic\n- app/x.php: hint\n\n## Checks run\n- php artisan test: passed\n\n## Decisions\n- None\n\n## Deviations from the plan\n- None\n\n## Blocked\n${blocked}\n`

  it('reads the summary and treats None as not blocked', () => {
    expect(parseBuildNotes(notes('None'))).toEqual({ summary: 'Added hints.', blocked: null, problems: [] })
  })

  it('returns the Blocked text when the build stopped', () => {
    expect(parseBuildNotes(notes('web needs a change the plan marks as none.')).blocked).toBe('web needs a change the plan marks as none.')
  })

  it('reports missing headings', () => {
    expect(parseBuildNotes('## Summary\nx\n').problems).toContain('Missing the "## Blocked" heading')
  })
})

describe('parseReview', () => {
  const issue = { id: 'r1-1', severity: 'high', repo: 'api', file: 'a.php', line: 48, problem: 'No auth check.', fix: 'Authorise first.' }

  it('accepts a consistent review', () => {
    const { review, problems } = parseReview(JSON.stringify({ loop: 1, verdict: 'fail', summary: 'Needs auth.', issues: [issue] }), ['api', 'web'])
    expect(problems).toEqual([])
    expect(review?.issues[0]).toMatchObject({ id: 'r1-1', severity: 'high', line: 48 })
  })

  it('rejects a verdict that contradicts the severities', () => {
    expect(parseReview(JSON.stringify({ verdict: 'pass', summary: 's', issues: [issue] }), ['api']).problems).toEqual(['The verdict is pass, but there is a high or medium issue'])
    expect(parseReview(JSON.stringify({ verdict: 'fail', summary: 's', issues: [{ ...issue, severity: 'low' }] }), ['api']).problems).toEqual(['The verdict is fail, but no issue is high or medium'])
  })

  it('reports bad JSON, duplicate ids and unknown repos', () => {
    expect(parseReview('{nope', ['api']).problems[0]).toContain("isn't valid JSON")
    const { problems } = parseReview(JSON.stringify({ verdict: 'fail', summary: 's', issues: [issue, { ...issue, repo: 'mobile' }] }), ['api'])
    expect(problems).toEqual(['Issue 2: the id r1-1 is used twice', 'Issue 2: repo must be one of api'])
  })
})

describe('parseFixes', () => {
  it('needs exactly one entry per review issue, with a note when not fixed', () => {
    const good = JSON.stringify({ loop: 2, fixes: [{ issueId: 'r1-1', fixed: true, files: ['api/a.php'], note: '' }, { issueId: 'r1-2', fixed: false, files: [], note: 'Covered elsewhere.' }] })
    expect(parseFixes(good, ['r1-1', 'r1-2']).problems).toEqual([])
    const bad = JSON.stringify({ fixes: [{ issueId: 'r1-1', fixed: false, files: [] }, { issueId: 'r9-9', fixed: true, files: [] }] })
    expect(parseFixes(bad, ['r1-1', 'r1-2']).problems).toEqual(["r1-1: say why it wasn't fixed in note", "There's no entry for r1-2", "r9-9 isn't an issue in the review"])
  })
})

describe('parsePrDescription', () => {
  it('splits the title from the body and checks the format', () => {
    const md = '# WM-12: Hints after two wrong tries\n\n## Summary\nx\n\n## Changes\n- y\n\n## How to test\n- z\n\n## Linked\n- Linear: u\n'
    expect(parsePrDescription(md, 'WM-12').description?.title).toBe('WM-12: Hints after two wrong tries')
    expect(parsePrDescription(md.replace('WM-12:', 'Hints:'), 'WM-12').problems).toContain('The title must start with WM-12')
  })
})

describe('parseCiFix', () => {
  const expected = { pr: 'word-magic #4', check: 'tests', attempt: 1 }
  it('checks the result against the run it belongs to', () => {
    const fixed = JSON.stringify({ ...expected, result: 'fixed', cause: 'A typo.', files: ['word-magic/app/x.php'], note: '' })
    expect(parseCiFix(fixed, expected).problems).toEqual([])
    const wrong = JSON.stringify({ ...expected, attempt: 2, result: 'fixed', cause: 'x', files: [] })
    expect(parseCiFix(wrong, expected).problems).toEqual(['attempt should be 1', 'A fix must list the files it changed'])
  })
})
