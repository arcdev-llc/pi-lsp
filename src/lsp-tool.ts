/**
 * LSP Tool Extension for pi-coding-agent
 *
 * Provides Language Server Protocol tool for:
 * - definitions, references, hover, signature help
 * - document symbols, diagnostics, workspace diagnostics
 * - rename, code actions
 *
 * Supported languages:
 *   - Dart/Flutter (dart language-server)
 *   - TypeScript/JavaScript (typescript-language-server)
 *   - Vue (vue-language-server)
 *   - Svelte (svelteserver)
 *   - Python (pyright-langserver)
 *   - Go (gopls)
 *   - Kotlin (kotlin-ls)
 *   - Swift (sourcekit-lsp)
 *   - Rust (rust-analyzer)
 *
 * Usage:
 *   pi --extension ./lsp-tool.ts
 *
 * Or use the combined lsp.ts extension for both hook and tool functionality.
 */

import * as path from "node:path";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import * as TE from "fp-ts/lib/TaskEither.js";
import { pipe } from "fp-ts/lib/function.js";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { getOrCreateManager, formatDiagnostic, filterDiagnosticsBySeverity, resolvePosition, collectSymbols, inspectWorkspaceLsp, truncateHead, type SeverityFilter } from "./lsp-core.js";
import {
  formatCodeActions,
  formatHover,
  formatLocation,
  formatSignature,
  formatToolExecutionError,
  formatWorkspaceEdit,
  normalizeExecuteArgsResult,
  resolveValidatedCommand,
  toToolExecutionError,
  validateLspCommand,
  type ExecutableLspCommand,
  type ToolExecutionError,
} from "./lsp-tool-helpers.js";

const PREVIEW_LINES = 10;

const DIAGNOSTICS_WAIT_MS_DEFAULT = 3000;
const SYMBOLS_MAX_LINES = 200;
const SYMBOLS_MAX_BYTES = 30 * 1024;

function diagnosticsWaitMsForFile(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".kt" || ext === ".kts") return 30000;
  if (ext === ".swift") return 20000;
  if (ext === ".rs") return 20000;
  return DIAGNOSTICS_WAIT_MS_DEFAULT;
}

const ACTIONS = ["status", "definition", "references", "hover", "symbols", "diagnostics", "workspace-diagnostics", "signature", "rename", "codeAction"] as const;
const SEVERITY_FILTERS = ["all", "error", "warning", "info", "hint"] as const;

const LspParams = Type.Object({
  action: StringEnum(ACTIONS),
  file: Type.Optional(Type.String({ description: "File path (required for most actions)" })),
  files: Type.Optional(Type.Array(Type.String(), { description: "File paths for workspace-diagnostics" })),
  line: Type.Optional(Type.Number({ description: "Line (1-indexed). Required for position-based actions unless query provided." })),
  column: Type.Optional(Type.Number({ description: "Column (1-indexed). Required for position-based actions unless query provided." })),
  endLine: Type.Optional(Type.Number({ description: "End line for range-based actions (codeAction)" })),
  endColumn: Type.Optional(Type.Number({ description: "End column for range-based actions (codeAction)" })),
  query: Type.Optional(Type.String({ description: "Symbol name filter (for symbols) or to resolve position (for definition/references/hover/signature)" })),
  newName: Type.Optional(Type.String({ description: "New name for rename action" })),
  severity: Type.Optional(StringEnum(SEVERITY_FILTERS, { description: 'Filter diagnostics: "all"|"error"|"warning"|"info"|"hint"' })),
});

type LspParamsType = Static<typeof LspParams>;

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error("aborted"));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new Error("aborted"));
    };

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

function isAbortedError(e: unknown): boolean {
  return e instanceof Error && e.message === "aborted";
}

function cancelledToolResult() {
  return {
    content: [{ type: "text" as const, text: "Cancelled" }],
    details: { cancelled: true },
  };
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

function commandHeader(command: ExecutableLspCommand): { qLine: string; sevLine: string; posLine: string } {
  const qLine = "query" in command && command.query ? `query: ${command.query}\n` : "";
  const sevLine = command.severity !== "all" ? `severity: ${command.severity}\n` : "";
  const posLine = "fromQuery" in command && command.fromQuery ? `resolvedPosition: ${command.line}:${command.column}\n` : "";
  return { qLine, sevLine, posLine };
}

function executeValidatedCommand(
  command: ExecutableLspCommand,
  deps: {
    cwd: string;
    signal?: AbortSignal;
    manager: ReturnType<typeof getOrCreateManager>;
  },
): TE.TaskEither<ToolExecutionError, ToolResult> {
  const { cwd, signal, manager } = deps;
  const { qLine, sevLine, posLine } = commandHeader(command);
  const runTask = <A>(task: () => Promise<A>, message: string) => TE.tryCatch(task, (cause) => toToolExecutionError(cause, message));

  switch (command.action) {
    case "status": {
      const support = inspectWorkspaceLsp(cwd);
      if (!support.length) {
        return TE.right({
          content: [{
            type: "text",
            text: "action: status\nNo supported LSP workspace detected from the current cwd. If the project lives in a subdirectory, cd there first or use bash/read to inspect the repo layout.",
          }],
          details: { support: [] },
        });
      }

      const lines = support.map((item) => {
        const displayRoot = path.relative(cwd, item.root) || ".";
        const availability = item.binaryAvailable ? `binary: ${item.binary}` : `binary missing: expected ${item.binary}`;
        return `- ${item.language} (${item.serverId})\n  root: ${displayRoot}\n  ${availability}`;
      });

      return TE.right({
        content: [{
          type: "text",
          text: `action: status\nDetected ${support.length} LSP workspace(s):\n${lines.join("\n")}`,
        }],
        details: { support },
      });
    }
    case "definition":
      return pipe(
        runTask(() => abortable(manager.getDefinition(command.file, command.line, command.column), signal), `Failed to get definition for ${command.file}.`),
        TE.map((results) => {
          const locs = results.map((loc) => formatLocation(loc, cwd));
          const payload = locs.length ? locs.join("\n") : command.fromQuery ? `${command.file}:${command.line}:${command.column}` : "No definitions found.";
          return { content: [{ type: "text", text: `action: definition\n${qLine}${posLine}${payload}` }], details: results };
        }),
      );
    case "references":
      return pipe(
        runTask(() => abortable(manager.getReferences(command.file, command.line, command.column), signal), `Failed to get references for ${command.file}.`),
        TE.map((results) => {
          const locs = results.map((loc) => formatLocation(loc, cwd));
          return { content: [{ type: "text", text: `action: references\n${qLine}${posLine}${locs.length ? locs.join("\n") : "No references found."}` }], details: results };
        }),
      );
    case "hover":
      return pipe(
        runTask(() => abortable(manager.getHoverOption(command.file, command.line, command.column), signal), `Failed to get hover information for ${command.file}.`),
        TE.map((result) => {
          const payload = pipe(
            result,
            O.match(
              () => "No hover information.",
              (hover) => formatHover(hover.contents) || "No hover information.",
            ),
          );
          return { content: [{ type: "text", text: `action: hover\n${qLine}${posLine}${payload}` }], details: pipe(result, O.getOrElse<unknown>(() => null)) };
        }),
      );
    case "symbols":
      return pipe(
        runTask(() => abortable(manager.getDocumentSymbols(command.file), signal), `Failed to get symbols for ${command.file}.`),
        TE.map((symbols) => {
          const lines = collectSymbols(symbols, 0, [], command.query);
          const truncated = truncateHead(lines, SYMBOLS_MAX_LINES, SYMBOLS_MAX_BYTES);
          let payload: string;
          if (truncated.truncated) {
            payload = truncated.content;
            payload += `\n\n[Truncated: ${truncated.outputLines} of ${truncated.totalLines} symbol lines shown. Use a narrower query to filter results.]`;
          } else {
            payload = lines.length ? lines.join("\n") : command.query ? `No symbols matching "${command.query}".` : "No symbols found.";
          }
          return { content: [{ type: "text", text: `action: symbols\n${qLine}${payload}` }], details: symbols };
        }),
      );
    case "diagnostics":
      return pipe(
        runTask(() => abortable(manager.touchFileAndWaitResult(command.file, diagnosticsWaitMsForFile(command.file)), signal), `Failed to get diagnostics for ${command.file}.`),
        TE.map((result) => {
          const filtered = filterDiagnosticsBySeverity(result.diagnostics, command.severity);
          const payload = (() => {
            switch (result.status) {
              case "unsupported":
                return `Unsupported: ${result.error || "No LSP for this file."}`;
              case "timeout":
                return "Timeout: LSP server did not respond. Try again.";
              case "error":
                return `Error: ${result.error}`;
              case "success":
                return filtered.length ? filtered.map(formatDiagnostic).join("\n") : "No diagnostics.";
            }
          })();
          return { content: [{ type: "text", text: `action: diagnostics\n${sevLine}${payload}` }], details: { ...result, diagnostics: filtered } };
        }),
      );
    case "workspace-diagnostics":
      return pipe(
        runTask(() => {
          const waitMs = Math.max(...command.files.map(diagnosticsWaitMsForFile));
          return abortable(manager.getDiagnosticsForFilesResult(command.files, waitMs), signal);
        }, "Failed to get workspace diagnostics."),
        TE.map((result) => {
          const out: string[] = [];
          let errors = 0;
          let warnings = 0;
          let filesWithIssues = 0;

          for (const item of result.items) {
            const display = path.isAbsolute(item.file) ? path.relative(cwd, item.file) : item.file;
            if (item.status !== "success") {
              out.push(`${display}: ${item.error || item.status}`);
              continue;
            }

            const filtered = filterDiagnosticsBySeverity(item.diagnostics, command.severity);
            if (filtered.length) {
              filesWithIssues++;
              out.push(`${display}:`);
              for (const diagnostic of filtered) {
                if (diagnostic.severity === 1) errors++;
                else if (diagnostic.severity === 2) warnings++;
                out.push(`  ${formatDiagnostic(diagnostic)}`);
              }
            }
          }

          const summary = `Analyzed ${result.items.length} file(s): ${errors} error(s), ${warnings} warning(s) in ${filesWithIssues} file(s)`;
          const truncated = truncateHead(out, 500, 40 * 1024);
          const diagnosticsText = truncated.truncated
            ? `${truncated.content}\n\n[Truncated: ${truncated.outputLines} of ${truncated.totalLines} diagnostic lines. Use severity filter or fewer files to reduce output.]`
            : (out.length ? out.join("\n") : "No diagnostics.");
          return { content: [{ type: "text", text: `action: workspace-diagnostics\n${sevLine}${summary}\n\n${diagnosticsText}` }], details: result };
        }),
      );
    case "signature":
      return pipe(
        runTask(() => abortable(manager.getSignatureHelpOption(command.file, command.line, command.column), signal), `Failed to get signature help for ${command.file}.`),
        TE.map((result) => {
          const signature = pipe(result, O.getOrElse<unknown>(() => null));
          return { content: [{ type: "text", text: `action: signature\n${qLine}${posLine}${formatSignature(signature as any)}` }], details: signature };
        }),
      );
    case "rename":
      return pipe(
        runTask(() => abortable(manager.renameOption(command.file, command.line, command.column, command.newName), signal), `Failed to rename symbol in ${command.file}.`),
        TE.map((result) => pipe(
          result,
          O.match(
            (): ToolResult => ({ content: [{ type: "text", text: `action: rename\n${qLine}${posLine}No rename available at this position.` }], details: null }),
            (edit): ToolResult => {
              const edits = formatWorkspaceEdit(edit, cwd);
              return { content: [{ type: "text", text: `action: rename\n${qLine}${posLine}newName: ${command.newName}\n\n${edits}` }], details: edit };
            },
          ),
        )),
      );
    case "codeAction":
      return pipe(
        runTask(() => abortable(manager.getCodeActions(command.file, command.line, command.column, command.endLine, command.endColumn), signal), `Failed to get code actions for ${command.file}.`),
        TE.map((result) => {
          const actions = formatCodeActions(result);
          return { content: [{ type: "text", text: `action: codeAction\n${qLine}${posLine}${actions.length ? actions.join("\n") : "No code actions available."}` }], details: result };
        }),
      );
  }
}

export default function (pi: ExtensionAPI) {
  // Cast for compatibility with older pi type definitions that do not yet include
  // promptSnippet / promptGuidelines, while newer runtimes use them in the system prompt.
  pi.registerTool(({
    name: "lsp",
    label: "LSP",
    description: `Use this tool for semantic code navigation, diagnostics, and refactoring when symbol awareness matters.

Best for: go to definition, find references, hover/type info, list symbols, rename, diagnostics, and code actions. Prefer this over grep/read when the task is about symbols or language-server-backed analysis. If the file path is unknown, use bash or read first to locate candidate files.

Actions: status, definition, references, hover, signature, rename (require file + line/column or query), symbols (file, optional query), diagnostics (file), workspace-diagnostics (files array), codeAction (file + position).`,
    promptSnippet: "Use for semantic code navigation, symbol lookup, diagnostics, rename, and code actions via language servers.",
    promptGuidelines: [
      "Use lsp instead of grep/read when the task is symbol-aware: definition, references, hover/type info, rename, diagnostics, or code actions.",
      "If the target file is unknown, use bash/read first to locate likely files, then call lsp.",
      "After code edits, prefer lsp diagnostics or workspace-diagnostics to validate changes in supported projects.",
      "If lsp reports unsupported or times out, fall back to read/bash and explain the limitation.",
    ],
    parameters: LspParams,

    async execute(_toolCallId: string, params: LspParamsType, signalArg: unknown, onUpdateArg: unknown, ctxArg: unknown) {
      const program = pipe(
        TE.fromEither(normalizeExecuteArgsResult(onUpdateArg, ctxArg, signalArg)),
        TE.chain((args) => {
          if (args.signal?.aborted) {
            return TE.left<ToolExecutionError, { args: typeof args; command: ExecutableLspCommand; manager: ReturnType<typeof getOrCreateManager> }>({
              _tag: "CancelledError",
              message: "Cancelled",
            });
          }

          const manager = getOrCreateManager(args.ctx.cwd);
          return pipe(
            validateLspCommand(params as LspParamsType),
            TE.fromEither,
            TE.chain((command) => resolveValidatedCommand(command, {
              resolvePosition: (file, query) => abortable(resolvePosition(manager, file, query), args.signal),
            })),
            TE.map((command) => ({ args, command, manager })),
          );
        }),
        TE.chain(({ args, command, manager }) => executeValidatedCommand(command, {
          cwd: args.ctx.cwd,
          signal: args.signal,
          manager,
        })),
      );

      const result = await program();
      if (E.isLeft(result)) {
        if (result.left._tag === "CancelledError") return cancelledToolResult();
        throw new Error(formatToolExecutionError(result.left));
      }

      return result.right;
    },

    renderCall(args: LspParamsType, theme: any) {
      const params = args as LspParamsType;
      let text = theme.fg("toolTitle", theme.bold("lsp ")) + theme.fg("accent", params.action || "...");
      if (params.file) text += " " + theme.fg("muted", params.file);
      else if (params.files?.length) text += " " + theme.fg("muted", `${params.files.length} file(s)`);
      if (params.query) text += " " + theme.fg("dim", `query="${params.query}"`);
      else if (params.line !== undefined && params.column !== undefined) text += theme.fg("warning", `:${params.line}:${params.column}`);
      if (params.severity && params.severity !== "all") text += " " + theme.fg("dim", `[${params.severity}]`);
      return new Text(text, 0, 0);
    },

    renderResult(result: any, options: any, theme: any) {
      if (options.isPartial) return new Text("", 0, 0);

      const textContent = (result.content?.find((c: any) => c.type === "text") as any)?.text || "";
      const lines = textContent.split("\n");

      let headerEnd = 0;
      for (let i = 0; i < lines.length; i++) {
        if (/^(action|query|severity|resolvedPosition):/.test(lines[i])) headerEnd = i + 1;
        else break;
      }

      const header = lines.slice(0, headerEnd);
      const content = lines.slice(headerEnd);
      const maxLines = options.expanded ? content.length : PREVIEW_LINES;
      const display = content.slice(0, maxLines);
      const remaining = content.length - maxLines;

      let out = header.map((l: string) => theme.fg("muted", l)).join("\n");
      if (display.length) {
        if (out) out += "\n";
        out += display.map((l: string) => theme.fg("toolOutput", l)).join("\n");
      }
      if (remaining > 0) out += theme.fg("dim", `\n... (${remaining} more lines)`);

      return new Text(out, 0, 0);
    },
  } as any));
}
