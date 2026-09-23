import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import policy from '../../config/engineering-policy.json'
import {
  checkDocumentation,
  checkGitRuleset,
  checkSource,
  type EngineeringPolicy,
} from './engineeringPolicy'

const configuredPolicy = policy as EngineeringPolicy
let temporaryDirectory: string | undefined

afterEach(() => {
  if (temporaryDirectory)
    rmSync(temporaryDirectory, {recursive: true, force: true})
  temporaryDirectory = undefined
})

describe('engineering policy', () => {
  it('rejects direct lifecycle mutation', () => {
    const violations = checkSource(
      'src/server/games.ts',
      `function pause(game: {status: string}) { game.status = 'paused' }`,
      configuredPolicy,
    )
    expect(violations.map(({rule}) => rule)).toContain('state-machine')
  })

  it('accepts a lifecycle transition call', () => {
    expect(
      checkSource(
        'src/server/games.ts',
        `transitionGame(game, {type: 'pause'})`,
        configuredPolicy,
      ),
    ).toEqual([])
  })

  it('rejects Object.assign lifecycle mutation', () => {
    const violations = checkSource(
      'src/server/benchmarks.ts',
      `Object.assign(run, {status: 'paused'})`,
      configuredPolicy,
    )
    expect(violations.map(({rule}) => rule)).toContain('state-machine')
  })

  it('rejects environment access outside configuration', () => {
    const violations = checkSource(
      'src/server/database.ts',
      `const path = process.env.LINGGO_DB_PATH`,
      configuredPolicy,
    )
    expect(violations.map(({rule}) => rule)).toContain('configuration')
  })

  it('rejects bypassing the provider facade', () => {
    const violations = checkSource(
      'src/server/games.ts',
      `await adapter.requestTurn(request, signal)`,
      configuredPolicy,
    )
    expect(violations.map(({rule}) => rule)).toContain('generic-interface')
  })

  it('accepts documentation with every configured heading and marker', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'linggo-policy-'))
    const documentation = {
      ...configuredPolicy,
      documentationRules: [
        {
          file: 'docs/architecture.md',
          headings: ['# Architecture', '## Purpose'],
          markers: ['```mermaid'],
        },
      ],
    }
    mkdirSync(join(temporaryDirectory, 'docs'))
    writeFileSync(
      join(temporaryDirectory, 'docs/architecture.md'),
      '# Architecture\n\n## Purpose\n\n```mermaid\nflowchart LR\n```\n',
    )

    expect(checkDocumentation(temporaryDirectory, documentation)).toEqual([])
  })

  it('rejects missing documentation and incomplete required content', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'linggo-policy-'))
    const documentation = {
      ...configuredPolicy,
      documentationRules: [
        {
          file: 'docs/architecture.md',
          headings: ['# Architecture', '## Purpose'],
          markers: ['stateDiagram-v2'],
        },
      ],
    }
    expect(checkDocumentation(temporaryDirectory, documentation)).toHaveLength(
      1,
    )

    mkdirSync(join(temporaryDirectory, 'docs'))
    writeFileSync(
      join(temporaryDirectory, 'docs/architecture.md'),
      '# Architecture\n',
    )
    expect(
      checkDocumentation(temporaryDirectory, documentation).map(
        ({message}) => message,
      ),
    ).toEqual([
      'required documentation content is missing: ## Purpose',
      'required documentation content is missing: stateDiagram-v2',
    ])
  })

  it('keeps the GitHub commit pattern aligned with configured policy', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'linggo-policy-'))
    const rulesetFile = join(temporaryDirectory, '.github/rulesets/main.json')
    mkdirSync(join(temporaryDirectory, '.github/rulesets'), {recursive: true})
    writeFileSync(
      rulesetFile,
      JSON.stringify({
        rules: [
          {
            type: 'commit_message_pattern',
            parameters: {
              pattern: configuredPolicy.gitRules.commitSubjectPattern,
            },
          },
        ],
      }),
    )
    expect(checkGitRuleset(temporaryDirectory, configuredPolicy)).toEqual([])

    writeFileSync(
      rulesetFile,
      JSON.stringify({
        rules: [
          {type: 'commit_message_pattern', parameters: {pattern: '^old$'}},
        ],
      }),
    )
    expect(checkGitRuleset(temporaryDirectory, configuredPolicy)).toHaveLength(
      1,
    )
  })
})
