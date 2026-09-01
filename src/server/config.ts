import {z} from 'zod'
import {existsSync} from 'node:fs'
import {DEFAULT_NOTEBOOK_TOKEN_BUDGET} from '../shared/constants'

const booleanEnv = z
  .enum(['0', '1', 'true', 'false'])
  .transform((value) => value === '1' || value === 'true')

export const runtimeConfigSchema = z.object({
  port: z.number().int().min(1).max(65_535).default(4173),
  sseKeepAliveMs: z.number().int().positive().default(15_000),
  defaultKataGoVisits: z.number().int().min(25).max(100_000).default(5_000),
  benchmarkTrainingVisits: z
    .number()
    .int()
    .min(25)
    .max(100_000)
    .default(10_000),
  providerTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60_000),
  providerFirstTokenTimeoutMs: z.number().int().positive().default(60_000),
  providerRetryLimit: z.number().int().positive().default(5),
  modelRepairRetryLimit: z.number().int().nonnegative().default(3),
  proxyConnectTimeoutMs: z.number().int().positive().default(3_000),
  notebookTokenBudget: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_NOTEBOOK_TOKEN_BUDGET),
  benchmarkProblemAttempts: z.number().int().positive().default(5),
  fakeKatago: z.boolean().default(false),
})

function envNumber(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]
  return value === undefined ? undefined : Number(value)
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = runtimeConfigSchema.safeParse({
    port: envNumber(env, 'PORT'),
    sseKeepAliveMs: envNumber(env, 'LINGGO_SSE_KEEP_ALIVE_MS'),
    defaultKataGoVisits: envNumber(env, 'LINGGO_DEFAULT_KATAGO_VISITS'),
    benchmarkTrainingVisits: envNumber(
      env,
      'LINGGO_DEFAULT_BENCHMARK_TRAINING_VISITS',
    ),
    providerTimeoutMs: envNumber(env, 'LINGGO_PROVIDER_TIMEOUT_MS'),
    providerFirstTokenTimeoutMs: envNumber(
      env,
      'LINGGO_PROVIDER_FIRST_TOKEN_TIMEOUT_MS',
    ),
    providerRetryLimit: envNumber(env, 'LINGGO_PROVIDER_RETRY_LIMIT'),
    modelRepairRetryLimit: envNumber(env, 'LINGGO_MODEL_REPAIR_RETRY_LIMIT'),
    proxyConnectTimeoutMs: envNumber(env, 'LINGGO_PROXY_CONNECT_TIMEOUT_MS'),
    notebookTokenBudget: envNumber(env, 'LINGGO_NOTEBOOK_TOKEN_BUDGET'),
    benchmarkProblemAttempts: envNumber(
      env,
      'LINGGO_BENCHMARK_PROBLEM_ATTEMPTS',
    ),
    fakeKatago: env.LINGGO_FAKE_KATAGO
      ? booleanEnv.parse(env.LINGGO_FAKE_KATAGO)
      : undefined,
  })
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid LingGo configuration: ${details}`)
  }
  return parsed.data
}

export const runtimeConfig = loadRuntimeConfig()

export const KATAGO_LEGACY_DEFAULTS = {
  executablePath: '/home/comb1e/tools/KataGo/cpp/katago',
  modelPath:
    '/root/.local/share/pipx/venvs/katrain/lib/python3.12/site-packages/katrain/models/b10c384h6nbttflrs.bin.gz',
  configPath:
    '/root/.local/share/pipx/venvs/katrain/lib/python3.12/site-packages/katrain/KataGo/analysis_config.cfg',
} as const

export const KATAGO_PORTABLE_DEFAULTS = {
  executablePath: 'katago',
  modelPath: 'model.bin.gz',
  configPath: 'analysis_config.cfg',
} as const

/**
 * Resolve the built-in KataGo paths without replacing an installed local
 * bundle with placeholders that cannot be launched from the project cwd.
 */
export function resolveKataGoDefaults(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
) {
  const executablePath =
    env.LINGGO_KATAGO_EXECUTABLE_PATH ?? env.LINGGO_KATAGO_PATH
  const modelPath = env.LINGGO_KATAGO_MODEL_PATH ?? env.LINGGO_KATAGO_MODEL
  const configPath = env.LINGGO_KATAGO_CONFIG_PATH ?? env.LINGGO_KATAGO_CONFIG
  const hasOverrides = Boolean(executablePath || modelPath || configPath)
  const hasLegacyInstall = [
    KATAGO_LEGACY_DEFAULTS.executablePath,
    KATAGO_LEGACY_DEFAULTS.modelPath,
    KATAGO_LEGACY_DEFAULTS.configPath,
  ].every((path) => exists(path))
  const defaults =
    !hasOverrides && hasLegacyInstall
      ? KATAGO_LEGACY_DEFAULTS
      : KATAGO_PORTABLE_DEFAULTS
  return {
    executablePath: executablePath ?? defaults.executablePath,
    modelPath: modelPath ?? defaults.modelPath,
    configPath: configPath ?? defaults.configPath,
  }
}
