import type { StepConfig } from './model'
import { render, type Lookup } from './template'

/** One line describing a step, with placeholders filled in when a lookup is given, for logs and previews. */
export function describeStep(config: StepConfig, lookup?: Lookup): string {
  const fill = (text: string): string => (lookup ? render(text, lookup).text : text)
  switch (config.type) {
    case 'command':
      return fill(config.command)
    case 'set_env':
      return `Set ${config.file} values: ${config.values.map((entry) => `${entry.key}=${fill(entry.value)}`).join(', ')}`
    case 'copy_file':
      return `Copy ${config.from} from the main repo to ${config.to}`
    case 'script':
      return `Run script ${config.path}${config.args ? ` ${fill(config.args)}` : ''}`
  }
}
