/**
 * The campaign: one trace, through the whole pipeline.
 *
 *   trace -> crash points -> states -> images -> the target's recovery -> oracle
 *
 * Every stage is bounded by core/src/enumerate/bounds.jsonc and seeded, so a
 * run is reproducible from its seed and the bounds file alone.
 */

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadBounds } from '../enumerate/bounds'
import { selectCrashPoints } from '../enumerate/crash-points'
import { sampleStates } from '../enumerate/sample'
import { enumerateCrashStates } from '../enumerate/states'
import type { CrashState } from '../enumerate/states'
import type { FilesystemModel } from '../graph/models'
import type { Filesystem } from '../image/image'
import { materializeState, withMount } from '../image/image'
import { parseAckLog } from '../oracle/acklog'
import { signatureOf } from '../oracle/dedup'
import { checkOracle } from '../oracle/oracle'
import type { RecoveryResult, Violation } from '../oracle/oracle'
import { parseTrace } from '../trace/reader'

/** 512 MiB: above the 300 MiB xfsprogs minimum, sparse so it costs nothing unused. */
const IMAGE_BYTES = 512 * 1024 * 1024

export type CampaignOptions = {
  tracePath: string
  casDir: string
  /** Directory the traced paths are relative to. */
  rootDir: string
  /** Where images are written. Must be on the guest disk. */
  imageDir: string
  /** Database file name inside the traced directory. */
  dbName: string
  model: FilesystemModel
  filesystem: Filesystem
  /** Passed to mount -o, from the sweep row. Must match the model. */
  mountOptions?: string
  seed: number
  /**
   * Runs the target's own recovery against a mounted crash image. Supplied by
   * the caller so the pipeline is not tied to one target: the control and the
   * positive control differ only in this function.
   */
  recover: (mountDir: string) => RecoveryResult
}

export type Finding = {
  signature: string
  violation: Violation
  /** How many distinct states produced this signature. */
  occurrences: number
  /** The first state that produced it, kept as the reproducer. */
  state: CrashState
  imagePath: string
}

export type CampaignResult = {
  crashPointsTested: number
  statesTested: number
  findings: Finding[]
}

/**
 * Runs one trace through the pipeline and returns findings deduplicated by
 * root-cause signature. The image behind the first state to produce each
 * signature is kept; the rest are overwritten, since a second image of the same
 * bug is not a second bug.
 */
export function runCampaign(options: CampaignOptions): CampaignResult {
  const bounds = loadBounds()
  const trace = parseTrace(readFileSync(options.tracePath, 'utf8'))
  const ackLog = parseAckLog(trace)

  const crashPoints = selectCrashPoints(trace, {
    nonFsyncSampleRate: bounds.nonFsyncSampleRate,
    maxExhaustiveWorkloadOps: bounds.maxExhaustiveWorkloadOps,
    seed: options.seed,
  })

  const states = sampleStates(
    enumerateCrashStates(trace, {
      model: options.model,
      bounds: {
        tornWrites: bounds.tornWrites,
        maxUnpersistedWindow: bounds.maxUnpersistedWindow,
      },
      crashPoints,
    }),
    { maxPerCrashPoint: bounds.maxStatesPerCrashPoint, seed: options.seed },
  )

  const findings = new Map<string, Finding>()
  let statesTested = 0

  for (const [index, state] of states.entries()) {
    // Findings keep their image, so each state needs its own path until it is
    // known not to be one.
    const imagePath = join(options.imageDir, `state-${index}.img`)

    materializeState(trace, state, {
      imagePath,
      filesystem: options.filesystem,
      sizeBytes: IMAGE_BYTES,
      casDir: options.casDir,
      rootDir: options.rootDir,
      mountOptions: options.mountOptions,
    })

    // Recovery runs inside the mount, against the filesystem the state was
    // enumerated for. Running it against a copy would test a filesystem the
    // model says nothing about.
    const recovery = withMount(imagePath, (mountDir) => options.recover(mountDir), {
      mountOptions: options.mountOptions,
    })

    statesTested++

    const crashStamp = trace.events[state.crashPoint]?.index ?? 0
    const violations = checkOracle({ crashStamp, ackLog, recovery })

    for (const violation of violations) {
      const operation = ackLog.find((entry) => entry.op === violation.op)
      const signature = signatureOf(
        violation,
        state,
        trace,
        operation ?? { op: -1, kind: '', key: '', digest: '', beganAt: 0, acknowledgedAt: crashStamp, durable: false },
      )

      const existing = findings.get(signature)
      if (existing === undefined) {
        findings.set(signature, { signature, violation, occurrences: 1, state, imagePath })
      } else {
        existing.occurrences++
      }
    }

    // An image is evidence for a finding. Without one it is half a gigabyte of
    // sparse file plus the metadata mkfs wrote into it, and a sweep of a few
    // thousand states fills the disk and takes the run down with it.
    const isEvidence = [...findings.values()].some((finding) => finding.imagePath === imagePath)
    if (!isEvidence) {
      rmSync(imagePath, { force: true })
    }
  }

  return { crashPointsTested: crashPoints.length, statesTested, findings: [...findings.values()] }
}
