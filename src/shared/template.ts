/**
 * The one template language Eregion uses, for recipe commands, variables and stage prompts:
 * `{{name}}`, `{{name | filter}}` and `{{#if name}} … {{/if}}` (kept only when the value isn't empty).
 */

export const FILTERS: Record<string, (value: string) => string> = {
  lower: (value) => value.toLowerCase(),
  upper: (value) => value.toUpperCase(),
  trim: (value) => value.trim(),
  /** `PP-412` → `pp-412`: safe for hostnames, branches and folder names. */
  slug: (value) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, ''),
  /** `PP-412` → `pp_412`: safe for database names and identifiers. */
  snake: (value) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
}

export type Lookup = (name: string) => string | undefined

export interface RenderResult {
  text: string
  /** Placeholder names that had no value. */
  missing: string[]
  /** Filter names that don't exist. */
  unknownFilters: string[]
}

const IF_BLOCK = /\{\{#if\s+([\w.]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*((?:\|\s*\w+\s*)*)\}\}/g

export function render(template: string, lookup: Lookup): RenderResult {
  const missing = new Set<string>()
  const unknownFilters = new Set<string>()

  const withoutBlocks = template.replace(IF_BLOCK, (_, name: string, body: string) => {
    const value = lookup(name)
    return value !== undefined && value.trim() !== '' ? body : ''
  })

  const text = withoutBlocks.replace(PLACEHOLDER, (whole, name: string, filterPart: string) => {
    const value = lookup(name)
    if (value === undefined) {
      missing.add(name)
      return whole
    }
    const filters = filterPart
      .split('|')
      .map((filter) => filter.trim())
      .filter(Boolean)
    return filters.reduce((current, filter) => {
      const apply = FILTERS[filter]
      if (!apply) {
        unknownFilters.add(filter)
        return current
      }
      return apply(current)
    }, value)
  })

  return { text, missing: [...missing], unknownFilters: [...unknownFilters] }
}

/** Lookup over a plain map of values. */
export function fromRecord(values: Record<string, string | number | undefined>): Lookup {
  return (name) => {
    const value = values[name]
    return value === undefined ? undefined : String(value)
  }
}

/** Placeholder names a template uses, in order of first use. */
export function placeholdersIn(template: string): string[] {
  const names = new Set<string>()
  for (const match of template.matchAll(PLACEHOLDER)) {
    names.add(match[1])
  }
  for (const match of template.matchAll(IF_BLOCK)) {
    names.add(match[1])
  }
  return [...names]
}
