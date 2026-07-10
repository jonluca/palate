import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export interface WrappedStatsProductionSqlCallCounts {
  readonly allTime: number;
  readonly selectedYear: number;
  readonly promiseEntries: number;
  readonly databaseCallSites: number;
}

const DATABASE_QUERY_METHODS = new Set(["getAllAsync", "getFirstAsync"]);

function isDatabaseQueryCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) {
    return false;
  }

  return (
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "database" &&
    DATABASE_QUERY_METHODS.has(node.expression.name.text)
  );
}

function findGetWrappedStats(sourceFile: ts.SourceFile): ts.FunctionDeclaration {
  let result: ts.FunctionDeclaration | undefined;
  sourceFile.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "getWrappedStats") {
      result = node;
    }
  });
  if (!result?.body) {
    throw new Error("Could not find the production getWrappedStats function body.");
  }
  return result;
}

function findQueryPromiseArray(functionNode: ts.FunctionDeclaration): ts.ArrayLiteralExpression {
  const arrays: ts.ArrayLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Promise" &&
      node.expression.name.text === "all" &&
      node.arguments.length === 1 &&
      ts.isArrayLiteralExpression(node.arguments[0])
    ) {
      arrays.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(functionNode.body!);
  if (arrays.length !== 1) {
    throw new Error(`Expected exactly one Promise.all query array in getWrappedStats; found ${arrays.length}.`);
  }
  return arrays[0]!;
}

function collectDatabaseQueryCalls(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (current: ts.Node): void => {
    if (isDatabaseQueryCall(current)) {
      calls.push(current);
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return calls;
}

function countExecutedDatabaseCalls(node: ts.Node, hasSelectedYear: boolean): number {
  if (isDatabaseQueryCall(node)) {
    return 1;
  }
  if (ts.isConditionalExpression(node) && ts.isIdentifier(node.condition) && node.condition.text === "year") {
    return countExecutedDatabaseCalls(hasSelectedYear ? node.whenTrue : node.whenFalse, hasSelectedYear);
  }
  if (ts.isFunctionLike(node)) {
    const nestedCalls = collectDatabaseQueryCalls(node);
    if (nestedCalls.length > 0) {
      throw new Error("A Wrapped Stats database call is nested in a callback, so static call accounting is ambiguous.");
    }
    return 0;
  }

  let count = 0;
  ts.forEachChild(node, (child) => {
    count += countExecutedDatabaseCalls(child, hasSelectedYear);
  });
  return count;
}

/**
 * Counts the actual production SQLite calls in getWrappedStats from its AST.
 *
 * The guard rejects query calls outside the single Promise.all plan and calls
 * hidden inside callbacks, where one static call site could execute N times.
 */
export function countWrappedStatsProductionSqlCalls(
  statsSourcePath: string = fileURLToPath(new URL("../utils/db/stats.ts", import.meta.url)),
): WrappedStatsProductionSqlCallCounts {
  const sourceText = readFileSync(statsSourcePath, "utf8");
  const sourceFile = ts.createSourceFile(statsSourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const functionNode = findGetWrappedStats(sourceFile);
  const queryArray = findQueryPromiseArray(functionNode);
  const functionCalls = collectDatabaseQueryCalls(functionNode.body!);
  const planCalls = collectDatabaseQueryCalls(queryArray);
  const planPositions = new Set(planCalls.map((call) => call.pos));
  const callsOutsidePlan = functionCalls.filter((call) => !planPositions.has(call.pos));
  if (callsOutsidePlan.length > 0) {
    throw new Error(`getWrappedStats has ${callsOutsidePlan.length} database call(s) outside its query plan.`);
  }

  const count = (hasSelectedYear: boolean) =>
    queryArray.elements.reduce((total, element) => total + countExecutedDatabaseCalls(element, hasSelectedYear), 0);

  return {
    allTime: count(false),
    selectedYear: count(true),
    promiseEntries: queryArray.elements.length,
    databaseCallSites: planCalls.length,
  };
}
