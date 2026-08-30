import type {BenchmarkConfig, BenchmarkRun} from '../shared/types'

export function hasLiveBenchmarkForProfile(
  runs:
    | Array<{
        status: BenchmarkRun['status']
        config: Pick<BenchmarkConfig, 'profileId'>
      }>
    | undefined,
  profileId: string,
) {
  return (
    runs?.some(
      (run) =>
        run.config.profileId === profileId &&
        ['queued', 'running', 'paused'].includes(run.status),
    ) ?? false
  )
}
