import type {RequestOption} from './types'

const forbiddenNames = new Set(['__proto__', 'constructor', 'prototype'])

export function parseRequestOptionContent(content: string): unknown {
  const trimmed = content.trim()
  if (!trimmed) return ''

  try {
    return JSON.parse(trimmed)
  } catch (error) {
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      throw new Error(
        `Invalid JSON value: ${error instanceof Error ? error.message : 'parse failed'}`,
        {cause: error},
      )
    }
    return content
  }
}

export function requestOptionsBody(options?: RequestOption[]) {
  const body: Record<string, unknown> = {}
  const names = new Set<string>()

  for (const option of options ?? []) {
    const name = option.name.trim()
    if (!name) throw new Error('Request option names cannot be empty')
    if (forbiddenNames.has(name))
      throw new Error(`Request option name "${name}" is not allowed`)
    if (names.has(name))
      throw new Error(`Duplicate request option name: ${name}`)
    names.add(name)
    body[name] = parseRequestOptionContent(option.content)
  }

  return body
}

export function mergeRequestOptions(
  providerBody: Record<string, unknown>,
  options?: RequestOption[],
) {
  return mergeObjects(providerBody, requestOptionsBody(options))
}

function mergeObjects(
  providerValues: Record<string, unknown>,
  customValues: Record<string, unknown>,
): Record<string, unknown> {
  const customEntries = Object.entries(customValues).map(([name, value]) => [
    name,
    isPlainObject(providerValues[name]) && isPlainObject(value)
      ? mergeObjects(providerValues[name], value)
      : value,
  ])
  return Object.fromEntries([
    ...Object.entries(providerValues),
    ...customEntries,
  ])
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object'
}
