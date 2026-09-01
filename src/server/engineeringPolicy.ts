import {readFileSync} from 'node:fs'
import {relative, resolve} from 'node:path'
import ts from 'typescript'

export interface EngineeringPolicy {
  version: number
  source: string
  stateMutationRules: Array<{file: string; properties: string[]}>
  stateMachineRoot: string
  environmentAccess: {
    allowedFiles: string[]
    allowedNodeEnvFiles: string[]
  }
  configurationFiles: string[]
  providerFacadeFile: string
  providerPrimitiveMethods: string[]
  constantUseThreshold: number
  literalFileThreshold: number
  literalExemptions: {numbers: number[]; strings: string[]}
  exclusions: Array<{
    rule: string
    path: string
    rationale: string
    owner: string
    issue: string
    expires: string
  }>
}

export interface PolicyViolation {
  rule: string
  file: string
  line: number
  message: string
}

export function loadEngineeringPolicy(root: string): EngineeringPolicy {
  return JSON.parse(
    readFileSync(resolve(root, 'config/engineering-policy.json'), 'utf8'),
  )
}

export function checkSource(
  file: string,
  text: string,
  policy: EngineeringPolicy,
): PolicyViolation[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const violations: PolicyViolation[] = []
  const mutationRule = policy.stateMutationRules.find(
    (rule) => rule.file === file,
  )

  const report = (rule: string, node: ts.Node, message: string) => {
    const {line} = source.getLineAndCharacterOfPosition(node.getStart(source))
    violations.push({rule, file, line: line + 1, message})
  }

  const visit = (node: ts.Node) => {
    if (
      mutationRule &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      ts.isPropertyAccessExpression(node.left) &&
      mutationRule.properties.includes(node.left.name.text)
    )
      report(
        'state-machine',
        node,
        `change ${node.left.name.text} through a state-machine transition`,
      )

    if (
      mutationRule &&
      ts.isCallExpression(node) &&
      isObjectAssign(node.expression)
    ) {
      const protectedProperty = node.arguments
        .slice(1)
        .filter(ts.isObjectLiteralExpression)
        .flatMap((argument) => argument.properties)
        .find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            mutationRule.properties.includes(property.name.text),
        )
      if (protectedProperty)
        report(
          'state-machine',
          protectedProperty,
          `change ${protectedProperty.name.getText(source)} through a state-machine transition`,
        )
    }

    if (isProcessEnvAccess(node)) {
      const allowed = policy.environmentAccess.allowedFiles.includes(file)
      const nodeEnvOnly =
        policy.environmentAccess.allowedNodeEnvFiles.includes(file) &&
        processEnvKey(node) === 'NODE_ENV'
      if (!allowed && !nodeEnvOnly)
        report(
          'configuration',
          node,
          'read environment variables through the runtime config loader',
        )
    }

    if (
      file !== policy.providerFacadeFile &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      policy.providerPrimitiveMethods.includes(node.expression.name.text)
    )
      report(
        'generic-interface',
        node,
        `call requestLlm instead of ${node.expression.name.text}`,
      )

    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

export function checkRepository(
  root: string,
  files: string[],
  policy: EngineeringPolicy,
) {
  const violations: PolicyViolation[] = []
  const importedConstants = new Map<string, Set<string>>()
  const literalFiles = new Map<string, Set<string>>()

  for (const absolute of files) {
    const file = normalize(relative(root, absolute))
    const text = readFileSync(absolute, 'utf8')
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )
    violations.push(...checkSource(file, text, policy))
    collectImports(file, source, importedConstants)
    collectLiterals(file, source, policy, literalFiles)
  }

  for (const [declaration, consumers] of importedConstants) {
    const [file] = declaration.split('#')
    if (
      consumers.size >= policy.constantUseThreshold &&
      !policy.configurationFiles.includes(file)
    )
      violations.push({
        rule: 'configuration',
        file,
        line: 1,
        message: `${declaration.split('#')[1]} is used by ${consumers.size} modules; move it to configuration`,
      })
  }

  for (const [literal, consumers] of literalFiles) {
    if (consumers.size < policy.literalFileThreshold) continue
    const first = [...consumers].sort()[0]
    violations.push({
      rule: 'configuration',
      file: first,
      line: 1,
      message: `literal ${literal} appears in ${consumers.size} production modules; centralize or explicitly classify it`,
    })
  }

  violations.push(...validateExclusions(policy))
  return violations.filter((violation) => !isExcluded(violation, policy))
}

function isProcessEnvAccess(node: ts.Node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  )
}

function isObjectAssign(node: ts.LeftHandSideExpression) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'Object' &&
    node.name.text === 'assign'
  )
}

function processEnvKey(node: ts.Node) {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent)) return parent.name.text
  if (
    ts.isElementAccessExpression(parent) &&
    parent.argumentExpression &&
    ts.isStringLiteral(parent.argumentExpression)
  )
    return parent.argumentExpression.text
  return undefined
}

function collectImports(
  file: string,
  source: ts.SourceFile,
  imports: Map<string, Set<string>>,
) {
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    const module = resolveImport(file, statement.moduleSpecifier.text)
    for (const element of statement.importClause.namedBindings.elements) {
      const name = element.propertyName?.text ?? element.name.text
      if (!/^[A-Z][A-Z0-9_]+$/.test(name)) continue
      const key = `${module}#${name}`
      const consumers = imports.get(key) ?? new Set<string>()
      consumers.add(file)
      imports.set(key, consumers)
    }
  }
}

function collectLiterals(
  file: string,
  source: ts.SourceFile,
  policy: EngineeringPolicy,
  literals: Map<string, Set<string>>,
) {
  if (policy.configurationFiles.includes(file)) return
  const visit = (node: ts.Node) => {
    let key: string | undefined
    if (
      ts.isNumericLiteral(node) &&
      !policy.literalExemptions.numbers.includes(Number(node.text))
    )
      key = `number:${node.text.replaceAll('_', '')}`
    if (key) {
      const consumers = literals.get(key) ?? new Set<string>()
      consumers.add(file)
      literals.set(key, consumers)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}

function validateExclusions(policy: EngineeringPolicy): PolicyViolation[] {
  const today = new Date().toISOString().slice(0, 10)
  const maximum = new Date()
  maximum.setUTCDate(maximum.getUTCDate() + 90)
  const maximumExpiry = maximum.toISOString().slice(0, 10)
  return policy.exclusions.flatMap((exclusion) => {
    const complete =
      exclusion.rule &&
      exclusion.path &&
      exclusion.rationale &&
      exclusion.owner &&
      /^https:\/\//.test(exclusion.issue) &&
      /^\d{4}-\d{2}-\d{2}$/.test(exclusion.expires)
    if (
      complete &&
      exclusion.expires >= today &&
      exclusion.expires <= maximumExpiry
    )
      return []
    return [
      {
        rule: 'policy-exclusion',
        file: 'config/engineering-policy.json',
        line: 1,
        message: `invalid or expired exclusion for ${exclusion.path || '(missing path)'}`,
      },
    ]
  })
}

function isExcluded(violation: PolicyViolation, policy: EngineeringPolicy) {
  return policy.exclusions.some(
    (exclusion) =>
      exclusion.rule === violation.rule && exclusion.path === violation.file,
  )
}

function resolveImport(importer: string, specifier: string) {
  if (!specifier.startsWith('.')) return specifier
  const parts = importer.split('/')
  parts.pop()
  for (const part of specifier.split('/')) {
    if (part === '.' || !part) continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${parts.join('/')}.ts`.replace(/\.tsx?\.ts$/, '.ts')
}

function normalize(value: string) {
  return value.replaceAll('\\', '/')
}
