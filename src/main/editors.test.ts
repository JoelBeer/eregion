import { describe, expect, it } from 'vitest'
import { openDatabase } from './db'
import { Editors } from './editors'
import { NativeRunner } from './runner/native'

describe.skipIf(process.platform === 'win32')('Editors', () => {
  const setup = (command: string): { editors: Editors; runner: NativeRunner } => {
    const editors = new Editors(openDatabase(':memory:'))
    editors.setChoice({ id: 'custom', command })
    return { editors, runner: new NativeRunner() }
  }

  it('starts with VS Code, and keeps the editor you choose', () => {
    const editors = new Editors(openDatabase(':memory:'))
    expect(editors.choice()).toEqual({ id: 'vscode' })
    expect(editors.setChoice({ id: 'phpstorm', command: 'ignored' })).toEqual({ id: 'phpstorm' })
    expect(editors.choice()).toEqual({ id: 'phpstorm' })
    expect(() => editors.setChoice({ id: 'notepad' })).toThrow("Eregion doesn't know an editor called notepad")
  })

  it('opens the folder with the chosen command', async () => {
    const { editors, runner } = setup('test -d')
    await expect(editors.open(runner, '/tmp', 2_000)).resolves.toBeUndefined()
  })

  it("doesn't wait for an editor that keeps running until it's closed", async () => {
    const { editors, runner } = setup('sleep 20; true')
    const started = Date.now()
    await editors.open(runner, '/tmp', 300)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it("says so when the editor isn't installed", async () => {
    const { editors, runner } = setup('definitely-not-an-editor-eregion')
    await expect(editors.open(runner, '/tmp', 2_000)).rejects.toThrow("Couldn't open your editor: it isn't installed, or its command isn't on the PATH. Choose your editor in Settings › Editor.")
  })

  it('lists the editors it knows, found or not', async () => {
    const editors = new Editors(openDatabase(':memory:'))
    const list = await editors.list(new NativeRunner())
    expect(list.map((editor) => editor.id)).toEqual(['vscode', 'cursor', 'phpstorm', 'webstorm', 'zed', 'sublime', 'atom'])
    expect(list.every((editor) => typeof editor.found === 'boolean')).toBe(true)
  })
})
