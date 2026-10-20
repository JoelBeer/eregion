export const PLAN_MARKER = '<!-- eregion:plan -->'

/** The ticket description with the approved plan appended, replacing a plan Eregion added before. */
export function descriptionWithPlan(description: string, plan: string): string {
  const original = description.split(PLAN_MARKER)[0].trimEnd()
  return `${original}\n\n${PLAN_MARKER}\n---\n\n${plan.trim()}\n`
}
