import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { endpointCoverage } from './capabilities.js';

const routesDirectory = new URL('../routes/', import.meta.url);

/** Read route registrations, not handler calls such as request.headers.get(). */
function routesIn(source: string, name: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const routers = new Set<string>();
  const routes: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      node.initializer.expression.getText(file) === 'Hono'
    )
      routers.add(node.name.text);
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression.getText(file);
      const method = node.expression.name.text;
      if (routers.has(target) && /^(get|post|put|patch|delete|options|head|all|on)$/.test(method)) {
        const path = node.arguments[0];
        if (!path || !ts.isStringLiteral(path) || method === 'on') {
          throw new Error(`Classify dynamic route registration in ${name}: ${node.getText(file)}`);
        }
        routes.push(`${name}:${target}.${method} ${path.text}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return routes;
}

describe('web capability coverage in MCP', () => {
  it('classifies every route explicitly, so new web endpoints cannot silently miss MCP', () => {
    const routes = readdirSync(routesDirectory)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .flatMap((file) =>
        routesIn(readFileSync(new URL(file, routesDirectory), 'utf8'), file.slice(0, -3)),
      );
    expect(endpointCoverage.map((entry) => entry.route).sort()).toEqual(routes.sort());
    for (const entry of endpointCoverage) {
      expect(Boolean(entry.tool) !== Boolean(entry.reason), entry.route).toBe(true);
    }
  });

  it('only points to registered MCP tools', () => {
    const names = new Set(
      ['server.ts', 'capabilities.ts', 'agent-repo.ts'].flatMap((file) =>
        [
          ...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(
            /registerTool\(\s*'([^']+)'/g,
          ),
        ].map((match) => match[1]),
      ),
    );
    for (const entry of endpointCoverage) {
      if (entry.tool) expect(names.has(entry.tool), `${entry.route} → ${entry.tool}`).toBe(true);
    }
  });
});
