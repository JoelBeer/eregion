import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBackend, type Backend } from './api'
import { openDatabase } from './db'
import { makeRepo } from './testing/git'

const FAKE = ['node', resolve('src/main/testing/fake-claude.mjs')]

async function until<T>(read: () => T, check: (value: T) => boolean, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (check(value)) return value
    await new Promise((wait) => setTimeout(wait, 50))
  }
  throw new Error(`Timed out at ${JSON.stringify(read())}`)
}

describe.skipIf(process.platform === 'win32')('Forge', () => {
  it('chats with a Visitor read-only, keeps one session going, and resumes it after it ends', async () => {
    const backend: Backend = createBackend(
      openDatabase(':memory:'),
      { appVersion: '0.1.0', databasePath: ':memory:', pickFolder: async () => null, pickSaveFile: async () => null, pickOpenFile: async () => null, openExternal: async () => undefined, emit: () => undefined },
      { agentCommand: () => FAKE, workspaceRoot: await mkdtemp(join(tmpdir(), 'eregion-forge-')) }
    )
    const { api } = backend
    const repo = await makeRepo({ 'README.md': 'app' })
    const project = await api.createProject('Word Magic')
    const added = await api.addRepo(project.id, { name: 'word-magic', path: repo.clone, runtime: 'native', defaultBranch: 'main' })

    const chat = await api.createChat(project.id, { crewId: null, adapter: 'claude-code', model: 'claude-haiku-5-5', repoIds: [added.id] })
    expect(chat).toMatchObject({ title: 'New chat', crewId: null, model: 'claude-haiku-5-5', repoIds: [added.id], runIds: [] })

    const { runId } = await api.sendToChat(chat.id, 'How are hints shown?\nMore detail here.', false)
    await until(() => backend.agents.liveState(runId), (state) => state === 'waiting')
    const view = await api.getRun(runId)
    expect(view.run).toMatchObject({ stage: 'forge', crewId: null, chatId: chat.id, model: 'claude-haiku-5-5' })
    expect(view.events.filter((event) => event.kind === 'user').map((event) => event.kind === 'user' && event.text)).toEqual(['How are hints shown?\nMore detail here.'])

    // While the session is live, the next message goes into it.
    expect((await api.sendToChat(chat.id, 'And the colours?', false)).runId).toBe(runId)
    await until(
      () => backend.runs.events(runId).filter((event) => event.kind === 'text').length,
      (count) => count >= 2
    )

    backend.agents.end(runId)
    await until(() => backend.agents.liveState(runId), (state) => state === null)
    const again = await api.sendToChat(chat.id, 'One more thing', false)
    expect(again.runId).not.toBe(runId)
    await until(() => backend.agents.liveState(again.runId), (state) => state === 'waiting')

    const [listed] = await api.listChats(project.id)
    expect(listed).toMatchObject({ id: chat.id, title: 'How are hints shown?', runIds: [runId, again.runId] })
    expect(listed.costUsd).toBeGreaterThan(0)
    await api.deleteChat(chat.id)
    expect(await api.listChats(project.id)).toEqual([])
    await backend.shutdown()
  }, 60_000)
})
