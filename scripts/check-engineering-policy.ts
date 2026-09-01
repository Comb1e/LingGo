import {readdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {
  checkRepository,
  loadEngineeringPolicy,
} from '../src/server/engineeringPolicy'

const root = resolve(import.meta.dirname, '..')
const files = sourceFiles(resolve(root, 'src'))

const violations = checkRepository(root, files, loadEngineeringPolicy(root))
for (const violation of violations)
  console.error(
    `${violation.file}:${violation.line} [${violation.rule}] ${violation.message}`,
  )
if (violations.length) process.exitCode = 1
else console.log(`Engineering policy passed for ${files.length} source files.`)

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name))
      return []
    return [path]
  })
}
