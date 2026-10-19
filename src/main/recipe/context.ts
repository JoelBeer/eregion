import type { Lookup } from '@shared/template'
import { resolveVariables, type ResolvedVariables, type Variable } from '@shared/variables'

export interface TicketValues {
  key: string
  title: string
  description?: string
  slot: number
  branch: string
}

export interface RepoValues {
  name: string
  /** The ticket's worktree for this repo. */
  path: string
  /** The original clone. */
  mainPath: string
}

/** Built-ins that don't depend on a repo, used to resolve project variables. */
export function ticketBuiltins(ticket: TicketValues): Record<string, string> {
  return {
    slot: String(ticket.slot),
    'ticket.key': ticket.key,
    'ticket.title': ticket.title,
    'ticket.description': ticket.description ?? '',
    branch: ticket.branch
  }
}

export interface RecipeContext {
  variables: ResolvedVariables
  /** Values for a step or service in one repo: built-ins, then project variables. */
  lookupFor(repo: RepoValues): Lookup
}

export function recipeContext(variables: Variable[], ticket: TicketValues): RecipeContext {
  const builtins = ticketBuiltins(ticket)
  const resolved = resolveVariables(variables, builtins)
  return {
    variables: resolved,
    lookupFor(repo) {
      const values: Record<string, string> = {
        ...builtins,
        ...resolved.values,
        'repo.name': repo.name,
        'repo.path': repo.path,
        'repo.main_path': repo.mainPath
      }
      return (name) => values[name]
    }
  }
}
