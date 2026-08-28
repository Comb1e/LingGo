import type {BenchmarkProblemView} from '../shared/types'

export function shuffledProblemIds(
  problems: BenchmarkProblemView[],
  random: () => number = Math.random,
): string[] {
  const ids = problems.map(({id}) => id)
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    ;[ids[index], ids[swapIndex]] = [ids[swapIndex], ids[index]]
  }
  return ids
}
