/** A valid spec.md for the hint ticket the pipeline tests run, and a review's audit of it. */
export const HINT_SPEC = `# Spec · WM-1 · Hints

## Problem
Players get stuck on a word with no way forward.

## Behaviour
- S1: After two wrong guesses the game shows the word's first letter

## Contracts
- None

## Test seams
- The game page

## Out of scope
- Hints for the daily puzzle
`

export const HINT_SPEC_MET = [{ id: 'S1', status: 'met', evidence: 'Two wrong guesses show the first letter (hint.txt).' }]
