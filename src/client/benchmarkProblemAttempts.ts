import type {BenchmarkProblemAttempt} from '../shared/types'

export function groupBenchmarkProblemAttempts(
  actions: BenchmarkProblemAttempt[],
) {
  const attempts: BenchmarkProblemAttempt[][] = []
  let current: BenchmarkProblemAttempt[] = []

  for (const action of actions) {
    current.push(action)
    if (!action.correct) {
      attempts.push(current)
      current = []
    }
  }
  if (current.length) attempts.push(current)

  return attempts
}
