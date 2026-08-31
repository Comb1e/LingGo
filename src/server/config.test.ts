import {describe, expect, it} from 'vitest'
import {
  KATAGO_LEGACY_DEFAULTS,
  KATAGO_PORTABLE_DEFAULTS,
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
