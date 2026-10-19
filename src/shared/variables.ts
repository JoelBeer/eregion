import { placeholdersIn, render } from './template'

export interface Variable {
  name: string
  formula: string
}

export interface ResolvedVariables {
  values: Record<string, string>
  errors: Record<string, string>
}

const NAME = /^[a-z][a-z0-9_]*$/

export function isValidVariableName(name: string): boolean {
  return NAME.test(name)
}

/**
 * Integer arithmetic with + - * / and brackets, used when a formula such as `3000 + {{slot}}`
 * resolves to digits and operators only. Division rounds down.
 */
export function evaluateArithmetic(expression: string): number {
  const tokens = expression.match(/\d+|[+\-*/()]/g) ?? []
  if (tokens.join('') !== expression.replace(/\s+/g, '')) {
    throw new Error(`Not arithmetic: ${expression}`)
  }
  let index = 0
  const peek = (): string | undefined => tokens[index]
  const next = (): string | undefined => tokens[index++]

  function factor(): number {
    const token = next()
    if (token === '(') {
      const value = sum()
      if (next() !== ')') throw new Error('Missing )')
      return value
    }
    if (token === '-') return -factor()
    if (token === undefined || !/^\d+$/.test(token)) throw new Error(`Unexpected ${token ?? 'end'}`)
    return Number(token)
  }
  function product(): number {
    let value = factor()
    while (peek() === '*' || peek() === '/') {
      const operator = next()
      const right = factor()
      if (operator === '/' && right === 0) throw new Error('Division by zero')
      value = operator === '*' ? value * right : Math.floor(value / right)
    }
    return value
  }
  function sum(): number {
    let value = product()
    while (peek() === '+' || peek() === '-') {
      value = next() === '+' ? value + product() : value - product()
    }
    return value
  }

  const result = sum()
  if (index !== tokens.length) throw new Error(`Unexpected ${tokens[index]}`)
  return result
}

const ARITHMETIC = /^[\d\s+\-*/()]+$/
const HAS_OPERATOR = /\d\s*[+\-*/]\s*[\d(]/

/**
 * Resolves project variables in dependency order. Formulas may use built-ins (`slot`, `ticket.key`…)
 * and other variables. Cycles and unknown names are reported per variable instead of throwing.
 */
export function resolveVariables(variables: Variable[], builtins: Record<string, string>): ResolvedVariables {
  const values: Record<string, string> = {}
  const errors: Record<string, string> = {}
  const formulas = new Map(variables.map((variable) => [variable.name, variable.formula]))
  const state = new Map<string, 'resolving' | 'done'>()

  function resolve(name: string): string | undefined {
    if (name in builtins) return builtins[name]
    if (!formulas.has(name)) return undefined
    if (state.get(name) === 'done') return errors[name] ? undefined : values[name]
    if (state.get(name) === 'resolving') {
      errors[name] = 'Refers to itself through another variable'
      return undefined
    }
    state.set(name, 'resolving')
    const formula = formulas.get(name) as string
    const missing = placeholdersIn(formula).filter((dependency) => resolve(dependency) === undefined)
    if (missing.length > 0) {
      errors[name] ??= `Unknown or broken: ${missing.join(', ')}`
      state.set(name, 'done')
      return undefined
    }
    const rendered = render(formula, resolve)
    let value = rendered.text
    if (rendered.unknownFilters.length > 0) {
      errors[name] = `Unknown filter: ${rendered.unknownFilters.join(', ')}`
    } else if (ARITHMETIC.test(value) && HAS_OPERATOR.test(value)) {
      try {
        value = String(evaluateArithmetic(value))
      } catch (error) {
        errors[name] = (error as Error).message
      }
    }
    state.set(name, 'done')
    if (errors[name]) return undefined
    values[name] = value
    return value
  }

  for (const variable of variables) {
    if (!isValidVariableName(variable.name)) {
      errors[variable.name] = 'Use lowercase letters, digits and underscores, starting with a letter'
      continue
    }
    resolve(variable.name)
  }
  return { values, errors }
}
