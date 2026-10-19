#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json --verbose`,
// used by tests. Each user message line is one turn. A message's text controls the turn:
//   "write <file> <content>"  writes a file, then replies
//   "slow"                    takes two seconds (to test messages that arrive mid-turn)
//   "fail"                    ends the turn with an error result
//   anything else             is echoed back as "You said: <text>."
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const sessionId = 'fake-session-1'
let cost = 0
const out = (object) => process.stdout.write(`${JSON.stringify(object)}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

out({ type: 'system', subtype: 'init', session_id: sessionId, model: 'fake-model', cwd: process.cwd() })

const queue = []
let busy = false
let closed = false

async function turn(text) {
  if (text === 'slow') await sleep(2000)
  if (text.startsWith('write ')) {
    const [, file, ...rest] = text.split(' ')
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: file } }] } })
    writeFileSync(file, rest.join(' '))
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } })
  }
  cost += 0.01
  if (text === 'fail') {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Something broke.', total_cost_usd: cost, num_turns: 1, usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
    return
  }
  out({ type: 'assistant', message: { content: [{ type: 'text', text: `You said: ${text}.` }] } })
  out({ type: 'result', subtype: 'success', is_error: false, result: `You said: ${text}.`, total_cost_usd: cost, num_turns: 1, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 } })
}

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
