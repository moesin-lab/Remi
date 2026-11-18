import ts from "typescript";

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
  const failures: string[] = [];
  const semverBindings = new Set<string>(["semver"]);
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
      || !/(?:^|\/)semver(?:\/|$)/.test(statement.moduleSpecifier.text)) continue;
    const clause = statement.importClause;
    if (clause?.name) semverBindings.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) semverBindings.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) semverBindings.add(binding.name.text);
    }
  }
  const isVersionCall = (expression: ts.Expression): boolean => {
    if (ts.isIdentifier(expression)) return semverBindings.has(expression.text)
      || /^(?:compare\w*versions?\w*|meetsDaemonMinCliVersion)$/i.test(expression.text);
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
    if (ts.isIdentifier(node)) return versionName.test(node.text);
    if (ts.isPropertyAccessExpression(node)) return versionName.test(node.name.text);
    return ts.isElementAccessExpression(node) && !!node.argumentExpression
      && ts.isStringLiteralLike(node.argumentExpression) && versionName.test(node.argumentExpression.text);
  };
  const containsVersionRead = (node: ts.Node): boolean => {
    // Contract calls have their own exact allowlist; their operands must not
    // cause a second violation on the surrounding `< 0` comparison.
    if (allowed(node)) return false;
    if (ts.isCallExpression(node)) return node.arguments.some(containsVersionRead)
      || (ts.isPropertyAccessExpression(node.expression) && containsVersionRead(node.expression.expression))
      || (ts.isElementAccessExpression(node.expression) && containsVersionRead(node.expression.expression));
    return isVersionRead(node) || !!ts.forEachChild(node, child => containsVersionRead(child) || undefined);
  };
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
