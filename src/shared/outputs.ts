/**
 * Readers and checks for the files each stage writes, as defined in the design doc's
 * "How Eregion checks the outputs" table. Each returns what it found plus a list of problems
 * in plain words; an empty list means valid.
 */

export interface PlanRepo {
  name: string
  changes: boolean
  why: string
}

export interface PlanQuestion {
  text: string
  answered: boolean
}

export interface ParsedPlan {
  title: string
  summary: string
  repos: PlanRepo[]
  steps: { repo: string | null; text: string }[]
  questions: PlanQuestion[]
  decisions: string[]
  doneWhen: string[]
  problems: string[]
}

const PLAN_HEADINGS = ['Affected repos', 'Steps', 'Open questions', 'Decided while planning', 'Done when']

/** Splits markdown into `## Heading` sections. Text before the first one goes under ''. */
export function sections(markdown: string): Map<string, string[]> {
  const result = new Map<string, string[]>([['', []]])
  let current = ''
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const heading = line.match(/^##\s+(.+?)\s*$/)
    if (heading) {
      current = heading[1]
      result.set(current, [])
    } else {
      result.get(current)?.push(line)
    }
  }
  return result
}

function bullets(lines: string[] | undefined): string[] {
  return (lines ?? []).map((line) => line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)$/)?.[1]?.trim()).filter((item): item is string => Boolean(item))
}

export function parsePlan(markdown: string, repoNames: string[]): ParsedPlan {
  const parts = sections(markdown)
  const problems: string[] = []
  for (const heading of PLAN_HEADINGS) {
    if (!parts.has(heading)) problems.push(`Missing the "## ${heading}" heading`)
  }
  const intro = parts.get('') ?? []
  const title = intro.find((line) => line.startsWith('# '))?.slice(2).trim() ?? ''
  const summary = intro.filter((line) => line.trim() && !line.startsWith('#')).join(' ').trim()

  const repos: PlanRepo[] = []
  for (const item of bullets(parts.get('Affected repos'))) {
    const match = item.match(/^`?([\w.-]+)`?\s*:\s*(changes|none)\b\s*(?:[·•\-–—:]\s*)?(.*)$/i)
    if (!match) {
      problems.push(`Can't read the repo line "${item}". Use "<repo>: changes · why" or "<repo>: none · why"`)
      continue
    }
    repos.push({ name: match[1], changes: match[2].toLowerCase() === 'changes', why: match[3].trim() })
  }
  if (parts.has('Affected repos')) {
    for (const name of repoNames) {
      const count = repos.filter((repo) => repo.name === name).length
      if (count === 0) problems.push(`${name} isn't listed under Affected repos`)
      if (count > 1) problems.push(`${name} is listed more than once under Affected repos`)
    }
    for (const repo of repos) {
      if (!repoNames.includes(repo.name)) problems.push(`"${repo.name}" isn't a repo in this project`)
    }
    if (repos.length > 0 && !repos.some((repo) => repo.changes)) problems.push('No repo is marked "changes"')
  }

  const changing = new Set(repos.filter((repo) => repo.changes).map((repo) => repo.name))
  const steps = bullets(parts.get('Steps')).map((item) => {
    const match = item.match(/^\[([\w.-]+)\]\s*(.*)$/)
    return match ? { repo: match[1], text: match[2] } : { repo: null, text: item }
  })
  for (const step of steps) {
    if (!step.repo) problems.push(`The step "${step.text}" doesn't name a repo in [brackets]`)
    else if (!changing.has(step.repo)) problems.push(`The step "${step.text}" is for ${step.repo}, which isn't marked "changes"`)
  }

  const questions: PlanQuestion[] = []
  for (const line of parts.get('Open questions') ?? []) {
    const match = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/)
    if (match) questions.push({ answered: match[1] !== ' ', text: match[2].trim() })
  }

  return {
    title,
    summary,
    repos,
    steps,
    questions,
    decisions: bullets(parts.get('Decided while planning')),
    doneWhen: bullets(parts.get('Done when')),
    problems
  }
}

/** Approval needs a valid plan with every question answered. */
export function planApprovalBlockers(plan: ParsedPlan): string[] {
  const open = plan.questions.filter((question) => !question.answered).length
  return [...plan.problems, ...(open > 0 ? [open === 1 ? '1 open question still needs an answer' : `${open} open questions still need an answer`] : [])]
}

export interface ParsedBuildNotes {
  summary: string
  blocked: string | null
  /** What followed "None" under Blocked: a caveat for the reviewer, not a blocker. */
  blockedNote: string | null
  problems: string[]
}

/** "None", "None.", "None. <a note>" or "Nothing — <a note>" mean not blocked; "None of the tests ran" does not. */
const NOT_BLOCKED = /^(none|nothing|n\/a|not blocked)(?:\s*$|\s*[.:;,!—–-]+\s*)/i

const BUILD_HEADINGS = ['Summary', 'Changes', 'Checks run', 'Decisions', 'Deviations from the plan', 'Blocked']

export function parseBuildNotes(markdown: string): ParsedBuildNotes {
  const parts = sections(markdown)
  const problems = BUILD_HEADINGS.filter((heading) => !parts.has(heading)).map((heading) => `Missing the "## ${heading}" heading`)
  const summary = (parts.get('Summary') ?? []).join('\n').trim()
  const blockedText = (parts.get('Blocked') ?? []).join('\n').trim().replace(/^[-*]\s+/, '')
  const notBlocked = blockedText.match(NOT_BLOCKED)
  const blocked = !parts.has('Blocked') || blockedText === '' || notBlocked ? null : blockedText
  const blockedNote = notBlocked ? blockedText.slice(notBlocked[0].length).trim() || null : null
  if (parts.has('Summary') && !summary) problems.push('The Summary is empty')
  return { summary, blocked, blockedNote, problems }
}

export type Severity = 'high' | 'medium' | 'low'

export interface ReviewIssue {
  id: string
  severity: Severity
  repo: string
  file: string
  line: number | null
  problem: string
  fix: string
}

export interface Review {
  loop: number
  verdict: 'pass' | 'fail'
  summary: string
  issues: ReviewIssue[]
}

function parseJson(text: string): { value: unknown; problem: string | null } {
  try {
    return { value: JSON.parse(text), problem: null }
  } catch (error) {
    return { value: null, problem: `It isn't valid JSON: ${(error as Error).message}` }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseReview(text: string, repoNames: string[]): { review: Review | null; problems: string[] } {
  const { value, problem } = parseJson(text)
  if (problem) return { review: null, problems: [problem] }
  const problems: string[] = []
  if (!isObject(value)) return { review: null, problems: ['It should be a JSON object'] }
  if (value.verdict !== 'pass' && value.verdict !== 'fail') problems.push('verdict must be "pass" or "fail"')
  if (typeof value.summary !== 'string') problems.push('summary must be text')
  if (!Array.isArray(value.issues)) problems.push('issues must be a list')
  const issues: ReviewIssue[] = []
  const ids = new Set<string>()
  for (const [index, raw] of (Array.isArray(value.issues) ? value.issues : []).entries()) {
    const where = `Issue ${index + 1}`
    if (!isObject(raw)) {
      problems.push(`${where} should be an object`)
      continue
    }
    if (typeof raw.id !== 'string' || !/^r\d+-\d+$/.test(raw.id)) problems.push(`${where}: id should look like r1-1`)
    else if (ids.has(raw.id)) problems.push(`${where}: the id ${raw.id} is used twice`)
    else ids.add(raw.id)
    if (!['high', 'medium', 'low'].includes(raw.severity as string)) problems.push(`${where}: severity must be high, medium or low`)
    if (typeof raw.repo !== 'string' || !repoNames.includes(raw.repo)) problems.push(`${where}: repo must be one of ${repoNames.join(', ')}`)
    if (typeof raw.problem !== 'string' || !raw.problem.trim()) problems.push(`${where}: problem is missing`)
    if (typeof raw.fix !== 'string' || !raw.fix.trim()) problems.push(`${where}: fix is missing`)
    if (raw.line !== null && raw.line !== undefined && typeof raw.line !== 'number') problems.push(`${where}: line must be a number or null`)
    issues.push({
      id: String(raw.id ?? ''),
      severity: raw.severity as Severity,
      repo: String(raw.repo ?? ''),
      file: typeof raw.file === 'string' ? raw.file : '',
      line: typeof raw.line === 'number' ? raw.line : null,
      problem: String(raw.problem ?? ''),
      fix: String(raw.fix ?? '')
    })
  }
  const blocking = issues.some((issue) => issue.severity === 'high' || issue.severity === 'medium')
  if (value.verdict === 'pass' && blocking) problems.push('The verdict is pass, but there is a high or medium issue')
  if (value.verdict === 'fail' && !blocking) problems.push('The verdict is fail, but no issue is high or medium')
  const review: Review = { loop: typeof value.loop === 'number' ? value.loop : 1, verdict: value.verdict === 'pass' ? 'pass' : 'fail', summary: String(value.summary ?? ''), issues }
  return { review: problems.length === 0 ? review : null, problems }
}

export interface Fix {
  issueId: string
  fixed: boolean
  files: string[]
  note: string
}

export function parseFixes(text: string, issueIds: string[]): { fixes: Fix[] | null; problems: string[] } {
  const { value, problem } = parseJson(text)
  if (problem) return { fixes: null, problems: [problem] }
  if (!isObject(value) || !Array.isArray(value.fixes)) return { fixes: null, problems: ['It should be an object with a "fixes" list'] }
  const problems: string[] = []
  const fixes: Fix[] = []
  for (const [index, raw] of value.fixes.entries()) {
    if (!isObject(raw)) {
      problems.push(`Entry ${index + 1} should be an object`)
      continue
    }
    const fix: Fix = {
      issueId: String(raw.issueId ?? ''),
      fixed: raw.fixed === true,
      files: Array.isArray(raw.files) ? raw.files.map(String) : [],
      note: typeof raw.note === 'string' ? raw.note : ''
    }
    if (typeof raw.fixed !== 'boolean') problems.push(`Entry ${index + 1}: fixed must be true or false`)
    if (!fix.fixed && !fix.note.trim()) problems.push(`${fix.issueId}: say why it wasn't fixed in note`)
    fixes.push(fix)
  }
  for (const id of issueIds) {
    const count = fixes.filter((fix) => fix.issueId === id).length
    if (count === 0) problems.push(`There's no entry for ${id}`)
    if (count > 1) problems.push(`${id} has more than one entry`)
  }
  for (const fix of fixes) {
    if (!issueIds.includes(fix.issueId)) problems.push(`${fix.issueId} isn't an issue in the review`)
  }
  return { fixes: problems.length === 0 ? fixes : null, problems }
}

export interface PrDescription {
  title: string
  body: string
}

export function parsePrDescription(markdown: string, ticketKey: string): { description: PrDescription | null; problems: string[] } {
  const lines = markdown.replace(/\r\n/g, '\n').trim().split('\n')
  const problems: string[] = []
  const title = lines[0]?.replace(/^#\s+/, '').trim() ?? ''
  if (!lines[0]?.startsWith('# ')) problems.push('The first line must be "# <title>"')
  if (!title.startsWith(ticketKey)) problems.push(`The title must start with ${ticketKey}`)
  if (title.length > 72) problems.push(`The title is ${title.length} characters; keep it under 72`)
  const parts = sections(markdown)
  for (const heading of ['Summary', 'Changes', 'How to test', 'Linked']) {
    if (!parts.has(heading)) problems.push(`Missing the "## ${heading}" heading`)
  }
  return { description: problems.length === 0 ? { title, body: lines.slice(1).join('\n').trim() } : null, problems }
}

export interface CiFix {
  pr: string
  check: string
  attempt: number
  result: 'fixed' | 'needs-you'
  cause: string
  files: string[]
  note: string
}

export function parseCiFix(text: string, expected: { pr: string; check: string; attempt: number }): { fix: CiFix | null; problems: string[] } {
  const { value, problem } = parseJson(text)
  if (problem) return { fix: null, problems: [problem] }
  if (!isObject(value)) return { fix: null, problems: ['It should be a JSON object'] }
  const problems: string[] = []
  if (value.result !== 'fixed' && value.result !== 'needs-you') problems.push('result must be "fixed" or "needs-you"')
  if (value.pr !== expected.pr) problems.push(`pr should be "${expected.pr}"`)
  if (value.check !== expected.check) problems.push(`check should be "${expected.check}"`)
  if (value.attempt !== expected.attempt) problems.push(`attempt should be ${expected.attempt}`)
  if (typeof value.cause !== 'string' || !value.cause.trim()) problems.push('cause is missing')
  const files = Array.isArray(value.files) ? value.files.map(String) : []
  if (value.result === 'fixed' && files.length === 0) problems.push('A fix must list the files it changed')
  if (value.result === 'needs-you' && files.length > 0) problems.push('needs-you must not list changed files')
  const fix: CiFix = { pr: String(value.pr), check: String(value.check), attempt: Number(value.attempt), result: value.result === 'fixed' ? 'fixed' : 'needs-you', cause: String(value.cause ?? ''), files, note: String(value.note ?? '') }
  return { fix: problems.length === 0 ? fix : null, problems }
}
