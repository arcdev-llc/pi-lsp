import * as path from "node:path";
import * as E from "fp-ts/lib/Either.js";
import * as TE from "fp-ts/lib/TaskEither.js";
import { pipe } from "fp-ts/lib/function.js";
import type { CodeAction, Command, Hover, SignatureHelp, WorkspaceEdit } from "vscode-languageserver-protocol";
import { type SeverityFilter, uriToPath } from "./lsp-core.js";

export type ToolTextContent = Array<{ type: "text"; text: string }>;
export type ToolUpdate = { content: ToolTextContent; details?: Record<string, unknown> };
export type ExecuteArgs = {
  signal: AbortSignal | undefined;
  onUpdate: ((update: ToolUpdate) => void) | undefined;
  ctx: { cwd: string };
};

export type LspToolAction =
  | "status"
  | "definition"
  | "references"
  | "hover"
  | "symbols"
  | "diagnostics"
  | "workspace-diagnostics"
  | "signature"
  | "rename"
  | "codeAction";

export type PositionAction = "definition" | "references" | "hover" | "signature" | "rename" | "codeAction";

export type LspCommandInput = {
  action: LspToolAction;
  file?: string;
  files?: string[];
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  query?: string;
  newName?: string;
  severity?: SeverityFilter;
};

export interface InvalidExecutionContextError {
  _tag: "InvalidExecutionContextError";
  message: string;
}

export interface ValidationError {
  _tag: "ValidationError";
  message: string;
}

export interface PositionResolutionError {
  _tag: "PositionResolutionError";
  message: string;
  file: string;
  query: string;
}

export interface CancelledError {
  _tag: "CancelledError";
  message: string;
}

export interface UnexpectedToolError {
  _tag: "UnexpectedToolError";
  message: string;
  cause: unknown;
}

export type ToolExecutionError =
  | InvalidExecutionContextError
  | ValidationError
  | PositionResolutionError
  | CancelledError
  | UnexpectedToolError;

export interface LocationLike {
  uri: string;
  range?: {
    start?: {
      line: number;
      character: number;
    };
  };
}

interface DirectPositionInput {
  _tag: "DirectPosition";
  line: number;
  column: number;
}

interface QueryPositionInput {
  _tag: "QueryPosition";
  query: string;
}

type PendingPosition = DirectPositionInput | QueryPositionInput;

export interface ResolvedPosition {
  line: number;
  column: number;
  fromQuery: boolean;
}

interface BaseCommand {
  action: LspToolAction;
  severity: SeverityFilter;
}

export interface StatusCommand extends BaseCommand {
  action: "status";
}

export interface WorkspaceDiagnosticsCommand extends BaseCommand {
  action: "workspace-diagnostics";
  files: [string, ...string[]];
}

export interface SymbolsCommand extends BaseCommand {
  action: "symbols";
  file: string;
  query?: string;
}

export interface DiagnosticsCommand extends BaseCommand {
  action: "diagnostics";
  file: string;
}

interface PendingPositionCommandBase extends BaseCommand {
  action: PositionAction;
  file: string;
  query?: string;
  position: PendingPosition;
}

export interface PendingRenameCommand extends PendingPositionCommandBase {
  action: "rename";
  newName: string;
}

export interface PendingCodeActionCommand extends PendingPositionCommandBase {
  action: "codeAction";
  endLine?: number;
  endColumn?: number;
}

export interface PendingLookupCommand extends PendingPositionCommandBase {
  action: Exclude<PositionAction, "rename" | "codeAction">;
}

export type ValidatedLspCommand =
  | StatusCommand
  | WorkspaceDiagnosticsCommand
  | SymbolsCommand
  | DiagnosticsCommand
  | PendingRenameCommand
  | PendingCodeActionCommand
  | PendingLookupCommand;

interface ExecutablePositionCommandBase extends BaseCommand, ResolvedPosition {
  action: PositionAction;
  file: string;
  query?: string;
}

export interface RenameCommand extends ExecutablePositionCommandBase {
  action: "rename";
  newName: string;
}

export interface CodeActionCommand extends ExecutablePositionCommandBase {
  action: "codeAction";
  endLine?: number;
  endColumn?: number;
}

export interface LookupCommand extends ExecutablePositionCommandBase {
  action: Exclude<PositionAction, "rename" | "codeAction">;
}

export type ExecutableLspCommand =
  | StatusCommand
  | WorkspaceDiagnosticsCommand
  | SymbolsCommand
  | DiagnosticsCommand
  | RenameCommand
  | CodeActionCommand
  | LookupCommand;

const DEFAULT_SEVERITY: SeverityFilter = "all";
const POSITION_ACTIONS: ReadonlySet<PositionAction> = new Set(["definition", "references", "hover", "signature", "rename", "codeAction"]);

function isAbortSignalLike(value: unknown): value is AbortSignal {
  return !!value
    && typeof value === "object"
    && "aborted" in value
    && typeof (value as { aborted?: unknown }).aborted === "boolean"
    && typeof (value as { addEventListener?: unknown }).addEventListener === "function";
}

function isContextLike(value: unknown): value is { cwd: string } {
  return !!value && typeof value === "object" && typeof (value as { cwd?: unknown }).cwd === "string";
}

function trimmedQuery(query: string | undefined): string | undefined {
  const next = query?.trim();
  return next ? next : undefined;
}

function validationError(message: string): ValidationError {
  return { _tag: "ValidationError", message };
}

export function isAbortedError(error: unknown): boolean {
  return error instanceof Error && error.message === "aborted";
}

export function toToolExecutionError(cause: unknown, message: string): CancelledError | UnexpectedToolError {
  if (isAbortedError(cause)) {
    return { _tag: "CancelledError", message: "Cancelled" };
  }

  return {
    _tag: "UnexpectedToolError",
    message,
    cause,
  };
}

export function formatToolExecutionError(error: ToolExecutionError): string {
  return error.message;
}

export function normalizeExecuteArgsResult(
  onUpdateArg: unknown,
  ctxArg: unknown,
  signalArg: unknown,
): E.Either<InvalidExecutionContextError, ExecuteArgs> {
  if (isContextLike(signalArg)) {
    return E.right({
      signal: isAbortSignalLike(onUpdateArg) ? onUpdateArg : undefined,
      onUpdate: typeof ctxArg === "function" ? ctxArg as ExecuteArgs["onUpdate"] : undefined,
      ctx: signalArg,
    });
  }

  if (isContextLike(ctxArg)) {
    return E.right({
      signal: isAbortSignalLike(signalArg) ? signalArg : undefined,
      onUpdate: typeof onUpdateArg === "function" ? onUpdateArg as ExecuteArgs["onUpdate"] : undefined,
      ctx: ctxArg,
    });
  }

  return E.left({
    _tag: "InvalidExecutionContextError",
    message: "Invalid tool execution context",
  });
}

export function normalizeExecuteArgs(onUpdateArg: unknown, ctxArg: unknown, signalArg: unknown): ExecuteArgs {
  return pipe(
    normalizeExecuteArgsResult(onUpdateArg, ctxArg, signalArg),
    E.getOrElseW((error) => {
      throw new Error(error.message);
    }),
  );
}

export function validateLspCommand(input: LspCommandInput): E.Either<ValidationError, ValidatedLspCommand> {
  const severity = input.severity ?? DEFAULT_SEVERITY;
  const query = trimmedQuery(input.query);

  switch (input.action) {
    case "status":
      return E.right({ action: "status", severity });
    case "workspace-diagnostics":
      return input.files?.length
        ? E.right({ action: "workspace-diagnostics", files: input.files as [string, ...string[]], severity })
        : E.left(validationError('Action "workspace-diagnostics" requires a "files" array.'));
    case "symbols":
      return input.file
        ? E.right({ action: "symbols", file: input.file, query, severity })
        : E.left(validationError('Action "symbols" requires a file path.'));
    case "diagnostics":
      return input.file
        ? E.right({ action: "diagnostics", file: input.file, severity })
        : E.left(validationError('Action "diagnostics" requires a file path.'));
  }

  if (!input.file) {
    return E.left(validationError(`Action "${input.action}" requires a file path.`));
  }

  const position =
    input.line !== undefined && input.column !== undefined
      ? E.right<ValidationError, PendingPosition>({ _tag: "DirectPosition", line: input.line, column: input.column })
      : query
        ? E.right<ValidationError, PendingPosition>({ _tag: "QueryPosition", query })
        : E.left(validationError(`Action "${input.action}" requires line/column or a query matching a symbol.`));

  return pipe(
    position,
    E.chain((nextPosition) => {
      if (!POSITION_ACTIONS.has(input.action as PositionAction)) {
        return E.left(validationError(`Unsupported action: ${input.action}`));
      }

      switch (input.action) {
        case "rename":
          return input.newName
            ? E.right({
                action: "rename",
                file: input.file!,
                query,
                position: nextPosition,
                newName: input.newName,
                severity,
              })
            : E.left(validationError('Action "rename" requires a "newName" parameter.'));
        case "codeAction":
          return E.right({
            action: "codeAction",
            file: input.file!,
            query,
            position: nextPosition,
            endLine: input.endLine,
            endColumn: input.endColumn,
            severity,
          });
        default:
          return E.right({
            action: input.action,
            file: input.file!,
            query,
            position: nextPosition,
            severity,
          } as PendingLookupCommand);
      }
    }),
  );
}

export function resolveValidatedCommand(
  command: ValidatedLspCommand,
  deps: {
    resolvePosition: (file: string, query: string) => Promise<{ line: number; column: number } | null>;
  },
): TE.TaskEither<ToolExecutionError, ExecutableLspCommand> {
  switch (command.action) {
    case "status":
    case "workspace-diagnostics":
    case "symbols":
    case "diagnostics":
      return TE.right(command);
    default:
      if (command.position._tag === "DirectPosition") {
        return TE.right({
          ...command,
          line: command.position.line,
          column: command.position.column,
          fromQuery: false,
        });
      }

      {
        const queryPosition = command.position;
        return pipe(
          TE.tryCatch(
            () => deps.resolvePosition(command.file, queryPosition.query),
            (cause) => toToolExecutionError(cause, `Failed to resolve query position for action "${command.action}".`),
          ),
          TE.chain((resolved) => resolved
            ? TE.right({
                ...command,
                line: resolved.line,
                column: resolved.column,
                fromQuery: true,
              })
            : TE.left<ToolExecutionError, ExecutableLspCommand>({
                _tag: "PositionResolutionError",
                message: `Action "${command.action}" requires line/column or a query matching a symbol.`,
                file: command.file,
                query: queryPosition.query,
              })),
        );
      }
  }
}

export function formatLocation(loc: LocationLike, cwd?: string): string {
  const abs = uriToPath(loc.uri);
  const display = cwd && path.isAbsolute(abs) ? path.relative(cwd, abs) : abs;
  const { line, character: col } = loc.range?.start ?? {};
  return typeof line === "number" && typeof col === "number" ? `${display}:${line + 1}:${col + 1}` : display;
}

export function formatHover(contents: Hover["contents"] | unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((content) => typeof content === "string" ? content : String(content?.value ?? ""))
      .filter(Boolean)
      .join("\n\n");
  }
  if (contents && typeof contents === "object" && "value" in contents) {
    return String((contents as { value?: unknown }).value ?? "");
  }
  return "";
}

export function formatSignature(help: SignatureHelp | null): string {
  if (!help?.signatures?.length) return "No signature help available.";
  const sig = help.signatures[help.activeSignature ?? 0] ?? help.signatures[0];
  let text = sig.label ?? "Signature";
  if (sig.documentation) {
    text += `\n${typeof sig.documentation === "string" ? sig.documentation : sig.documentation?.value ?? ""}`;
  }
  if (sig.parameters?.length) {
    const params = sig.parameters
      .map((param) => typeof param.label === "string" ? param.label : Array.isArray(param.label) ? param.label.join("-") : "")
      .filter(Boolean);
    if (params.length) text += `\nParameters: ${params.join(", ")}`;
  }
  return text;
}

export function formatWorkspaceEdit(edit: WorkspaceEdit, cwd?: string): string {
  const lines: string[] = [];

  if (edit.documentChanges?.length) {
    for (const change of edit.documentChanges) {
      if (!("textDocument" in change) || !change.textDocument?.uri) continue;

      const fp = uriToPath(change.textDocument.uri);
      const display = cwd && path.isAbsolute(fp) ? path.relative(cwd, fp) : fp;
      lines.push(`${display}:`);

      for (const entry of change.edits) {
        if (!("newText" in entry)) continue;
        const loc = `${entry.range.start.line + 1}:${entry.range.start.character + 1}`;
        lines.push(`  [${loc}] → "${entry.newText}"`);
      }
    }
  }

  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const fp = uriToPath(uri);
      const display = cwd && path.isAbsolute(fp) ? path.relative(cwd, fp) : fp;
      lines.push(`${display}:`);
      for (const entry of edits) {
        const loc = `${entry.range.start.line + 1}:${entry.range.start.character + 1}`;
        lines.push(`  [${loc}] → "${entry.newText}"`);
      }
    }
  }

  return lines.length ? lines.join("\n") : "No edits.";
}

export function formatCodeActions(actions: ReadonlyArray<CodeAction | Command>): string[] {
  return actions.map((action, index) => {
    const title = action.title || "Untitled action";
    const kind = "kind" in action && action.kind ? ` (${action.kind})` : "";
    const isPreferred = "isPreferred" in action && action.isPreferred ? " ★" : "";
    return `${index + 1}. ${title}${kind}${isPreferred}`;
  });
}
