import ts from "typescript";

// Single-file binding guard: follows initializers, destructuring and assignments
// conservatively (a version-derived binding stays marked). Symbols keep lexical
// scopes separate. No cross-file or general data-flow analysis: passing a version
// through a helper parameter/return value is a known limitation and needs review.
// Destructuring keys support static strings/templates, not dynamic expressions.
// Const comparison-function aliases use the same single-file lexical fixed point.

// Directories/globs cover future files as well as today's claim/recheck,
// scheduler, runtime admission, and both sides of daemon negotiation.
export const capabilityDecisionGlobs = [
  "packages/server/src/worker/**/*.ts",
  "packages/server/src/api/daemon-protocol/**/*.ts",
  "packages/server/src/api/helpers/{daemon*,runtime*}.ts",
  "packages/server/src/api/routers/*runtime*.ts",
  "packages/server/src/store/repos/{*task*,*runtime*}.ts",
  "packages/server/src/store/{*schedule*,*runtime*}.ts",
  "packages/server/src/*{scheduler,runtime*}.ts",
];

// Each exception is a single reviewed expression, never a file-wide exemption.
// Exact text deliberately makes changes to these expressions require review.
export const versionDecisionExceptions = [
  { file: "packages/server/src/worker/daemon-protocol-client.ts",
    expression: "compareDaemonCliVersion(this.options.cliVersion, this.serverMinCli)",
    reason: "Welcome contract minimum admission; additive features use named caps." },
  { file: "packages/server/src/api/daemon-protocol/handshake.ts",
    expression: "meetsDaemonMinCliVersion(hello.cli_version)",
    reason: "Hello contract minimum admission." },
  { file: "packages/server/src/api/helpers/daemon-protocol-upgrade.ts",
    expression: 'meetsDaemonMinCliVersion(typeof cliVersion === "string" ? cliVersion : "")',
    reason: "HTTP upgrade hint for daemons rejected by contract admission." },
  { file: "packages/server/src/store/repos/runtimes-repo.ts",
    expression: "meetsDaemonMinCliVersion(runtimeCliVersion(runtime))",
    reason: "Runtime contract admission, independent of feature selection." },
  { file: "packages/server/src/store/repos/runtimes-repo.ts",
    expression: "compareReleaseVersionParts(current, target.parts)",
    reason: "Release upgrade reconciliation avoids downgrades; no capability decision." },
  { file: "packages/server/src/store/repos/runtimes-repo.ts",
    expression: "compareReleaseVersionParts(version, target.parts)",
    reason: "Release upgrade reconciliation deduplicates queued target versions." },
  { file: "packages/server/src/api/daemon-protocol/index.ts",
    expression: "runtime.metadata.external_chats === version",
    reason: "Named external_chats capability value deduplication, not CLI identity." },
  { file: "packages/server/src/api/daemon-protocol/report-handlers.ts",
    expression: "report.version === 1",
    reason: "Storage report schema discriminator, not CLI identity." },
  { file: "packages/server/src/runtime-provider-credentials.ts",
    expression: "version !== \"v1\"",
    reason: "Encrypted credential envelope format, not CLI identity." },
  { file: "packages/server/src/store/repos/runtime-provisions-repo.ts",
    expression: "input.version !== undefined",
    reason: "Optional provisioning configuration presence check." },
  { file: "packages/server/src/store/repos/runtime-provisions-repo.ts",
    expression: "provision.version === \"latest\"",
    reason: "Provisioning package installation target, not daemon capability." },
  { file: "packages/server/src/store/repos/runtimes-repo.ts",
    expression: "cliVersion === undefined",
    reason: "Optional heartbeat metadata presence check, not a feature decision." },
  { file: "packages/server/src/store/repos/runtimes-repo.ts",
    expression: "runtimeCliVersion(runtime) === version",
    reason: "Build upgrade reconciliation identity check, not a feature decision." },
  { file: "packages/server/src/store/repos/runtimes-repo.ts",
    expression: "version === DAEMON_PROTOCOL_VERSION",
    reason: "Runtime wire protocol admission, not CLI feature inference." },
  { file: "packages/server/src/worker/daemon.ts",
    expression: "version === journal.previousVersion.replace(/^v/, \"\")",
    reason: "Update rollback confirmation of installed release identity." },
  { file: "packages/server/src/worker/outbox.ts",
    expression: "snapshot?.version === 2",
    reason: "Outbox usage snapshot schema discriminator, not CLI identity." },
];

const comparisonOperators = new Set([
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
const versionName = /^(?:cli_?version|version|build)$/i;

export function findVersionDecisions(file: string, source: string): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  // Bind only this source file; do not load imports or libraries. The checker is
  // used for lexical identity, not type inference or interprocedural analysis.
  const host = ts.createCompilerHost({ noLib: true, noResolve: true });
  host.getSourceFile = name => name === file ? tree : undefined;
  const checker = ts.createProgram([file], { noLib: true, noResolve: true }, host).getTypeChecker();
  const marked = new Set<ts.Symbol>();
  const comparisonAliases = new Set<ts.Symbol>();
  const symbol = (node: ts.Node) => checker.getSymbolAtLocation(node);
  const failures: string[] = [];
  const importedNames = new Map<ts.Symbol, string>();
  const semverBindings = new Set<string>(["semver"]);
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const binding of clause.namedBindings.elements) {
        const local = symbol(binding.name);
        if (local) importedNames.set(local, (binding.propertyName ?? binding.name).text);
      }
    }
    if (!/(?:^|\/)semver(?:\/|$)/.test(statement.moduleSpecifier.text)) continue;
    if (clause?.name) semverBindings.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) semverBindings.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) semverBindings.add(binding.name.text);
    }
  }
  const isVersionCall = (expression: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(expression)) return isVersionCall(expression.expression);
    if (ts.isIdentifier(expression)) return comparisonAliases.has(symbol(expression)!) || semverBindings.has(expression.text)
      || /^(?:compare\w*versions?\w*|meetsDaemonMinCliVersion)$/i.test(
        importedNames.get(symbol(expression)!) ?? expression.text);
    if (ts.isPropertyAccessExpression(expression)) return isVersionCall(expression.expression)
      || /compare\w*versions?/i.test(expression.name.text);
    if (ts.isElementAccessExpression(expression)) return isVersionCall(expression.expression)
      || (!!expression.argumentExpression && ts.isStringLiteralLike(expression.argumentExpression)
        && /compare\w*versions?/i.test(expression.argumentExpression.text));
    return false;
  };
  const allowed = (node: ts.Node) => versionDecisionExceptions.some(exception =>
    exception.file === file && exception.expression === node.getText(tree));
  const isVersionRead = (node: ts.Node): boolean => {
    if (ts.isIdentifier(node)) return versionName.test(node.text) || marked.has(symbol(node)!);
    if (ts.isPropertyAccessExpression(node)) return versionName.test(node.name.text);
    return ts.isElementAccessExpression(node) && !!node.argumentExpression
      && ts.isStringLiteralLike(node.argumentExpression) && versionName.test(node.argumentExpression.text);
  };
  const containsVersionRead = (node: ts.Node): boolean => {
    // Contract calls have their own exact allowlist; their operands must not
    // cause a second violation on the surrounding `< 0` comparison.
    if (allowed(node)) return false;
    // typeof produces a type tag, not the CLI/build value being inspected.
    if (ts.isTypeOfExpression(node)) return false;
    if (ts.isCallExpression(node)) return node.arguments.some(containsVersionRead)
      || (ts.isPropertyAccessExpression(node.expression) && containsVersionRead(node.expression.expression))
      || (ts.isElementAccessExpression(node.expression) && containsVersionRead(node.expression.expression));
    return isVersionRead(node) || !!ts.forEachChild(node, child => containsVersionRead(child) || undefined);
  };
  const mark = (name: ts.Identifier): void => {
    const binding = symbol(name);
    if (binding) marked.add(binding);
  };
  const isVersionKey = (key: ts.Node): boolean => {
    if (ts.isComputedPropertyName(key)) {
      return ts.isStringLiteralLike(key.expression) && versionName.test(key.expression.text);
    }
    return (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && versionName.test(key.text);
  };
  const bind = (name: ts.BindingName, derived: boolean): void => {
    if (ts.isIdentifier(name)) {
      if (derived) mark(name);
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const key = element.propertyName ?? element.name;
      const field = isVersionKey(key);
      bind(element.name, derived || field || (!!element.initializer && containsVersionRead(element.initializer)));
    }
  };
  const assign = (target: ts.Expression, derived: boolean): void => {
    if (ts.isIdentifier(target)) {
      if (derived) mark(target);
    } else if (ts.isParenthesizedExpression(target)) {
      assign(target.expression, derived);
    } else if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          assign(property.name, derived || versionName.test(property.name.text)
            || (!!property.objectAssignmentInitializer && containsVersionRead(property.objectAssignmentInitializer)));
        } else if (ts.isPropertyAssignment(property)) {
          const key = property.name;
          assign(property.initializer, derived
            || isVersionKey(key));
        } else if (ts.isSpreadAssignment(property)) assign(property.expression, derived);
      }
    } else if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) if (!ts.isOmittedExpression(element)) assign(element, derived);
    } else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      assign(target.left, derived || containsVersionRead(target.right));
    }
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) {
      bind(node.name, !!node.initializer && containsVersionRead(node.initializer));
      if (ts.isIdentifier(node.name) && node.initializer
        && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const)
        && isVersionCall(node.initializer)) {
        const binding = symbol(node.name);
        if (binding) comparisonAliases.add(binding);
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      assign(node.left, containsVersionRead(node.right));
    }
    ts.forEachChild(node, collect);
  };
  // Fixed point handles assignment chains, including a use preceding its source
  // assignment. Deliberately conservative, without control-flow/path inference.
  let previousSize: number;
  do {
    previousSize = marked.size + comparisonAliases.size;
    collect(tree);
  } while (marked.size + comparisonAliases.size !== previousSize);
  const visit = (node: ts.Node): void => {
    if (allowed(node)) return;
    const versionCall = ts.isCallExpression(node) && isVersionCall(node.expression);
    const versionComparison = ts.isBinaryExpression(node) && comparisonOperators.has(node.operatorToken.kind)
      && (containsVersionRead(node.left) || containsVersionRead(node.right));
    if (versionCall || versionComparison) {
      const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      failures.push(`${file}:${line + 1}: ${node.getText(tree)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return failures;
}
