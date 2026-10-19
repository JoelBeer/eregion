#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json --verbose`,
// used by tests. Each user message line is one turn.
//
// With EREGION_FAKE_SCRIPT pointing at a JSON file of rules, the first rule whose "when" text
// appears in a turn's message runs: it writes files ({outputs} is the prompt's outputs folder,
// {cwd} the working directory), then replies. Rules with "once": true are used up when they run.
// [{ "when": "Stage: Plan", "write": { "{outputs}/plan.md": "..." }, "reply": "...", "once": true }]
//
// Without a script, a message controls the turn:
//   "write <file> <content>"  writes a file, then replies
//   "slow"                    takes two seconds (to test messages that arrive mid-turn)
//   "fail"                    ends the turn with an error result
//   anything else             is echoed back as "You said: <text>."
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'

const sessionId = 'fake-session-1'
let cost = 0
let outputs = ''
const rules = process.env.EREGION_FAKE_SCRIPT ? JSON.parse(readFileSync(process.env.EREGION_FAKE_SCRIPT, 'utf8')) : null
const out = (object) => process.stdout.write(`${JSON.stringify(object)}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 }

out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd() })

function writeFile(path, content, index) {
  const target = path.replaceAll('{outputs}', outputs).replaceAll('{cwd}', process.cwd())
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${index}`, name: 'Write', input: { file_path: target } }] } })
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${index}`, content: 'ok', is_error: false }] } })
}

async function scripted(text) {
  const index = rules.findIndex((rule) => !rule.used && text.includes(rule.when))
  const rule = rules[index]
  if (!rule) return `No script rule matched.`
  if (rule.once) rule.used = true
  if (rule.delayMs) await sleep(rule.delayMs)
  Object.entries(rule.write ?? {}).forEach(([path, content], i) => writeFile(path, content, i))
  return rule.reply ?? 'Done.'
}

async function turn(text) {
  outputs ||= text.match(/Outputs folder: (.+)/)?.[1]?.trim() ?? ''
  let reply
  if (rules) {
    reply = await scripted(text)
  } else {
    if (text === 'slow') await sleep(2000)
    if (text.startsWith('write ')) {
      const [, file, ...rest] = text.split(' ')
      writeFile(file, rest.join(' '), 1)
    }
    if (text === 'fail') {
      cost += 0.01
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Something broke.', total_cost_usd: cost, num_turns: 1, usage: { ...usage, input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
      return
    }
    reply = `You said: ${text}.`
  }
  cost += 0.01
  out({ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: cost, num_turns: 1, usage })
}

const queue = []
let busy = false
let closed = false

async function drain() {
  if (busy) return
  busy = true
  while (queue.length > 0) await turn(queue.shift())
  busy = false
  if (closed) process.exit(0)
}

createInterface({ input: process.stdin })
  .on('line', (line) => {
    if (!line.trim()) return
    queue.push(JSON.parse(line).message.content)
    void drain()
  })
  .on('close', () => {
    closed = true
    if (!busy && queue.length === 0) process.exit(0)
  })
