import {capabilitiesForProvider} from '../shared/providerCapabilities'
import type {
  BenchmarkConfig,
  BenchmarkRun,
  PlayerProfile,
  ProviderConnection,
} from '../shared/types'

export function benchmarkEligibleProfiles(
  profiles: PlayerProfile[] | undefined,
  connections: ProviderConnection[] | undefined,
) {
  const kinds = new Map(connections?.map(({id, kind}) => [id, kind]) ?? [])
  return (profiles ?? []).filter((profile) => {
    const kind = kinds.get(profile.connectionId)
    return kind ? capabilitiesForProvider(kind).benchmarks : false
  })
}

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
