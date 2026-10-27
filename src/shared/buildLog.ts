import { toolKind } from './conversation'
import type { AgentEvent } from './agent'
import type { Review } from './outputs'
import type { RunSummary } from './runs'

/** Lines of a tool's output the log keeps; the rest is counted. */
export const OUTPUT_LINES = 12

export interface BuildLogRun {
  run: RunSummary
  /** The stage's name in the ticket's pipeline, such as Build or Review. */
  stageName: string
  events: AgentEvent[]
}

export interface BuildLogInput {
  ticket: { key: string; title: string; branch: string | null }
  /** The runs from Build up to and including the PR run, oldest first. */
  runs: BuildLogRun[]
  /** Each verdict stage's verdicts, oldest pass first. */
  verdicts: { stageName: string; reviews: Review[] }[]
  /** The approved spec, when the ticket has one. */
  spec?: string | null
  buildNotes: string | null
  writtenAt: Date
  /** Folders shown shorter, such as the ticket's workspace as nothing (paths read from the repo) and its outputs folder as outputs/. */
  folders?: Record<string, string>
}

const SECRET_NAME = '[A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?)[A-Za-z0-9_.-]*'

/**
 * Takes secrets and personal details out of text that leaves the machine: known token shapes, values
 * given to secret-looking names, passwords in URLs, private keys, email addresses (numbered, so the
 * same address reads the same throughout) and home folder paths.
 */
export class Redactor {
  private readonly emails = new Map<string, string>()

  constructor(private readonly folders: Record<string, string> = {}) {}

  redact(text: string): string {
    // Longest first, so a folder inside another is matched before it.
    for (const [folder, label] of Object.entries(this.folders).sort((a, b) => b[0].length - a[0].length)) {
      text = text.split(`${folder.replace(/\/+$/, '')}/`).join(label)
    }
    return text
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]')
      .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|lin_(?:api|oauth)_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g, '[secret]')
      .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[secret]')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 [secret]')
      .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[secret]@')
      .replace(new RegExp(`(\\b${SECRET_NAME}\\b["']?\\s*[:=]\\s*)(["']?)[^\\s"',;]{4,}\\2`, 'gi'), '$1$2[secret]$2')
      .replace(/(^|[\s'"`=:(])\/(?:Users|home)\/[^/\s'"`]+/g, '$1~')
      .replace(/(^|[^\w.%+-])([\w.%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_match, before: string, email: string) => {
        if (!this.emails.has(email.toLowerCase())) this.emails.set(email.toLowerCase(), `[email-${this.emails.size + 1}]`)
        return `${before}${this.emails.get(email.toLowerCase())}`
      })
  }
}

/** Commands whose output may hold secrets or live data: the log says it ran but leaves out what it printed. */
export function withholdsOutput(summary: string): boolean {
  return /(^|[\s/$`(|;&])(env|printenv)(\s|$)|\.env\b|secrets?\b|credentials?\b|\bpasswords?\b|\btokens?\b|gh auth|aws (ssm|secretsmanager|sts)|vault (read|kv)|op (read|item)|kubectl get secrets?|security find-|\b(mysql|psql|sqlite3|redis-cli|mongosh?)\b/i.test(summary)
}

/** The first lines of a tool's output in a fence, with a count of the lines left out. */
function clipped(output: string): string[] {
  const lines = output.replace(/\s+$/, '').split('\n')
  const shown = lines.slice(0, OUTPUT_LINES)
  const fence = shown.some((line) => line.includes('```')) ? '````' : '```'
  const block = ['', `    ${fence}`, ...shown.map((line) => (line ? `    ${line}` : '')), `    ${fence}`]
  if (lines.length > OUTPUT_LINES) block.push(`    _... ${lines.length - OUTPUT_LINES} more lines_`)
  return block
}

/** A UTC time as the log shows it: 2026-10-20 09:41 UTC. Run times come from SQLite, already in UTC. */
function utc(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`) : value
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** One line of inline code, safe whatever backticks the text holds. */
function code(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const short = flat.length > 300 ? `${flat.slice(0, 299).trimEnd()} ...` : flat
  return short.includes('`') ? `\`\` ${short} \`\`` : `\`${short}\``
}

function runHeading(item: BuildLogRun, all: BuildLogRun[]): string {
  const passes = all.filter((other) => other.run.stage === item.run.stage)
  const pass = passes.length > 1 ? `, pass ${passes.indexOf(item) + 1}` : ''
  return `## ${item.stageName}${pass}`
}

function renderRun(item: BuildLogRun, all: BuildLogRun[], redactor: Redactor): string[] {
  const results = new Map<string, { ok: boolean; output: string }>()
  for (const event of item.events) if (event.kind === 'tool-result') results.set(event.id, { ok: event.ok, output: event.output })
  const lines = [runHeading(item, all), '', `_${item.run.adapter}/${item.run.model} · started ${utc(item.run.startedAt)} · ${item.run.result}_`, '']
  let sawPrompt = false
  for (const event of item.events) {
    switch (event.kind) {
      case 'user':
        if (!sawPrompt) {
          sawPrompt = true
          lines.push(`_Eregion started the ${item.stageName} stage with its prompt (left out here)._`, '')
        } else {
          lines.push('### Person', '', redactor.redact(event.text.trim()), '')
        }
        break
      case 'text':
        if (event.text.trim()) lines.push(`**Agent:** ${redactor.redact(event.text.trim())}`, '')
        break
      case 'tool': {
        lines.push(`- Tool: ${code(redactor.redact(event.summary || event.name))}`)
        const result = results.get(event.id)
        if (result && withholdsOutput(event.summary)) lines.push('  - Output withheld: it may hold secrets or live data.')
        else if (result && !result.ok && result.output.trim()) lines.push('  - Error:', ...clipped(redactor.redact(result.output)))
        else if (result && toolKind(event.name) === 'command' && result.output.trim()) lines.push('  - Output:', ...clipped(redactor.redact(result.output)))
        lines.push('')
        break
      }
      case 'result':
        if (!event.ok) lines.push(`_The run ended with an error: ${redactor.redact(event.text.trim() || 'no message')}_`, '')
        break
      case 'system':
      case 'error':
        if (event.text.trim()) lines.push(`_${redactor.redact(event.text.trim())}_`, '')
    }
  }
  return lines
}

function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
}

function renderReview(review: Review, heading: string, redactor: Redactor): string[] {
  const lines = [heading, '', `> RESULT: ${review.verdict.toUpperCase()}`, '']
  if (review.summary.trim()) lines.push(redactor.redact(review.summary.trim()), '')
  if (review.issues.length > 0) {
    lines.push('| # | Severity | Where | Problem | Fix |', '|---|---|---|---|---|')
    for (const issue of review.issues) {
      const where = `${issue.repo}/${issue.file}${issue.line ? `:${issue.line}` : ''}`
      lines.push(`| ${issue.id} | ${issue.severity} | ${code(redactor.redact(where))} | ${cell(redactor.redact(issue.problem))} | ${cell(redactor.redact(issue.fix))} |`)
    }
    lines.push('')
  }
  if (review.spec.length > 0) {
    lines.push('| Spec | Status | Evidence |', '|---|---|---|')
    for (const check of review.spec) lines.push(`| ${check.id} | ${check.met ? 'Met' : 'Not met'} | ${cell(redactor.redact(check.evidence))} |`)
    lines.push('')
  }
  return lines
}

/** A file's own headings sit under the appendix's. */
function nested(markdown: string): string {
  return markdown.replace(/^(#{1,3}) /gm, (_match, hashes: string) => `${'#'.repeat(Math.min(hashes.length + 3, 6))} `)
}

/**
 * The build log: each run from Build up to the PR as a conversation (what you sent, what the agent said,
 * the tool calls it made with their output clipped), then the review verdicts and build notes. Secrets
 * and personal details are taken out, so it can go on the tracker issue.
 */
export function buildLog(input: BuildLogInput): string {
  const redactor = new Redactor(input.folders)
  const { runs } = input
  const events = runs.flatMap((item) => item.events)
  const prompts = runs.filter((item) => item.events.some((event) => event.kind === 'user')).length
  const messages = events.filter((event) => event.kind === 'user').length - prompts
  const replies = events.filter((event) => event.kind === 'text' && event.text.trim()).length
  const tools = events.filter((event) => event.kind === 'tool').length
  const models = [...new Set(runs.map((item) => `${item.run.adapter}/${item.run.model}`))]
  const last = runs.map((item) => item.run.endedAt ?? item.run.startedAt).sort().at(-1)
  const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

  const lines = [`# Build log: ${input.ticket.key} ${redactor.redact(input.ticket.title)}`, '']
  if (input.ticket.branch) lines.push(`- Branch: \`${input.ticket.branch}\``)
  if (models.length) lines.push(`- Models: ${models.join(', ')}`)
  if (runs.length && last) lines.push(`- Started ${utc(runs[0].run.startedAt)}, last activity ${utc(last)}`)
  lines.push(`- ${plural(runs.length, 'run', 'runs')}, ${plural(messages, 'message', 'messages')} from the person, ${plural(replies, 'agent reply', 'agent replies')}, ${plural(tools, 'tool call', 'tool calls')}`)
  lines.push(`- Written ${utc(input.writtenAt)}. Secrets and personal data redacted; tool output clipped to ${OUTPUT_LINES} lines; output of secret and live-data calls withheld; Eregion's stage prompts left out.`)
  lines.push('', '---', '')
  if (runs.length === 0) lines.push('_No agent ran between Build and the PR._', '')
  for (const item of runs) lines.push(...renderRun(item, runs, redactor))

  const reviewed = input.verdicts.filter((stage) => stage.reviews.length > 0)
  if (reviewed.length > 0 || input.buildNotes?.trim() || input.spec?.trim()) {
    lines.push('---', '', '## Appendix: reviews', '')
    if (input.spec?.trim()) lines.push('### Spec', '', nested(redactor.redact(input.spec.trim())), '')
    for (const stage of reviewed) {
      stage.reviews.forEach((review, index) => {
        lines.push(...renderReview(review, `### ${stage.stageName}${stage.reviews.length > 1 ? `, pass ${index + 1}` : ''}`, redactor))
      })
    }
    if (input.buildNotes?.trim()) {
      lines.push('### Build notes', '', nested(redactor.redact(input.buildNotes.trim())), '')
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
