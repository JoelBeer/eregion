import type { Runner } from '../runner'

export class GitError extends Error {}

export async function gitIn(runner: Runner, cwd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  const result = await runner.exec(['git', ...args], { cwd, timeoutMs })
  if (result.code !== 0) {
    throw new GitError(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
  }
  return result.stdout.trim()
}

export async function gitOk(runner: Runner, cwd: string, args: string[]): Promise<boolean> {
  return (await runner.exec(['git', ...args], { cwd, timeoutMs: 60_000 })).code === 0
}

/**
 * The ref new work starts from: origin/<branch> after a fetch, or the local branch when the
 * repo has no origin or the fetch fails (offline). Returns the ref and whether the fetch worked.
 */
export async function baseRef(runner: Runner, mainPath: string, branch: string): Promise<{ ref: string; fetched: boolean }> {
  let fetched = false
  if (await gitOk(runner, mainPath, ['remote', 'get-url', 'origin'])) {
    fetched = (await runner.exec(['git', 'fetch', '--prune', 'origin', branch], { cwd: mainPath, timeoutMs: 120_000 })).code === 0
  }
  if (await gitOk(runner, mainPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) {
    return { ref: `origin/${branch}`, fetched }
  }
  return { ref: branch, fetched }
}

/** Worktree paths git knows about for a repo. */
export async function worktreePaths(runner: Runner, mainPath: string): Promise<string[]> {
  const output = await gitIn(runner, mainPath, ['worktree', 'list', '--porcelain'])
  return output
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
}

export async function branchExists(runner: Runner, mainPath: string, branch: string): Promise<boolean> {
  return gitOk(runner, mainPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
}

/**
 * Makes sure a worktree exists at `path`: on `branch` (created from `base` when new), or detached
 * at `base` when `branch` is null. An existing worktree is reused, and a detached one is switched
 * onto the branch when the ticket now needs to change that repo.
 */
export async function ensureWorktree(runner: Runner, mainPath: string, path: string, base: string, branch: string | null): Promise<'created' | 'reused' | 'switched'> {
  const existing = (await worktreePaths(runner, mainPath)).includes(path)
  if (existing) {
    if (!branch) return 'reused'
    const current = await gitIn(runner, path, ['branch', '--show-current'])
    if (current === branch) return 'reused'
    if (await branchExists(runner, mainPath, branch)) {
      await gitIn(runner, path, ['switch', branch])
    } else {
      await gitIn(runner, path, ['switch', '-c', branch])
    }
    return 'switched'
  }
  await gitIn(runner, mainPath, ['worktree', 'prune'])
  if (!branch) {
    await gitIn(runner, mainPath, ['worktree', 'add', '--detach', path, base])
  } else if (await branchExists(runner, mainPath, branch)) {
    await gitIn(runner, mainPath, ['worktree', 'add', path, branch])
  } else {
    await gitIn(runner, mainPath, ['worktree', 'add', '-b', branch, path, base])
  }
  return 'created'
}

export async function removeWorktree(runner: Runner, mainPath: string, path: string): Promise<void> {
  if ((await worktreePaths(runner, mainPath)).includes(path)) {
    await gitIn(runner, mainPath, ['worktree', 'remove', '--force', path])
  }
  await gitIn(runner, mainPath, ['worktree', 'prune'])
}

/** Files changed in a worktree, as `git status --porcelain` lines. */
export async function changedFiles(runner: Runner, path: string): Promise<string[]> {
  const output = await gitIn(runner, path, ['status', '--porcelain'])
  return output ? output.split('\n') : []
}

/** Throws away uncommitted changes in a worktree, including new files. */
export async function discardChanges(runner: Runner, path: string): Promise<void> {
  await gitIn(runner, path, ['reset', '--hard', '--quiet'])
  await gitIn(runner, path, ['clean', '-fdq'])
}

/** Commits everything in a worktree. Returns the new commit's short sha, or null when there was nothing to commit. */
export async function commitAll(runner: Runner, path: string, subject: string, body: string): Promise<string | null> {
  await gitIn(runner, path, ['add', '-A'])
  if ((await runner.exec(['git', 'diff', '--cached', '--quiet'], { cwd: path })).code === 0) return null
  const args = ['commit', '--quiet', '-m', subject]
  if (body.trim()) args.push('-m', body.trim())
  await gitIn(runner, path, args)
  return gitIn(runner, path, ['rev-parse', '--short', 'HEAD'])
}

export async function hasOrigin(runner: Runner, path: string): Promise<boolean> {
  return gitOk(runner, path, ['remote', 'get-url', 'origin'])
}

/**
 * Brings a ticket branch up to date with the same branch on origin, which CI or a person may have pushed to
 * (a linter's fix commit, say). Commits only the worktree has aren't pushed yet, so they're replayed on top:
 * this rebase never needs a force push. Uncommitted work is stashed and put back. Does nothing when the branch
 * isn't on origin yet or the fetch fails (offline). A rebase that conflicts is aborted, so the worktree is unchanged.
 * Returns what changed, or null when nothing did.
 */
export async function syncWithOrigin(runner: Runner, path: string, branch: string): Promise<string | null> {
  if (!(await hasOrigin(runner, path))) return null
  const fetched = await runner.exec(['git', 'fetch', '--quiet', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: path, timeoutMs: 120_000 })
  if (fetched.code !== 0) return null
  const remote = `origin/${branch}`
  const behind = Number(await gitIn(runner, path, ['rev-list', '--count', `HEAD..${remote}`]))
  if (behind === 0) return null
  const ahead = Number(await gitIn(runner, path, ['rev-list', '--count', `${remote}..HEAD`]))
  const count = (n: number): string => `${n} ${n === 1 ? 'commit' : 'commits'}`
  const result = await runner.exec(['git', 'rebase', '--autostash', '--quiet', remote], { cwd: path, timeoutMs: 120_000 })
  if (result.code !== 0) {
    await runner.exec(['git', 'rebase', '--abort'], { cwd: path })
    throw new GitError(`${remote} has ${count(behind)} this worktree doesn't, and its own ${count(ahead)} don't rebase cleanly onto them, so nothing changed: ${(result.stdout || result.stderr).trim().split('\n').slice(-6).join(' ')}`)
  }
  return ahead === 0 ? `pulled ${count(behind)} from ${remote}` : `pulled ${count(behind)} from ${remote} and rebased ${count(ahead)} on top`
}

/** Pushes the branch to origin, setting upstream. Never forces. */
export async function pushBranch(runner: Runner, path: string, branch: string): Promise<void> {
  await gitIn(runner, path, ['push', '--quiet', '-u', 'origin', branch], 180_000)
}

/**
 * Brings a worktree up to date with its base: merges the base into the ticket branch (never a
 * rebase, since the branch may already be pushed), or moves a read-only worktree to the base.
 * Uncommitted work is left alone. A merge that conflicts is aborted, so the worktree is unchanged.
 */
export async function updateFromBase(runner: Runner, path: string, ref: string, onTicketBranch: boolean): Promise<string> {
  const behind = Number(await gitIn(runner, path, ['rev-list', '--count', `HEAD..${ref}`]))
  if (behind === 0) return `already up to date with ${ref}`
  const commits = `${behind} ${behind === 1 ? 'commit' : 'commits'}`
  if (!onTicketBranch) {
    await gitIn(runner, path, ['checkout', '--quiet', '--detach', ref])
    return `moved to ${ref} (${commits})`
  }
  const result = await runner.exec(['git', 'merge', '--no-edit', ref], { cwd: path, timeoutMs: 120_000 })
  if (result.code !== 0) {
    await runner.exec(['git', 'merge', '--abort'], { cwd: path })
    throw new GitError(`${ref} doesn't merge cleanly into this ticket's branch, so nothing changed: ${(result.stdout || result.stderr).trim().split('\n').slice(-6).join(' ')}`)
  }
  return `merged ${commits} from ${ref}`
}

/**
 * The files a ticket has added or changed in a worktree, to open in an editor: on its branch since the base,
 * and not yet committed (new files too). Deleted files are left out, since there's nothing to open.
 */
export async function filesToReview(runner: Runner, path: string, base: string): Promise<string[]> {
  const committed = await gitIn(runner, path, ['diff', '--name-only', '--diff-filter=d', `${base}...HEAD`], 60_000)
  const status = await runner.exec(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: path, timeoutMs: 60_000 })
  if (status.code !== 0) throw new GitError(`git status failed: ${(status.stderr || status.stdout).trim()}`)
  const uncommitted: string[] = []
  const entries = status.stdout.split('\0')
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    // A rename or copy is followed by the path it came from.
    if (code.includes('R') || code.includes('C')) index++
    if (!code.includes('D')) uncommitted.push(entry.slice(3))
  }
  return [...new Set([...committed.split('\n'), ...uncommitted].map((file) => file.trim()).filter(Boolean))]
}

/** The diff of the ticket branch against its base, for the Diff tab. */
export async function branchDiff(runner: Runner, path: string, base: string): Promise<string> {
  return gitIn(runner, path, ['diff', '--no-color', '--find-renames', `${base}...HEAD`], 60_000)
}
