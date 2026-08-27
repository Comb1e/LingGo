import {analyzeResearchDirectory} from '../src/server/researchAnalysis'
const input = process.argv[process.argv.indexOf('--input') + 1]
if (!input)
  throw new Error('Usage: pnpm research:analyze -- --input data/experiments/id')
console.log(JSON.stringify(await analyzeResearchDirectory(input), null, 2))
