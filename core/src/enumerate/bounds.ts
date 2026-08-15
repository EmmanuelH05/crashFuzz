/**
 * Loads the bounds on the crash state space.
 *
 * The values live in bounds.jsonc so each one sits next to the justification
 * CLAUDE.md requires. Comments are stripped here rather than the justifications
 * being moved somewhere the reader of a bound will not see them.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type LoadedBounds = {
  /** How crash points are chosen. See bounds.jsonc. */
  crashPoints: string
  nonFsyncSampleRate: number
  maxUnpersistedWindow: number
  maxExhaustiveWorkloadOps: number
  tornWrites: boolean
  tornWriteGranularityBytes: number
  maxTornOpsPerState: number
}

const BOUNDS_PATH = join(import.meta.dir, 'bounds.jsonc')

/** Removes // comments outside of string literals. */
function stripComments(text: string): string {
  let out = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!

    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }

    if (ch === '"') {
      inString = true
      out += ch
      continue
    }

    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }

    out += ch
  }

  return out
}

export function loadBounds(path: string = BOUNDS_PATH): LoadedBounds {
  return JSON.parse(stripComments(readFileSync(path, 'utf8'))) as LoadedBounds
}
