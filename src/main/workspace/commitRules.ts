import { COMMITLINT_FILES, CONVENTIONAL_TYPES, EREGION_RULES, rulesFromCommitlint, type CommitRules } from '@shared/commits'
import type { Repo } from '@shared/model'
import type { Runner } from '../runner/types'

/** The commitlint rules a repo's main checkout has, if any. */
async function detected(runner: Runner, repo: Repo): Promise<CommitRules | null> {
  for (const file of COMMITLINT_FILES) {
    const text = await runner.readFile(runner.join(repo.path, file))
    const rules = text === null ? null : rulesFromCommitlint(text, file)
    if (rules) return rules
  }
  return null
}

/** How a repo's commits are written: its setting, or its commitlint config when it's left to detect. */
export async function commitRules(runner: Runner, repo: Repo): Promise<CommitRules> {
  if (repo.commitStyle === 'eregion') return EREGION_RULES
  const found = await detected(runner, repo)
  const types = repo.commitTypes.length > 0 ? repo.commitTypes : null
  if (repo.commitStyle === 'conventional') return { conventional: true, types: types ?? found?.types ?? CONVENTIONAL_TYPES, source: "this repo's setting" }
  if (!found) return EREGION_RULES
  return types ? { ...found, types } : found
}
