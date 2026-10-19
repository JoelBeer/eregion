/** Quotes a .env value only when it needs it, the way Laravel and dotenv read them. */
export function formatEnvValue(value: string): string {
  if (value === '' || /^[\w./:@,+-]+$/.test(value)) {
    return value
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Sets keys in .env content. Existing keys are replaced in place (the first occurrence; later
 * duplicates are removed), new keys are appended, and comments and blank lines are kept.
 */
export function setEnvValues(content: string, values: { key: string; value: string }[]): string {
  const lines = content.length > 0 ? content.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []
  for (const { key, value } of values) {
    const line = `${key}=${formatEnvValue(value)}`
    const matcher = new RegExp(`^\\s*(?:export\\s+)?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=`)
    let replaced = false
    for (let index = 0; index < lines.length; index++) {
      if (!matcher.test(lines[index])) continue
      if (!replaced) {
        lines[index] = line
        replaced = true
      } else {
        lines.splice(index, 1)
        index--
      }
    }
    if (!replaced) lines.push(line)
  }
  return `${lines.join('\n')}\n`
}
