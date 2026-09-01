import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

const repository = 'Comb1e/LingGo'
const desired = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../.github/rulesets/main.json'),
    'utf8',
  ),
)
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
const apply = process.argv.includes('--apply')
if (apply && !token)
  throw new Error(
    'GH_TOKEN or GITHUB_TOKEN with repository Administration write permission is required',
  )

const headers: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2026-03-10',
  'User-Agent': 'LingGo-policy-audit',
}
if (token) headers.Authorization = `Bearer ${token}`

const rulesets = await request(`/repos/${repository}/rulesets`)
const currentSummary = rulesets.find(
  (ruleset: {name: string}) => ruleset.name === desired.name,
)

if (apply) {
  const path = currentSummary
    ? `/repos/${repository}/rulesets/${currentSummary.id}`
    : `/repos/${repository}/rulesets`
  await request(path, currentSummary ? 'PUT' : 'POST', desired)
  console.log(`${currentSummary ? 'Updated' : 'Created'} ${desired.name}.`)
  process.exit(0)
}

if (!currentSummary) {
  console.error(`GitHub ruleset ${JSON.stringify(desired.name)} is missing.`)
  process.exit(1)
}
const current = await request(
  `/repos/${repository}/rulesets/${currentSummary.id}`,
)
const differences = compareSubset(desired, current)
if (differences.length) {
  console.error(`GitHub ruleset drift:\n${differences.join('\n')}`)
  process.exit(1)
}
console.log(`GitHub ruleset ${JSON.stringify(desired.name)} matches policy.`)

async function request(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: body ? {...headers, 'Content-Type': 'application/json'} : headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!response.ok)
    throw new Error(
      `GitHub API ${method} ${path} failed: ${response.status} ${await response.text()}`,
    )
  return response.json()
}

function compareSubset(
  expected: unknown,
  actual: unknown,
  path = '$',
): string[] {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: expected an array`]
    return expected.flatMap((value, index) =>
      compareSubset(value, actual[index], `${path}[${index}]`),
    )
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object')
      return [`${path}: expected an object`]
    return Object.entries(expected).flatMap(([key, value]) =>
      compareSubset(
        value,
        (actual as Record<string, unknown>)[key],
        `${path}.${key}`,
      ),
    )
  }
  return Object.is(expected, actual)
    ? []
    : [
        `${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      ]
}
