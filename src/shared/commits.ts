/**
 * How a repo wants its commit messages (and its PR titles, which tools like Danger lint the same way): Eregion's
 * own "PP-357: <title> (build pass 1)", or conventional commits, "<type>(PP-357): <summary>", as a repo's
 * commitlint config asks. Eregion writes and checks them, so a commit-msg hook or a CI lint never rejects its work.
 */

/** What a repo is set to: follow its commitlint config (the default), or a style chosen here. */
export type CommitStyle = 'detect' | 'eregion' | 'conventional'

/** The style a repo's commits follow, once its setting and its commitlint config are worked out. */
export interface CommitRules {
  conventional: boolean
  /** The types a conventional subject may start with. */
  types: string[]
  /** Where the rules came from, for the screens: "commitlint.config.js", or "this repo's setting". */
  source: string
}

/** @commitlint/config-conventional's types, when a config extends it without listing its own. */
export const CONVENTIONAL_TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test']

/** config-conventional's limit on the whole first line. */
export const MAX_SUBJECT = 100

/** Files commitlint reads its config from, in the order it looks. package.json counts when it has a "commitlint" key. */
export const COMMITLINT_FILES = [
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yaml',
  '.commitlintrc.yml',
  '.commitlintrc.js',
  '.commitlintrc.cjs',
  '.commitlintrc.mjs',
  '.commitlintrc.ts',
  'commitlint.config.js',
  'commitlint.config.cjs',
  'commitlint.config.mjs',
  'commitlint.config.ts',
  'package.json'
]

/**
 * Reads a commitlint config's text: conventional when it extends config-conventional or sets type-enum, with the
 * types from type-enum when it lists them. Null when the text isn't a conventional commitlint config.
 */
export function rulesFromCommitlint(text: string, file: string): CommitRules | null {
  if (file === 'package.json') {
    try {
      const config = (JSON.parse(text) as { commitlint?: unknown }).commitlint
      if (!config) return null
      text = JSON.stringify(config)
    } catch {
      return null
    }
  }
  const enumMatch = text.match(/["']?type-enum["']?\s*:\s*\[\s*2\s*,\s*["']always["']\s*,\s*\[([^\]]*)\]/)
  const types = enumMatch ? [...enumMatch[1].matchAll(/["']([\w-]+)["']/g)].map((match) => match[1]) : []
  if (!/config-conventional/.test(text) && types.length === 0) return null
  return { conventional: true, types: types.length ? types : CONVENTIONAL_TYPES, source: file }
}

export const EREGION_RULES: CommitRules = { conventional: false, types: [], source: "Eregion's own" }

/** What's wrong with a conventional subject for this ticket: the checks commitlint's conventional preset makes. */
export function subjectProblems(subject: string, rules: CommitRules, ticketKey: string): string[] {
  if (!rules.conventional) return []
  const problems: string[] = []
  if (subject.includes('\n')) problems.push('it must be one line')
  const match = subject.match(/^([a-z]+)\(([^)]+)\)(!)?: (.*)$/)
  if (!match) return [...problems, `it must look like "<type>(${ticketKey}): <summary>"`]
  const [, type, scope, , summary] = match
  if (!rules.types.includes(type)) problems.push(`"${type}" isn't one of ${rules.types.join(', ')}`)
  if (scope !== ticketKey) problems.push(`the scope must be ${ticketKey}`)
  if (!summary.trim()) problems.push('the summary is empty')
  else if (/^[A-Z]/.test(summary)) problems.push('the summary must start in lowercase')
  if (/\.\s*$/.test(summary)) problems.push("the summary mustn't end with a full stop")
  if (subject.length > MAX_SUBJECT) problems.push(`it's ${subject.length} characters; keep it to ${MAX_SUBJECT}`)
  return problems
}

/** A conventional subject Eregion writes itself (a CI fix, say): lowercase, no full stop, cut to fit. */
export function conventionalSubject(type: string, ticketKey: string, summary: string): string {
  const prefix = `${type}(${ticketKey}): `
  let text = summary.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '')
  text = text.charAt(0).toLowerCase() + text.slice(1)
  if (prefix.length + text.length > MAX_SUBJECT) text = text.slice(0, MAX_SUBJECT - prefix.length).trimEnd()
  return `${prefix}${text}`
}

/** What the builder is told about the repos whose commits are checked. */
export function commitPrompt(repos: { name: string; rules: CommitRules }[], ticketKey: string): string {
  const lines = repos.map(({ name, rules }) => `- ${name}: "<type>(${ticketKey}): <summary>", where type is one of ${rules.types.join(', ')}`)
  return `Commit messages. Eregion commits your work when you finish, and these repos check every commit message (a commit hook, and CI on the pull request):
${lines.join('\n')}
For each of them that you changed, add a "## Commit" section to build-notes.md with one line per repo, giving the subject of this pass's commit:
- <repo>: <type>(${ticketKey}): <summary>
The summary is an imperative, lowercase phrase saying what this pass changed, such as "show the hint after two wrong guesses" or "cover the empty state in the hint test", with no full stop. Pick the type for this pass's change (fix review issues with fix or test, for example). The whole line is at most ${MAX_SUBJECT} characters.`
}

/** What the PR stage is told about the repos whose PR titles are checked the same way. */
export function prTitlePrompt(repos: { name: string; rules: CommitRules }[], ticketKey: string): string {
  const lines = repos.map(({ name, rules }) => `- pr-${name}.md: "# <type>(${ticketKey}): <summary>", where type is one of ${rules.types.join(', ')}`)
  return `PR titles. These repos check the pull request title like a commit message, so the first line of their description is:
${lines.join('\n')}
The summary is an imperative, lowercase phrase for the whole change, with no full stop; the title is at most ${MAX_SUBJECT} characters. Use feat for new behaviour and fix for a bug fix.`
}
