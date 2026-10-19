import { describe, expect, it } from 'vitest'
import { toolsReady } from '@shared/tools'
import type { ToolCheck } from '@shared/types'
import { parseVersion } from './tools'

describe('parseVersion', () => {
  it('finds the version in common --version outputs', () => {
    expect(parseVersion('git version 2.43.0')).toBe('2.43.0')
    expect(parseVersion('gh version 2.63.2 (2024-12-05)\nhttps://github.com/cli/cli/releases/tag/v2.63.2')).toBe('2.63.2')
    expect(parseVersion('2.1.303 (Claude Code)')).toBe('2.1.303')
    expect(parseVersion('no digits here')).toBeUndefined()
  })
})

describe('toolsReady', () => {
  const tool = (name: ToolCheck['tool'], found: boolean, detail?: string): ToolCheck => ({ tool: name, runtime: 'Linux', found, detail })

  it('needs git, a signed-in gh and one agent', () => {
    expect(toolsReady([tool('git', true), tool('gh', true, 'signed in as joel'), tool('claude', true), tool('cursor-agent', false)])).toBe(true)
    expect(toolsReady([tool('git', true), tool('gh', true, 'signed in'), tool('claude', false), tool('cursor-agent', true)])).toBe(true)
  })

  it('is not ready when gh is not signed in or no agent is installed', () => {
    expect(toolsReady([tool('git', true), tool('gh', true, 'not signed in'), tool('claude', true)])).toBe(false)
    expect(toolsReady([tool('git', true), tool('gh', true, 'signed in'), tool('claude', false), tool('cursor-agent', false)])).toBe(false)
    expect(toolsReady([tool('git', false), tool('gh', true, 'signed in'), tool('claude', true)])).toBe(false)
  })
})
