import type { VariablePreview } from '@shared/api'
import type { Repo } from '@shared/model'
import type { Lookup } from '@shared/template'

/** Placeholder values for previews: the sample ticket, project variables and this repo. */
export function previewLookup(preview: VariablePreview | undefined, repo: Pick<Repo, 'name' | 'path'>): Lookup {
  const values: Record<string, string> = {}
  if (preview) {
    Object.assign(values, {
      slot: String(preview.sample.slot),
      'ticket.key': preview.sample.key,
      'ticket.title': preview.sample.title,
      'ticket.description': '',
      branch: preview.sample.branch,
      ...preview.values
    })
  }
  Object.assign(values, {
    'repo.name': repo.name,
    'repo.path': `~/.eregion/work/${preview?.sample.key ?? 'KEY'}/${repo.name}`,
    'repo.main_path': repo.path
  })
  return (name) => values[name]
}
