import { describe, expect, it } from 'vitest'
import type { AgentEvent } from './agent'
import { conversationBlocks, describeTools } from './conversation'

describe('conversationBlocks', () => {
  it('folds the tool calls an agent makes under what it said, with their results', () => {
    const events: AgentEvent[] = [
      { kind: 'init', sessionId: 's', model: 'm' },
      { kind: 'text', text: 'Reading the document models.' },
      { kind: 'tool', id: 'a', name: 'Read', summary: 'read app/Models/Document.php' },
      { kind: 'tool', id: 'b', name: 'Bash', summary: '$ php artisan test' },
      { kind: 'tool-result', id: 'a', ok: true, output: '<?php' },
      { kind: 'tool-result', id: 'b', ok: false, output: '1 failed' },
      { kind: 'tool', id: 'c', name: 'Bash', summary: '$ vendor/bin/pint --dirty' },
      { kind: 'text', text: 'One test fails; fixing it.' }
    ]
    expect(conversationBlocks(events)).toEqual([
      {
        kind: 'say',
        key: '1',
        text: 'Reading the document models.',
        tools: [
          { id: 'a', name: 'Read', summary: 'read app/Models/Document.php', index: 2, result: { ok: true, output: '<?php' } },
          { id: 'b', name: 'Bash', summary: '$ php artisan test', index: 3, result: { ok: false, output: '1 failed' } },
          { id: 'c', name: 'Bash', summary: '$ vendor/bin/pint --dirty', index: 6, result: null }
        ]
      },
      { kind: 'say', key: '7', text: 'One test fails; fixing it.', tools: [] }
    ])
  })

  it("keeps calls made before the agent says anything, or after your message, as their own group", () => {
    const blocks = conversationBlocks([
      { kind: 'tool', id: 'a', name: 'Bash', summary: '$ git status' },
      { kind: 'user', text: 'Use the main branch', delivery: 'now' },
      { kind: 'tool', id: 'b', name: 'Grep', summary: 'searched Document' },
      { kind: 'result', ok: false, text: '', costUsd: null, usage: null, turns: 1 }
    ])
    expect(blocks.map((block) => block.kind)).toEqual(['tools', 'user', 'tools', 'error'])
    expect(blocks[3]).toMatchObject({ text: 'The agent stopped with an error.' })
  })
})

describe('describeTools', () => {
  it('counts what the calls did, in a fixed order', () => {
    expect(describeTools([{ name: 'Read' }, { name: 'Bash' }, { name: 'Read' }, { name: 'Bash' }, { name: 'Bash' }])).toBe('Ran 3 commands, read 2 files')
    expect(describeTools([{ name: 'Edit' }, { name: 'Grep' }, { name: 'mcp__linear__get_issue' }])).toBe('Edited 1 file, searched 1 time, used 1 tool')
    expect(describeTools([{ name: 'WebFetch' }])).toBe('Looked up 1 page')
  })
})
