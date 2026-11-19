import type ts from 'typescript';
export function dependencyGraph(root: string): (file: string) => { source: ts.SourceFile; dependencies: string[] };
export function reachableModules(root: string, roots: readonly string[], excluded?: ReadonlySet<string>, read?: ReturnType<typeof dependencyGraph>): string[];
