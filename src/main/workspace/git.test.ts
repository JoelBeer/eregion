import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { NativeRunner } from '../runner/native'
import { git, makeRepo } from '../testing/git'
import { ensureWorktree, GitError, physicalPath, pushBranch, removeWorktree, syncWithOrigin } from './git'

const runner = new NativeRunner()

/** Commits a file in a test checkout. */
async function commit(cwd: string, file: string, content: string, message: string): Promise<void> {
  await writeFile(join(cwd, file), content)
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-m', message)
}

describe.skipIf(process.platform === 'win32')('syncWithOrigin', () => {
  // `clone` is Eregion's worktree on the ticket branch; `other` is whoever else pushes to it, like CI's linter.
  let clone: string
  let other: string

  beforeEach(async () => {
    const repo = await makeRepo({ 'a.txt': 'one\n' })
    clone = repo.clone
    other = join(repo.root, 'other')
    for (const [key, value] of [['user.name', 'Test'], ['user.email', 'test@example.com']]) git(clone, 'config', key, value)
    git(clone, 'switch', '-c', 'ticket')
    await commit(clone, 'b.txt', 'build\n', 'Build pass 1')
    git(clone, 'push', '-u', 'origin', 'ticket')
    git(repo.root, 'clone', '--branch', 'ticket', repo.origin, other)
  })

  it('does nothing when the branch is up to date, or not on origin yet', async () => {
    expect(await syncWithOrigin(runner, clone, 'ticket')).toBeNull()
    git(clone, 'switch', '-c', 'not-pushed')
    expect(await syncWithOrigin(runner, clone, 'not-pushed')).toBeNull()
  })

  it("pulls a commit someone else pushed, so the worktree is on GitHub's tip", async () => {
    await commit(other, 'a.txt', 'one, linted\n', 'Lint')
    git(other, 'push')
    expect(await syncWithOrigin(runner, clone, 'ticket')).toBe('pulled 1 commit from origin/ticket')
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(git(other, 'rev-parse', 'HEAD'))
  })

  it("replays the worktree's own unpushed commits on top, so the push that follows isn't rejected", async () => {
    await commit(other, 'a.txt', 'one, linted\n', 'Lint')
    git(other, 'push')
    await commit(clone, 'c.txt', 'fix\n', 'CI fix')
    expect(await syncWithOrigin(runner, clone, 'ticket')).toBe('pulled 1 commit from origin/ticket and rebased 1 commit on top')
    expect(git(clone, 'log', '--format=%s', '-3').split('\n')).toEqual(['CI fix', 'Lint', 'Build pass 1'])
    await pushBranch(runner, clone, 'ticket')
    expect(git(other, 'ls-remote', 'origin', 'refs/heads/ticket').split('\t')[0]).toBe(git(clone, 'rev-parse', 'HEAD'))
  })

  it('keeps uncommitted work', async () => {
    await commit(other, 'a.txt', 'one, linted\n', 'Lint')
    git(other, 'push')
    await writeFile(join(clone, 'b.txt'), 'build, still going\n')
    await syncWithOrigin(runner, clone, 'ticket')
    expect(await readFile(join(clone, 'b.txt'), 'utf8')).toBe('build, still going\n')
    expect(await readFile(join(clone, 'a.txt'), 'utf8')).toBe('one, linted\n')
  })

  it("leaves the worktree as it was when its commits don't rebase cleanly", async () => {
    await commit(other, 'a.txt', 'theirs\n', 'Lint')
    git(other, 'push')
    await commit(clone, 'a.txt', 'ours\n', 'CI fix')
    const before = git(clone, 'rev-parse', 'HEAD')
    await expect(syncWithOrigin(runner, clone, 'ticket')).rejects.toThrow(GitError)
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(before)
    expect(existsSync(join(clone, '.git', 'rebase-merge')) || existsSync(join(clone, '.git', 'rebase-apply'))).toBe(false)
    expect(git(clone, 'status', '--porcelain')).toBe('')
  })
})

describe.skipIf(process.platform === 'win32')('worktrees through a symlinked folder', () => {
  // Like macOS's /var, which git sees as /private/var: Eregion names the path one way, git lists it the other.
  it('finds, reuses and removes a worktree whose path goes through a symlink', async () => {
    const repo = await makeRepo({ 'a.txt': 'one\n' })
    const real = await realpath(await mkdtemp(join(tmpdir(), 'eregion-real-')))
    const linked = join(await realpath(await mkdtemp(join(tmpdir(), 'eregion-link-'))), 'root')
    await symlink(real, linked)
    const path = join(linked, 'work', 'WM-1', 'app')

    expect(await physicalPath(runner, path)).toBe(join(real, 'work', 'WM-1', 'app'))
    expect(await ensureWorktree(runner, repo.clone, path, 'origin/main', 'wm-1')).toBe('created')
    expect(await physicalPath(runner, path)).toBe(join(real, 'work', 'WM-1', 'app'))
    expect(await ensureWorktree(runner, repo.clone, path, 'origin/main', 'wm-1')).toBe('reused')
    await removeWorktree(runner, repo.clone, path)
    expect(existsSync(path)).toBe(false)
    expect(git(repo.clone, 'worktree', 'list')).not.toContain('WM-1')
    git(repo.clone, 'branch', '-D', 'wm-1')
  })
})
