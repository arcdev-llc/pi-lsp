/**
 * Unit tests for index.ts formatting functions
 */

// ============================================================================
// Test utilities
// ============================================================================

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = [];

function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn });
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(message || `Expected ${e}, got ${a}`);
}

// ============================================================================
// Import the module to test internal functions
// We need to test via the execute function since formatters are private
// Or we can extract and test the logic directly
// ============================================================================

import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { isLeft, isRight } from "fp-ts/lib/Either.js";
import { isNone, isSome } from "fp-ts/lib/Option.js";
import { LSPManager, uriToPath, decodeFileUri, findSymbolPosition, findSymbolPositionOption, formatDiagnostic, filterDiagnosticsBySeverity, collectSymbols, toLegacyFileDiagnosticsResult, toLegacyTouchFileResult } from "../src/lsp-core.ts";
import { formatToolExecutionError, isAbortedError, normalizeExecuteArgsResult, resolveValidatedCommand, toToolExecutionError, validateLspCommand } from "../src/lsp-tool-helpers.ts";

// ============================================================================
// uriToPath tests
// ============================================================================

test("uriToPath: converts file:// URI to path", () => {
  const result = uriToPath("file:///Users/test/file.ts");
  assertEqual(result, "/Users/test/file.ts");
});

test("uriToPath: handles encoded characters", () => {
  const result = uriToPath("file:///Users/test/my%20file.ts");
  assertEqual(result, "/Users/test/my file.ts");
});

test("uriToPath: passes through non-file URIs", () => {
  const result = uriToPath("/some/path.ts");
  assertEqual(result, "/some/path.ts");
});

test("uriToPath: handles invalid URIs gracefully", () => {
  const result = uriToPath("not-a-valid-uri");
  assertEqual(result, "not-a-valid-uri");
});

test("decodeFileUri: returns Right for valid file URI", () => {
  const result = decodeFileUri("file:///Users/test/file.ts");
  if (!isRight(result)) throw new Error("Expected decodeFileUri to return Right");
  assertEqual(result.right, "/Users/test/file.ts");
});

test("decodeFileUri: returns Left for invalid file URI", () => {
  const result = decodeFileUri("file://%ZZ");
  if (!isLeft(result)) throw new Error("Expected decodeFileUri to return Left");
  assertEqual(result.left._tag, "UriToPathError");
  assertEqual(result.left.uri, "file://%ZZ");
});

// ============================================================================
// findSymbolPosition tests
// ============================================================================

test("findSymbolPosition: finds exact match", () => {
  const symbols = [
    { name: "greet", range: { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } }, selectionRange: { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } }, kind: 12, children: [] },
    { name: "hello", range: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } }, selectionRange: { start: { line: 10, character: 0 }, end: { line: 10, character: 5 } }, kind: 12, children: [] },
  ];
  const pos = findSymbolPosition(symbols as any, "greet");
  assertEqual(pos, { line: 5, character: 10 });
});

test("findSymbolPosition: finds partial match", () => {
  const symbols = [
    { name: "getUserName", range: { start: { line: 3, character: 0 }, end: { line: 3, character: 11 } }, selectionRange: { start: { line: 3, character: 0 }, end: { line: 3, character: 11 } }, kind: 12, children: [] },
  ];
  const pos = findSymbolPosition(symbols as any, "user");
  assertEqual(pos, { line: 3, character: 0 });
});

test("findSymbolPosition: prefers exact over partial", () => {
  const symbols = [
    { name: "userName", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } }, selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } }, kind: 12, children: [] },
    { name: "user", range: { start: { line: 5, character: 0 }, end: { line: 5, character: 4 } }, selectionRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 4 } }, kind: 12, children: [] },
  ];
  const pos = findSymbolPosition(symbols as any, "user");
  assertEqual(pos, { line: 5, character: 0 });
});

test("findSymbolPosition: searches nested children", () => {
  const symbols = [
    { 
      name: "MyClass", 
      range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } }, 
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } }, 
      kind: 5,
      children: [
        { name: "myMethod", range: { start: { line: 2, character: 2 }, end: { line: 4, character: 2 } }, selectionRange: { start: { line: 2, character: 2 }, end: { line: 2, character: 10 } }, kind: 6, children: [] },
      ]
    },
  ];
  const pos = findSymbolPosition(symbols as any, "myMethod");
  assertEqual(pos, { line: 2, character: 2 });
});

test("findSymbolPosition: returns null for no match", () => {
  const symbols = [
    { name: "foo", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, kind: 12, children: [] },
  ];
  const pos = findSymbolPosition(symbols as any, "bar");
  assertEqual(pos, null);
});

test("findSymbolPosition: case insensitive", () => {
  const symbols = [
    { name: "MyFunction", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, kind: 12, children: [] },
  ];
  const pos = findSymbolPosition(symbols as any, "myfunction");
  assertEqual(pos, { line: 0, character: 0 });
});

test("findSymbolPositionOption: returns Some for exact match", () => {
  const symbols = [
    { name: "greet", range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } }, selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } }, kind: 12, children: [] },
  ];
  const pos = findSymbolPositionOption(symbols as any, "greet");
  if (!isSome(pos)) throw new Error("Expected findSymbolPositionOption to return Some");
  assertEqual(pos.value, { line: 1, character: 2 });
});

test("findSymbolPositionOption: returns None for blank query", () => {
  const symbols = [
    { name: "greet", range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } }, selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } }, kind: 12, children: [] },
  ];
  const pos = findSymbolPositionOption(symbols as any, "   ");
  if (!isNone(pos)) throw new Error("Expected findSymbolPositionOption to return None");
});

// ============================================================================
// normalizeExecuteArgsResult tests
// ============================================================================

test("normalizeExecuteArgsResult: supports runtime >= 0.51 argument order", () => {
  const signal = new AbortController().signal;
  const onUpdate = () => {};
  const ctx = { cwd: "/tmp/project" };

  const result = normalizeExecuteArgsResult(signal, onUpdate, ctx);
  if (!isRight(result)) throw new Error("Expected normalizeExecuteArgsResult to return Right");
  assertEqual(result.right.ctx, ctx);
  assertEqual(result.right.signal, signal);
  assertEqual(typeof result.right.onUpdate, "function");
});

test("normalizeExecuteArgsResult: supports runtime <= 0.50 argument order", () => {
  const signal = new AbortController().signal;
  const onUpdate = () => {};
  const ctx = { cwd: "/tmp/project" };

  const result = normalizeExecuteArgsResult(onUpdate, ctx, signal);
  if (!isRight(result)) throw new Error("Expected normalizeExecuteArgsResult to return Right");
  assertEqual(result.right.ctx, ctx);
  assertEqual(result.right.signal, signal);
  assertEqual(typeof result.right.onUpdate, "function");
});

test("normalizeExecuteArgsResult: returns Left for invalid execution context", () => {
  const result = normalizeExecuteArgsResult(undefined, undefined, undefined);
  if (!isLeft(result)) throw new Error("Expected normalizeExecuteArgsResult to return Left");
  assertEqual(result.left._tag, "InvalidExecutionContextError");
});

// ============================================================================
// validateLspCommand / resolveValidatedCommand tests
// ============================================================================

test("validateLspCommand: validates direct-position definition command", () => {
  const result = validateLspCommand({ action: "definition", file: "src/lsp-tool.ts", line: 10, column: 4 });
  if (!isRight(result)) throw new Error("Expected validateLspCommand to return Right");
  assertEqual(result.right.action, "definition");
  assertEqual(result.right.file, "src/lsp-tool.ts");
  if (!("position" in result.right)) throw new Error("Expected position in validated command");
  assertEqual(result.right.position._tag, "DirectPosition");
});

test("validateLspCommand: validates query-based definition command", () => {
  const result = validateLspCommand({ action: "definition", file: "src/lsp-tool.ts", query: "execute" });
  if (!isRight(result)) throw new Error("Expected validateLspCommand to return Right");
  if (!("position" in result.right)) throw new Error("Expected position in validated command");
  assertEqual(result.right.position._tag, "QueryPosition");
  assertEqual(result.right.position.query, "execute");
});

test("validateLspCommand: returns Left when file is missing", () => {
  const result = validateLspCommand({ action: "definition", line: 1, column: 1 } as any);
  if (!isLeft(result)) throw new Error("Expected validateLspCommand to return Left");
  assertEqual(result.left._tag, "ValidationError");
  assertEqual(result.left.message, 'Action "definition" requires a file path.');
});

test("validateLspCommand: returns Left when rename newName is missing", () => {
  const result = validateLspCommand({ action: "rename", file: "src/lsp-tool.ts", line: 1, column: 1 });
  if (!isLeft(result)) throw new Error("Expected validateLspCommand to return Left");
  assertEqual(result.left.message, 'Action "rename" requires a "newName" parameter.');
});

test("validateLspCommand: returns Left when workspace-diagnostics files are missing", () => {
  const result = validateLspCommand({ action: "workspace-diagnostics" });
  if (!isLeft(result)) throw new Error("Expected validateLspCommand to return Left");
  assertEqual(result.left.message, 'Action "workspace-diagnostics" requires a "files" array.');
});

test("validateLspCommand: returns Left when position and query are missing", () => {
  const result = validateLspCommand({ action: "hover", file: "src/lsp-tool.ts" });
  if (!isLeft(result)) throw new Error("Expected validateLspCommand to return Left");
  assertEqual(result.left.message, 'Action "hover" requires line/column or a query matching a symbol.');
});

test("resolveValidatedCommand: resolves query position into executable command", async () => {
  const validated = validateLspCommand({ action: "definition", file: "src/lsp-tool.ts", query: "execute" });
  if (!isRight(validated)) throw new Error("Expected validateLspCommand to return Right");

  const result = await resolveValidatedCommand(validated.right, {
    resolvePosition: async () => ({ line: 42, column: 7 }),
  })();

  if (!isRight(result)) throw new Error("Expected resolveValidatedCommand to return Right");
  assertEqual(result.right.action, "definition");
  if (!("fromQuery" in result.right)) throw new Error("Expected resolved position metadata");
  assertEqual(result.right.fromQuery, true);
  assertEqual(result.right.line, 42);
  assertEqual(result.right.column, 7);
});

test("resolveValidatedCommand: returns Left when query cannot be resolved", async () => {
  const validated = validateLspCommand({ action: "definition", file: "src/lsp-tool.ts", query: "missingSymbol" });
  if (!isRight(validated)) throw new Error("Expected validateLspCommand to return Right");

  const result = await resolveValidatedCommand(validated.right, {
    resolvePosition: async () => null,
  })();

  if (!isLeft(result)) throw new Error("Expected resolveValidatedCommand to return Left");
  assertEqual(result.left._tag, "PositionResolutionError");
  assertEqual(result.left.message, 'Action "definition" requires line/column or a query matching a symbol.');
});

test("resolveValidatedCommand: returns CancelledError when resolution is aborted", async () => {
  const validated = validateLspCommand({ action: "definition", file: "src/lsp-tool.ts", query: "missingSymbol" });
  if (!isRight(validated)) throw new Error("Expected validateLspCommand to return Right");

  const result = await resolveValidatedCommand(validated.right, {
    resolvePosition: async () => {
      throw new Error("aborted");
    },
  })();

  if (!isLeft(result)) throw new Error("Expected resolveValidatedCommand to return Left");
  assertEqual(result.left._tag, "CancelledError");
  assertEqual(result.left.message, "Cancelled");
});

// ============================================================================
// tool execution error tests
// ============================================================================

test("isAbortedError: detects aborted error", () => {
  assertEqual(isAbortedError(new Error("aborted")), true);
  assertEqual(isAbortedError(new Error("other")), false);
});

test("toToolExecutionError: maps aborted errors to CancelledError", () => {
  const result = toToolExecutionError(new Error("aborted"), "should be ignored");
  assertEqual(result._tag, "CancelledError");
  assertEqual(result.message, "Cancelled");
});

test("formatToolExecutionError: returns error message", () => {
  const result = formatToolExecutionError({ _tag: "ValidationError", message: "Bad input" });
  assertEqual(result, "Bad input");
});

// ============================================================================
// touchFile result adapter tests
// ============================================================================

test("toLegacyTouchFileResult: maps success result", () => {
  const result = toLegacyTouchFileResult({ status: "success", diagnostics: [] });
  assertEqual(result, { diagnostics: [], receivedResponse: true });
});

test("toLegacyTouchFileResult: maps unsupported result", () => {
  const result = toLegacyTouchFileResult({ status: "unsupported", diagnostics: [], error: "No LSP" });
  assertEqual(result, { diagnostics: [], receivedResponse: false, unsupported: true, error: "No LSP" });
});

test("toLegacyTouchFileResult: maps timeout result", () => {
  const result = toLegacyTouchFileResult({ status: "timeout", diagnostics: [], error: "LSP did not respond" });
  assertEqual(result, { diagnostics: [], receivedResponse: false, error: "LSP did not respond" });
});

test("toLegacyFileDiagnosticsResult: maps success and unsupported items", () => {
  const result = toLegacyFileDiagnosticsResult({
    items: [
      { file: "a.ts", diagnostics: [], status: "success" },
      { file: "b.ts", diagnostics: [], status: "unsupported", error: "No LSP" },
    ],
  });

  assertEqual(result, {
    items: [
      { file: "a.ts", diagnostics: [], status: "ok" },
      { file: "b.ts", diagnostics: [], status: "unsupported", error: "No LSP" },
    ],
  });
});

// ============================================================================
// LSPManager unhappy-path boundary tests
// ============================================================================

test("LSPManager.touchFileAndWaitResult: missing file returns error status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lsp-core-unit-"));
  const manager = new LSPManager(dir);

  try {
    const result = await manager.touchFileAndWaitResult(join(dir, "missing.ts"), 100);
    assertEqual(result.status, "error");
    if (result.status !== "error") throw new Error("Expected error result");
    assertEqual(result.error, "File not found");
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("LSPManager.touchFileAndWaitResult: unsupported file returns unsupported status", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lsp-core-unit-"));
  const manager = new LSPManager(dir);

  try {
    const file = join(dir, "standalone.ts");
    await writeFile(file, "const x = 1;\n");
    const result = await manager.touchFileAndWaitResult(file, 100);
    assertEqual(result.status, "unsupported");
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("LSPManager.getDiagnosticsForFilesResult: missing and unsupported files are typed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lsp-core-unit-"));
  const manager = new LSPManager(dir);

  try {
    const existing = join(dir, "standalone.ts");
    const missing = join(dir, "missing.ts");
    await writeFile(existing, "const x = 1;\n");

    const result = await manager.getDiagnosticsForFilesResult([existing, missing], 100);
    assertEqual(result.items.length, 2);
    const statuses = result.items.map((item) => item.status).sort();
    assertEqual(statuses, ["error", "unsupported"]);
  } finally {
    await manager.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// formatDiagnostic tests
// ============================================================================

test("formatDiagnostic: formats error", () => {
  const diag = {
    range: { start: { line: 5, character: 10 }, end: { line: 5, character: 15 } },
    message: "Type 'number' is not assignable to type 'string'",
    severity: 1,
  };
  const result = formatDiagnostic(diag as any);
  assertEqual(result, "ERROR [6:11] Type 'number' is not assignable to type 'string'");
});

test("formatDiagnostic: formats warning", () => {
  const diag = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    message: "Unused variable",
    severity: 2,
  };
  const result = formatDiagnostic(diag as any);
  assertEqual(result, "WARN [1:1] Unused variable");
});

test("formatDiagnostic: formats info", () => {
  const diag = {
    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
    message: "Consider using const",
    severity: 3,
  };
  const result = formatDiagnostic(diag as any);
  assertEqual(result, "INFO [3:5] Consider using const");
});

test("formatDiagnostic: formats hint", () => {
  const diag = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    message: "Prefer arrow function",
    severity: 4,
  };
  const result = formatDiagnostic(diag as any);
  assertEqual(result, "HINT [1:1] Prefer arrow function");
});

// ============================================================================
// filterDiagnosticsBySeverity tests
// ============================================================================

test("filterDiagnosticsBySeverity: all returns everything", () => {
  const diags = [
    { severity: 1, message: "error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 2, message: "warning", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 3, message: "info", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 4, message: "hint", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
  ];
  const result = filterDiagnosticsBySeverity(diags as any, "all");
  assertEqual(result.length, 4);
});

test("filterDiagnosticsBySeverity: error returns only errors", () => {
  const diags = [
    { severity: 1, message: "error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 2, message: "warning", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
  ];
  const result = filterDiagnosticsBySeverity(diags as any, "error");
  assertEqual(result.length, 1);
  assertEqual(result[0].message, "error");
});

test("filterDiagnosticsBySeverity: warning returns errors and warnings", () => {
  const diags = [
    { severity: 1, message: "error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 2, message: "warning", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 3, message: "info", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
  ];
  const result = filterDiagnosticsBySeverity(diags as any, "warning");
  assertEqual(result.length, 2);
});

test("filterDiagnosticsBySeverity: info returns errors, warnings, and info", () => {
  const diags = [
    { severity: 1, message: "error", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 2, message: "warning", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 3, message: "info", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
    { severity: 4, message: "hint", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } },
  ];
  const result = filterDiagnosticsBySeverity(diags as any, "info");
  assertEqual(result.length, 3);
});

// ============================================================================
// collectSymbols tests
// ============================================================================

test("collectSymbols: uses selectionRange start for reported position", () => {
  // selectionRange.start (character 5) differs from range.start (character 0)
  const symbols = [
    { name: "foo", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, selectionRange: { start: { line: 0, character: 5 }, end: { line: 0, character: 8 } }, children: [] },
  ];
  const lines = collectSymbols(symbols as any);
  assertEqual(lines[0], "foo (1:6)");
});

test("collectSymbols: falls back to range when selectionRange is absent", () => {
  const symbols = [
    { name: "foo", kind: 12, range: { start: { line: 0, character: 3 }, end: { line: 0, character: 6 } }, children: [] },
  ];
  const lines = collectSymbols(symbols as any);
  assertEqual(lines[0], "foo (1:4)");
});

test("collectSymbols: converts 0-indexed positions to 1-indexed", () => {
  const symbols = [
    { name: "foo", kind: 12, range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } }, selectionRange: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } }, children: [] },
  ];
  const lines = collectSymbols(symbols as any);
  assertEqual(lines[0], "foo (5:1)");
});

test("collectSymbols: formats multiple symbols in order", () => {
  const symbols = [
    { name: "bar", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, children: [] },
    { name: "baz", kind: 12, range: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } }, selectionRange: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } }, children: [] },
  ];
  const lines = collectSymbols(symbols as any);
  assertEqual(lines.length, 2);
  assertEqual(lines[0], "bar (1:1)");
  assertEqual(lines[1], "baz (6:1)");
});

test("collectSymbols: filters by query (case-insensitive)", () => {
  const symbols = [
    { name: "foo", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, children: [] },
    { name: "fooBar", kind: 12, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } }, children: [] },
    { name: "baz", kind: 12, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } }, selectionRange: { start: { line: 2, character: 0 }, end: { line: 2, character: 3 } }, children: [] },
  ];
  const lines = collectSymbols(symbols as any, 0, [], "FOO");
  assertEqual(lines.length, 2);
  assertEqual(lines[0], "foo (1:1)");
  assertEqual(lines[1], "fooBar (2:1)");
});

test("collectSymbols: recurses into children with indentation", () => {
  const symbols = [
    {
      name: "MyStruct", kind: 23,
      range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
      children: [
        { name: "field", kind: 8, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } }, selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } }, children: [] },
      ],
    },
  ];
  const lines = collectSymbols(symbols as any);
  assertEqual(lines.length, 2);
  assertEqual(lines[0], "MyStruct (1:1)");
  assertEqual(lines[1], "  field (2:3)");
});

test("collectSymbols: returns empty array for no symbols", () => {
  const lines = collectSymbols([] as any);
  assertEqual(lines.length, 0);
});

// ============================================================================
// Run tests
// ============================================================================

async function runTests(): Promise<void> {
  console.log("Running index.ts unit tests...\n");

  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ${name}... ✓`);
      passed++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`  ${name}... ✗`);
      console.log(`    Error: ${msg}\n`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests();
