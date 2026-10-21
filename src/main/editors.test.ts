import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { git, makeRepo } from './testing/git'
import { filesToReview } from './workspace/git'
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
    await expect(editors.open(runner, '/tmp', [], 2_000)).resolves.toBe(0)
  })

  it('opens the files with the folder, at most 20 of them', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'eregion-editor-'))
    const names = Array.from({ length: 25 }, (_, index) => `file-${index}.txt`)
    await Promise.all(names.map((name) => writeFile(join(folder, name), 'x')))
    const log = join(folder, 'opened.log')
    const { editors, runner } = setup(`bash -c 'echo "$@" > ${log}' _ {{path}} {{files}}`)
    expect(await editors.open(runner, folder, names, 2_000)).toBe(20)
    const opened = (await readFile(log, 'utf8')).trim().split(' ')
    expect(opened[0]).toBe(folder)
    expect(opened.slice(1)).toEqual(names.slice(0, 20).map((name) => join(folder, name)))
  })

  it("doesn't wait for an editor that keeps running until it's closed", async () => {
    const { editors, runner } = setup('sleep 20; true')
    const started = Date.now()
    await editors.open(runner, '/tmp', [], 300)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it("says so when the editor isn't installed", async () => {
    const { editors, runner } = setup('definitely-not-an-editor-eregion')
    await expect(editors.open(runner, '/tmp', [], 2_000)).rejects.toThrow("Couldn't open your editor: it isn't installed, or its command isn't on the PATH. Choose your editor in Settings › Editor.")
  })

  it("finds the files a ticket added or changed, committed or not, leaving out deleted ones", async () => {
    const { clone } = await makeRepo({ 'app/a.php': 'a', 'app/gone.php': 'g', 'app/old name.php': 'o', 'README.md': 'r' })
    git(clone, 'checkout', '-b', 'wm-1')
    await writeFile(join(clone, 'app/a.php'), 'changed')
    git(clone, 'rm', '-q', 'app/gone.php')
    git(clone, 'commit', '-qam', 'Build pass 1')
    git(clone, 'mv', 'app/old name.php', 'app/new name.php')
    await writeFile(join(clone, 'README.md'), 'not committed yet')
    await writeFile(join(clone, 'app/b.php'), 'new file')
    const files = await filesToReview(new NativeRunner(), clone, 'origin/main')
    expect(files.sort()).toEqual(['README.md', 'app/a.php', 'app/b.php', 'app/new name.php'])
  })

  it('lists the editors it knows, found or not', async () => {
    const editors = new Editors(openDatabase(':memory:'))
    const list = await editors.list(new NativeRunner())
    expect(list.map((editor) => editor.id)).toEqual(['vscode', 'cursor', 'phpstorm', 'webstorm', 'zed', 'sublime', 'atom'])
    expect(list.every((editor) => typeof editor.found === 'boolean')).toBe(true)
  })
})
