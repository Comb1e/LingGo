import {readFile, readdir, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import type {ResearchCondition} from '../shared/types'
import {researchConditionSchema} from '../shared/types'
import {listResearchRuns, type ResearchSummary} from './research'

export interface ConditionStats {
  condition: ResearchCondition
  n: number
  mean: number
  median: number
  bootstrap95: [number, number]
  values: number[]
}

export function mean(values: number[]) {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0
}

export function median(values: number[]) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

export function seededRandom(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (1664525 * state + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

export function bootstrapConfidenceInterval(
  values: number[],
  seed = 1,
  samples = 2000,
): [number, number] {
  if (!values.length) return [0, 0]
  const random = seededRandom(seed)
  const estimates: number[] = []
  for (let sample = 0; sample < samples; sample++) {
    const draw = Array.from(
      {length: values.length},
      () => values[Math.floor(random() * values.length)],
    )
    estimates.push(mean(draw))
  }
  estimates.sort((a, b) => a - b)
  return [
    estimates[Math.floor(samples * 0.025)] ?? 0,
    estimates[Math.floor(samples * 0.975)] ?? 0,
  ]
}

export function pairedPermutationTest(
  left: number[],
  right: number[],
  seed = 1,
  samples = 5000,
) {
  const count = Math.min(left.length, right.length)
  if (!count) return 1
  const deltas = Array.from(
    {length: count},
    (_, index) => left[index] - right[index],
  )
  const observed = Math.abs(mean(deltas))
  const random = seededRandom(seed)
  let atLeast = 0
  for (let sample = 0; sample < samples; sample++) {
    const permuted = deltas.map((delta) => (random() < 0.5 ? delta : -delta))
    if (Math.abs(mean(permuted)) >= observed) atLeast++
  }
  return (atLeast + 1) / (samples + 1)
}

export function analyzeResearchRuns(runs: ResearchSummary[], seed = 1) {
  const conditions = researchConditionSchema.options
  const byCondition = Object.fromEntries(
    conditions.map((condition) => {
      const values = runs
        .filter((run) => run.condition === condition)
        .map((run) => run.legalMoveRate)
      return [
        condition,
        {
          condition,
          n: values.length,
          mean: mean(values),
          median: median(values),
          bootstrap95: bootstrapConfidenceInterval(values, seed),
          values,
        } satisfies ConditionStats,
      ]
    }),
  ) as Record<ResearchCondition, ConditionStats>
  const baseline = runs.filter((run) => run.condition === 'no_adaptation')
  const pairedDeltas = runs
    .filter((run) => run.condition !== 'no_adaptation')
    .map((run) => {
      const match = baseline.find(
        (candidate) =>
          candidate.modelFingerprint === run.modelFingerprint &&
          candidate.seed === run.seed,
      )
      return match
        ? {
            condition: run.condition,
            deltaLegalMoveRate: run.legalMoveRate - match.legalMoveRate,
            deltaPointLoss: run.kataGoPointLoss - match.kataGoPointLoss,
          }
        : undefined
    })
    .filter(
      (
        value,
      ): value is {
        condition: ResearchCondition
        deltaLegalMoveRate: number
        deltaPointLoss: number
      } => Boolean(value),
    )
  return {
    conditions: byCondition,
    pairedDeltas,
    runCount: runs.length,
    missingBaseline: runs.filter(
      (run) =>
        run.condition !== 'no_adaptation' &&
        !baseline.some(
          (candidate) =>
            candidate.modelFingerprint === run.modelFingerprint &&
            candidate.seed === run.seed,
        ),
    ).length,
  }
}

export async function analyzeResearchDirectory(input: string, seed = 1) {
  const runs = await listResearchRuns(input)
  const analysis = analyzeResearchRuns(runs, seed)
  const rows = [
    'experimentId,runId,condition,seed,modelFingerprint,legalMoveRate,kataGoPointLoss,kataGoWinRateLoss,tokenCost,latencyMs',
  ]
  for (const run of runs)
    rows.push(
      [
        run.experimentId,
        run.runId,
        run.condition,
        run.seed,
        run.modelFingerprint,
        run.legalMoveRate,
        run.kataGoPointLoss,
        run.kataGoWinRateLoss,
        run.tokenCost,
        run.latencyMs,
      ].join(','),
    )
  await writeFile(
    join(input, 'summary.json'),
    `${JSON.stringify({analysis, runs}, null, 2)}\n`,
  )
  await writeFile(join(input, 'summary.csv'), `${rows.join('\n')}\n`)
  const report = [
    `Research runs: ${runs.length}`,
    `Missing baselines: ${analysis.missingBaseline}`,
    ...Object.values(analysis.conditions).map(
      (stat) =>
        `${stat.condition}: n=${stat.n}, mean=${stat.mean.toFixed(4)}, median=${stat.median.toFixed(4)}, 95% CI=[${stat.bootstrap95.map((value) => value.toFixed(4)).join(', ')}]`,
    ),
  ]
  await writeFile(join(input, 'report.txt'), `${report.join('\n')}\n`)
  return analysis
}

export async function validateResearchDirectory(input: string) {
  let runDirectory = input
  try {
    await readFile(join(runDirectory, 'manifest.json'), 'utf8')
  } catch {
    const experiments = (await readdir(input, {withFileTypes: true})).filter(
      (entry) => entry.isDirectory(),
    )
    const candidate = experiments[0]
    if (!candidate) throw new Error('No run directory found')
    runDirectory = join(input, candidate.name)
  }
  const manifest = JSON.parse(
    await readFile(join(runDirectory, 'manifest.json'), 'utf8'),
  )
  const parsed = (await import('./research')).validateResearchManifest(manifest)
  const required = ['moves.jsonl', 'summary.json', 'errors.jsonl']
  const missing: string[] = []
  for (const file of required)
    try {
      await readFile(join(runDirectory, file))
    } catch {
      missing.push(file)
    }
  if (missing.length)
    throw new Error(`Missing research artifacts: ${missing.join(', ')}`)
  return {ok: true, manifest: parsed, missing, runDirectory}
}
