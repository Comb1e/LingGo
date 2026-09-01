import {describe, expect, it} from 'vitest'
import {
  KATAGO_LEGACY_DEFAULTS,
  KATAGO_PORTABLE_DEFAULTS,
  loadRuntimeConfig,
  loadStorageConfig,
  resolveKataGoDefaults,
} from './config'

describe('KataGo defaults', () => {
  it('uses an installed legacy bundle when no overrides are provided', () => {
    const resolved = resolveKataGoDefaults({}, (path) =>
      (Object.values(KATAGO_LEGACY_DEFAULTS) as string[]).includes(path),
    )

    expect(resolved).toEqual(KATAGO_LEGACY_DEFAULTS)
  })

  it('uses portable defaults when the legacy bundle is unavailable', () => {
    expect(resolveKataGoDefaults({}, () => false)).toEqual(
      KATAGO_PORTABLE_DEFAULTS,
    )
  })

  it('applies explicit environment overrides', () => {
    expect(
      resolveKataGoDefaults(
        {
          LINGGO_KATAGO_PATH: '/custom/katago',
          LINGGO_KATAGO_MODEL_PATH: '/custom/model.bin.gz',
          LINGGO_KATAGO_CONFIG: '/custom/config.cfg',
        },
        () => true,
      ),
    ).toEqual({
      executablePath: '/custom/katago',
      modelPath: '/custom/model.bin.gz',
      configPath: '/custom/config.cfg',
    })
  })
})

describe('runtime configuration', () => {
  it('validates and applies operational overrides', () => {
    const config = loadRuntimeConfig({
      NODE_ENV: 'test',
      LINGGO_MODEL_REPAIR_RETRY_LIMIT: '2',
      LINGGO_PROVIDER_RETRY_LIMIT: '4',
    })
    expect(config).toMatchObject({
      nodeEnv: 'test',
      modelRepairRetryLimit: 2,
      providerRetryLimit: 4,
    })
  })

  it('rejects invalid operational values', () => {
    expect(() =>
      loadRuntimeConfig({LINGGO_MODEL_REPAIR_RETRY_LIMIT: '-1'}),
    ).toThrow('modelRepairRetryLimit')
  })

  it('resolves storage paths through one loader', () => {
    expect(loadStorageConfig({}, '/workspace')).toEqual({
      databasePath: '/workspace/data/linggo.db',
      techniquesDir: '/workspace/data/techniques',
    })
    expect(
      loadStorageConfig({
        LINGGO_DB_PATH: '/tmp/test.db',
        LINGGO_TECHNIQUES_DIR: '/tmp/techniques',
      }),
    ).toEqual({
      databasePath: '/tmp/test.db',
      techniquesDir: '/tmp/techniques',
    })
  })
})
