import type {ProviderKind} from './types'

export interface ProviderCapabilities {
  ordinaryPlay: boolean
  textGeneration: boolean
  benchmarks: boolean
  research: boolean
  temperature: boolean
  reasoningControls: boolean
  requestOptions: boolean
  stylePrompt: boolean
}

const generativeCapabilities: ProviderCapabilities = {
  ordinaryPlay: true,
  textGeneration: true,
  benchmarks: true,
  research: true,
  temperature: true,
  reasoningControls: true,
  requestOptions: true,
  stylePrompt: true,
}

export const providerCapabilities = {
  openai: generativeCapabilities,
  anthropic: generativeCapabilities,
  google: generativeCapabilities,
  deepseek: generativeCapabilities,
  compatible: generativeCapabilities,
  fake: generativeCapabilities,
  typesafe: {
    ordinaryPlay: true,
    textGeneration: false,
    benchmarks: false,
    research: false,
    temperature: false,
    reasoningControls: false,
    requestOptions: false,
    stylePrompt: true,
  },
} as const satisfies Record<ProviderKind, ProviderCapabilities>

export function capabilitiesForProvider(kind: ProviderKind) {
  return providerCapabilities[kind]
}
