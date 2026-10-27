import { describe, expect, it } from 'vitest'
import { commitPrompt, conventionalSubject, CONVENTIONAL_TYPES, EREGION_RULES, rulesFromCommitlint, subjectProblems } from './commits'
import { parseBuildNotes, parsePrDescription } from './outputs'

// The web-app repo's config: config-conventional with its own types and a ticket scope.
const WEB_APP = `module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [2, 'always', ['chore', 'ci', 'docs', 'feat', 'fix', 'refactor', 'revert', 'test']],
    'custom-rule/scope': [2, 'always'],
  },
}`

const rules = { conventional: true, types: ['feat', 'fix', 'test'], source: 'commitlint.config.js' }

describe('rulesFromCommitlint', () => {
  it("reads a config's types, or config-conventional's when it lists none", () => {
    expect(rulesFromCommitlint(WEB_APP, 'commitlint.config.js')).toEqual({ conventional: true, types: ['chore', 'ci', 'docs', 'feat', 'fix', 'refactor', 'revert', 'test'], source: 'commitlint.config.js' })
    expect(rulesFromCommitlint('{ "extends": ["@commitlint/config-conventional"] }', '.commitlintrc.json')?.types).toEqual(CONVENTIONAL_TYPES)
    expect(rulesFromCommitlint(JSON.stringify({ name: 'app', commitlint: { extends: ['@commitlint/config-conventional'] } }), 'package.json')?.source).toBe('package.json')
  })

  it("ignores configs that aren't conventional, and package.json without commitlint", () => {
    expect(rulesFromCommitlint("module.exports = { rules: { 'header-max-length': [2, 'always', 72] } }", 'commitlint.config.js')).toBeNull()
    expect(rulesFromCommitlint('{ "name": "app" }', 'package.json')).toBeNull()
  })
})

describe('subjectProblems', () => {
  it('passes a subject commitlint would accept', () => {
    expect(subjectProblems('feat(PP-357): show documents for a case file', rules, 'PP-357')).toEqual([])
    expect(subjectProblems('anything goes', EREGION_RULES, 'PP-357')).toEqual([])
  })

  it('says what commitlint would reject', () => {
    expect(subjectProblems('PP-357: Show documents', rules, 'PP-357')).toEqual(['it must look like "<type>(PP-357): <summary>"'])
    expect(subjectProblems('perf(PP-12): Show documents.', rules, 'PP-357')).toEqual(['"perf" isn\'t one of feat, fix, test', 'the scope must be PP-357', 'the summary must start in lowercase', "the summary mustn't end with a full stop"])
    expect(subjectProblems(`feat(PP-357): ${'a'.repeat(90)}`, rules, 'PP-357')).toEqual(["it's 104 characters; keep it to 100"])
  })
})

describe('conventionalSubject', () => {
  it('writes a subject that passes: lowercase, no full stop, cut to fit', () => {
    expect(conventionalSubject('fix', 'PP-357', 'Fix Tests / Unit:Misc (ci attempt 1).')).toBe('fix(PP-357): fix Tests / Unit:Misc (ci attempt 1)')
    const long = conventionalSubject('chore', 'PP-357', 'x'.repeat(200))
    expect(long).toHaveLength(100)
    expect(subjectProblems(long, { ...rules, types: ['chore'] }, 'PP-357')).toEqual([])
  })
})

describe('commit subjects from the builder and the PR stage', () => {
  it("reads build-notes.md's Commit section", () => {
    const notes = parseBuildNotes('## Summary\nDid it.\n## Changes\n## Checks run\n## Decisions\n## Deviations from the plan\n## Blocked\nNone\n## Commit\n- web-app: feat(PP-357): show documents\n- `api`: `fix(PP-357): keep the old shape`\n')
    expect(notes.commits).toEqual({ 'web-app': 'feat(PP-357): show documents', api: 'fix(PP-357): keep the old shape' })
  })

  it("checks a repo's PR title like a commit message", () => {
    const body = '\n\n## Summary\ns\n## Changes\n- c\n## How to test\n- t\n## Linked\n- l'
    const check = (title: string): string[] => subjectProblems(title, rules, 'PP-357')
    expect(parsePrDescription(`# feat(PP-357): show documents${body}`, 'PP-357', check).problems).toEqual([])
    expect(parsePrDescription(`# PP-357: Show documents${body}`, 'PP-357', check).problems).toEqual(['The title: it must look like "<type>(PP-357): <summary>"'])
    expect(parsePrDescription(`# PP-357: Show documents${body}`, 'PP-357').problems).toEqual([])
  })

  it('tells the builder each checked repo and its types', () => {
    expect(commitPrompt([{ name: 'web-app', rules }], 'PP-357')).toContain('- web-app: "<type>(PP-357): <summary>", where type is one of feat, fix, test')
  })
})
