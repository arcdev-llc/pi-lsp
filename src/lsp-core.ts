/**
 * LSP Core - Language Server Protocol client management
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import * as E from "fp-ts/lib/Either.js";
import * as O from "fp-ts/lib/Option.js";
import * as TE from "fp-ts/lib/TaskEither.js";
import { pipe } from "fp-ts/lib/function.js";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
  InitializeRequest,
  InitializedNotification,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidSaveTextDocumentNotification,
  PublishDiagnosticsNotification,
  DocumentDiagnosticRequest,
  WorkspaceDiagnosticRequest,
  DefinitionRequest,
  ReferencesRequest,
  HoverRequest,
  SignatureHelpRequest,
  DocumentSymbolRequest,
  RenameRequest,
  CodeActionRequest,
} from "vscode-languageserver-protocol/node.js";
import {
  type Diagnostic,
  type Location,
  type LocationLink,
  type DocumentSymbol,
  type SymbolInformation,
  type Hover,
  type SignatureHelp,
  type WorkspaceEdit,
  type CodeAction,
  type Command,
  DiagnosticSeverity,
  CodeActionKind,
  DocumentDiagnosticReportKind,
} from "vscode-languageserver-protocol";

// Config
const INIT_TIMEOUT_MS = 30000;
const MAX_OPEN_FILES = 30;
const IDLE_TIMEOUT_MS = 60_000;
const CLEANUP_INTERVAL_MS = 30_000;

export const LANGUAGE_IDS: Record<string, string> = {
  ".dart": "dart", ".ts": "typescript", ".tsx": "typescriptreact",
  ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript",
  ".cjs": "javascript", ".mts": "typescript", ".cts": "typescript",
  ".vue": "vue", ".svelte": "svelte", ".astro": "astro",
  ".py": "python", ".pyi": "python", ".go": "go", ".rs": "rust",
  ".kt": "kotlin", ".kts": "kotlin",
  ".swift": "swift",
};

// Types
interface LSPServerConfig {
  id: string;
  extensions: string[];
  findRoot: (file: string, cwd: string) => string | undefined;
  spawn: (root: string) => Promise<{ process: ChildProcessWithoutNullStreams; initOptions?: Record<string, unknown> } | undefined>;
}

interface OpenFile { version: number; lastAccess: number; contentHash: string; }

interface LSPClient {
  connection: MessageConnection;
  process: ChildProcessWithoutNullStreams;
  diagnostics: Map<string, Diagnostic[]>;
  openFiles: Map<string, OpenFile>;
  listeners: Map<string, Array<() => void>>;
  stderr: string[];
  capabilities?: any;
  root: string;
  closed: boolean;
}

export interface FileDiagnosticItem {
  file: string;
  diagnostics: Diagnostic[];
  status: 'ok' | 'timeout' | 'error' | 'unsupported';
  error?: string;
}

export interface FileDiagnosticsResult { items: FileDiagnosticItem[]; }

export type FileDiagnosticsItemResult =
  | { file: string; diagnostics: Diagnostic[]; status: "success" }
  | { file: string; diagnostics: Diagnostic[]; status: "timeout"; error: string }
  | { file: string; diagnostics: Diagnostic[]; status: "unsupported"; error: string }
  | { file: string; diagnostics: Diagnostic[]; status: "error"; error: string };

export interface FileDiagnosticsResultV2 { items: FileDiagnosticsItemResult[]; }

interface LoadedFileContext {
  clients: LSPClient[];
  absPath: string;
  uri: string;
  langId: string;
  content: string;
}

interface SpawnProcessError {
  _tag: "SpawnProcessError";
  cmd: string;
  args: string[];
  cwd: string;
  reason: "spawn_exception" | "process_exit" | "process_error" | "all_variants_failed";
  cause?: unknown;
}

interface InitClientError {
  _tag: "InitClientError";
  serverId: string;
  root: string;
  phase: "spawn" | "initialize";
  cause?: unknown;
}

interface RequestExecutionError {
  _tag: "RequestExecutionError";
  method: string;
  root: string;
  cause?: unknown;
}

interface FsProbeError {
  _tag: "FsProbeError";
  operation: "stat" | "readdir" | "realpath" | "readFile";
  path: string;
  cause?: unknown;
}

export type TouchFileDiagnosticsResult =
  | { status: "success"; diagnostics: Diagnostic[] }
  | { status: "timeout"; diagnostics: Diagnostic[]; error: string }
  | { status: "unsupported"; diagnostics: Diagnostic[]; error: string }
  | { status: "error"; diagnostics: Diagnostic[]; error: string };

export interface LegacyTouchFileResult {
  diagnostics: Diagnostic[];
  receivedResponse: boolean;
  unsupported?: boolean;
  error?: string;
}

export interface WorkspaceLspSupport {
  serverId: string;
  language: string;
  root: string;
  binary: string;
  binaryAvailable: boolean;
}

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationResult {
  content: string;
  truncated: boolean;
  outputLines: number;
  outputBytes: number;
  totalLines: number;
  totalBytes: number;
}

export function toLegacyTouchFileResult(result: TouchFileDiagnosticsResult): LegacyTouchFileResult {
  switch (result.status) {
    case "success":
      return { diagnostics: result.diagnostics, receivedResponse: true };
    case "timeout":
      return { diagnostics: result.diagnostics, receivedResponse: false, error: result.error };
    case "unsupported":
      return { diagnostics: result.diagnostics, receivedResponse: false, unsupported: true, error: result.error };
    case "error":
      return { diagnostics: result.diagnostics, receivedResponse: false, error: result.error };
  }
}

export function toLegacyFileDiagnosticItem(result: FileDiagnosticsItemResult): FileDiagnosticItem {
  switch (result.status) {
    case "success":
      return { file: result.file, diagnostics: result.diagnostics, status: "ok" };
    case "timeout":
      return { file: result.file, diagnostics: result.diagnostics, status: "timeout", error: result.error };
    case "unsupported":
      return { file: result.file, diagnostics: result.diagnostics, status: "unsupported", error: result.error };
    case "error":
      return { file: result.file, diagnostics: result.diagnostics, status: "error", error: result.error };
  }
}

export function toLegacyFileDiagnosticsResult(result: FileDiagnosticsResultV2): FileDiagnosticsResult {
  return { items: result.items.map(toLegacyFileDiagnosticItem) };
}

export function truncateHead(lines: string[], maxLines: number, maxBytes: number): TruncationResult {
  const totalLines = lines.length;
  const totalBytes = lines.reduce((acc, l) => acc + l.length + 1, 0);

  const outputLines: string[] = [];
  let outputBytes = 0;
  let truncated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineBytes = line.length + 1;
    if (outputLines.length >= maxLines || outputBytes + lineBytes > maxBytes) {
      truncated = true;
      break;
    }
    outputLines.push(line);
    outputBytes += lineBytes;
  }

  return {
    content: outputLines.join("\n"),
    truncated,
    outputLines: outputLines.length,
    outputBytes,
    totalLines,
    totalBytes,
  };
}

// Utilities
const SEARCH_PATHS = [
  ...(process.env.PATH?.split(path.delimiter) || []),
  "/usr/local/bin", "/opt/homebrew/bin",
  `${process.env.HOME}/.pub-cache/bin`, `${process.env.HOME}/.fvm/default/bin`,
  `${process.env.HOME}/go/bin`, `${process.env.HOME}/.cargo/bin`,
];

// Extra search roots for mise-managed node installs
const MISE_NPM_BINS = [
  `${process.env.HOME}/.local/share/mise/installs`,
  `${process.env.HOME}/.npm`,
];

// Cache: command → resolved path (null = definitely not found, string = found, absent = not cached)
const WHICH_CACHE = new Map<string, string | null>();

// Cache: `${filePath}:${cwd}` → root or undefined
const ROOT_CACHE = new Map<string, string | undefined>();

function statPathResult(targetPath: string): E.Either<FsProbeError, fs.Stats> {
  return E.tryCatch(
    () => fs.statSync(targetPath),
    (cause): FsProbeError => ({ _tag: "FsProbeError", operation: "stat", path: targetPath, cause }),
  );
}

function readDirNamesResult(dirPath: string): E.Either<FsProbeError, string[]> {
  return E.tryCatch(
    () => fs.readdirSync(dirPath),
    (cause): FsProbeError => ({ _tag: "FsProbeError", operation: "readdir", path: dirPath, cause }),
  );
}

function readDirentsResult(dirPath: string): E.Either<FsProbeError, fs.Dirent[]> {
  return E.tryCatch(
    () => fs.readdirSync(dirPath, { withFileTypes: true }),
    (cause): FsProbeError => ({ _tag: "FsProbeError", operation: "readdir", path: dirPath, cause }),
  );
}

function realPathResult(targetPath: string): E.Either<FsProbeError, string> {
  return E.tryCatch(
    () => {
      const fn: any = (fs as any).realpathSync?.native || fs.realpathSync;
      return fn(targetPath);
    },
    (cause): FsProbeError => ({ _tag: "FsProbeError", operation: "realpath", path: targetPath, cause }),
  );
}

function readUtf8FileResult(filePath: string): E.Either<FsProbeError, string> {
  return E.tryCatch(
    () => fs.readFileSync(filePath, "utf-8"),
    (cause): FsProbeError => ({ _tag: "FsProbeError", operation: "readFile", path: filePath, cause }),
  );
}

function isExistingFile(targetPath: string): boolean {
  return pipe(
    statPathResult(targetPath),
    E.match(
      () => false,
      (stat) => stat.isFile(),
    ),
  );
}

function isExistingDirectory(targetPath: string): boolean {
  return pipe(
    statPathResult(targetPath),
    E.match(
      () => false,
      (stat) => stat.isDirectory(),
    ),
  );
}

function pathExists(targetPath: string): boolean {
  return E.isRight(statPathResult(targetPath));
}

function which(cmd: string): string | undefined {
  const cached = WHICH_CACHE.get(cmd);
  if (cached !== undefined) return cached ?? undefined;

  const ext = process.platform === "win32" ? ".exe" : "";

  for (const dir of SEARCH_PATHS) {
    const full = path.join(dir, cmd + ext);
    if (isExistingFile(full)) {
      WHICH_CACHE.set(cmd, full);
      return full;
    }
  }

  const binSuffixes = [`bin/${cmd}`, `bin/${cmd}.js`, `bin/${cmd}${ext}`];
  for (const root of MISE_NPM_BINS) {
    const entries = pipe(readDirNamesResult(root), E.getOrElseW((): string[] => []));
    for (const entry of entries) {
      const candidate = path.join(root, entry);
      if (!isExistingDirectory(candidate)) continue;

      for (const suffix of binSuffixes) {
        const full = path.join(candidate, suffix);
        if (isExistingFile(full)) {
          WHICH_CACHE.set(cmd, full);
          return full;
        }
      }

      const subEntries = pipe(readDirNamesResult(candidate), E.getOrElseW((): string[] => []));
      for (const sub of subEntries) {
        if (sub.startsWith(".") || sub === "node_modules" || sub === "package.json" || sub === "bun.lock") continue;
        const subPath = path.join(candidate, sub);
        if (!isExistingDirectory(subPath)) continue;

        for (const suffix of binSuffixes) {
          const full = path.join(subPath, suffix);
          if (isExistingFile(full)) {
            WHICH_CACHE.set(cmd, full);
            return full;
          }
        }
      }
    }
  }

  WHICH_CACHE.set(cmd, null);
  return undefined;
}

function normalizeFsPath(p: string): string {
  return pipe(
    realPathResult(p),
    E.getOrElseW(() => p),
  );
}

function dirHasExtension(root: string, exts: string[], maxDepth = 3): boolean {
  const ignored = new Set([".git", ".pi", "node_modules", "dist", "build", "target", ".next", ".turbo"]);

  const visit = (dir: string, depth: number): boolean => {
    const entries = pipe(readDirentsResult(dir), E.getOrElseW((): fs.Dirent[] => []));

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth <= 0 || ignored.has(entry.name)) continue;
        if (visit(path.join(dir, entry.name), depth - 1)) return true;
        continue;
      }

      if (exts.includes(path.extname(entry.name).toLowerCase())) return true;
    }

    return false;
  };

  return visit(root, maxDepth);
}

function findNearestFile(startDir: string, targets: string[], stopDir: string): string | undefined {
  let current = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  while (current.length >= stop.length) {
    for (const t of targets) {
      const candidate = path.join(current, t);
      if (pathExists(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function findRoot(file: string, cwd: string, markers: string[]): string | undefined {
  const cacheKey = `${file}:${cwd}`;
  const cached = ROOT_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;

  const found = findNearestFile(path.dirname(file), markers, cwd);
  const result = found ? path.dirname(found) : undefined;
  ROOT_CACHE.set(cacheKey, result);
  return result;
}

function timeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name} timed out`)), ms);
    promise.then(r => { clearTimeout(timer); resolve(r); }, e => { clearTimeout(timer); reject(e); });
  });
}

function simpleSpawn(bin: string, args: string[] = ["--stdio"]) {
  return async (root: string) => {
    const cmd = which(bin);
    if (!cmd) return undefined;
    return { process: spawn(cmd, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] }) };
  };
}

function findTypeScriptServerPath(root: string): string | undefined {
  const localServerJs = path.join(root, "node_modules/typescript/lib/tsserver.js");
  if (isExistingFile(localServerJs)) return localServerJs;

  const localServerBin = path.join(root, "node_modules/.bin/tsserver");
  if (isExistingFile(localServerBin)) return localServerBin;

  return which("tsserver") || which("tsc");
}

async function spawnCheckedResult(cmd: string, args: string[], cwd: string): Promise<E.Either<SpawnProcessError, ChildProcessWithoutNullStreams>> {
  try {
    const child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });

    return await new Promise((resolve) => {
      let settled = false;

      const cleanup = () => {
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
      };

      let timer: NodeJS.Timeout | null = null;

      const finish = (value: E.Either<SpawnProcessError, ChildProcessWithoutNullStreams>) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cleanup();
        resolve(value);
      };

      const onExit = () => finish(E.left({
        _tag: "SpawnProcessError",
        cmd,
        args,
        cwd,
        reason: "process_exit",
      }));
      const onError = (cause: unknown) => finish(E.left({
        _tag: "SpawnProcessError",
        cmd,
        args,
        cwd,
        reason: "process_error",
        cause,
      }));

      child.once("exit", onExit);
      child.once("error", onError);

      timer = setTimeout(() => finish(E.right(child)), 200);
      (timer as any).unref?.();
    });
  } catch (cause) {
    return E.left({
      _tag: "SpawnProcessError",
      cmd,
      args,
      cwd,
      reason: "spawn_exception",
      cause,
    });
  }
}

async function spawnChecked(cmd: string, args: string[], cwd: string): Promise<ChildProcessWithoutNullStreams | undefined> {
  return pipe(
    await spawnCheckedResult(cmd, args, cwd),
    E.getOrElseW((): ChildProcessWithoutNullStreams | undefined => undefined),
  );
}

async function spawnWithFallbackResult(cmd: string, argsVariants: string[][], cwd: string): Promise<E.Either<SpawnProcessError, ChildProcessWithoutNullStreams>> {
  let lastError: SpawnProcessError | undefined;

  for (const args of argsVariants) {
    const child = await spawnCheckedResult(cmd, args, cwd);
    if (E.isRight(child)) return child;
    lastError = child.left;
  }

  return E.left(lastError ?? {
    _tag: "SpawnProcessError",
    cmd,
    args: [],
    cwd,
    reason: "all_variants_failed",
  });
}

async function spawnWithFallback(cmd: string, argsVariants: string[][], cwd: string): Promise<ChildProcessWithoutNullStreams | undefined> {
  return pipe(
    await spawnWithFallbackResult(cmd, argsVariants, cwd),
    E.getOrElseW((): ChildProcessWithoutNullStreams | undefined => undefined),
  );
}

function findRootKotlin(file: string, cwd: string): string | undefined {
  // Prefer Gradle settings root for multi-module projects
  const gradleRoot = findRoot(file, cwd, ["settings.gradle.kts", "settings.gradle"]);
  if (gradleRoot) return gradleRoot;

  // Fallbacks for single-module Gradle or Maven builds
  return findRoot(file, cwd, [
    "build.gradle.kts",
    "build.gradle",
    "gradlew",
    "gradlew.bat",
    "gradle.properties",
    "pom.xml",
  ]);
}

function dirContainsNestedProjectFile(dir: string, dirSuffix: string, markerFile: string): boolean {
  const entries = pipe(readDirentsResult(dir), E.getOrElseW((): fs.Dirent[] => []));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.endsWith(dirSuffix)) continue;
    if (pathExists(path.join(dir, entry.name, markerFile))) return true;
  }
  return false;
}

function findRootSwift(file: string, cwd: string): string | undefined {
  let current = path.resolve(path.dirname(file));
  const stop = path.resolve(cwd);

  while (current.length >= stop.length) {
    if (pathExists(path.join(current, "Package.swift"))) return current;

    // Xcode projects/workspaces store their marker files *inside* a directory
    if (dirContainsNestedProjectFile(current, ".xcodeproj", "project.pbxproj")) return current;
    if (dirContainsNestedProjectFile(current, ".xcworkspace", "contents.xcworkspacedata")) return current;

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return undefined;
}

async function runCommand(cmd: string, args: string[], cwd: string): Promise<boolean> {
  return await new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      p.on("error", () => resolve(false));
      p.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

async function ensureJetBrainsKotlinLspInstalled(): Promise<string | undefined> {
  // Opt-in download (to avoid surprising network activity)
  const allowDownload = process.env.PI_LSP_AUTO_DOWNLOAD_KOTLIN_LSP === "1" || process.env.PI_LSP_AUTO_DOWNLOAD_KOTLIN_LSP === "true";
  const installDir = path.join(os.homedir(), ".pi", "agent", "lsp", "kotlin-ls");
  const launcher = process.platform === "win32"
    ? path.join(installDir, "kotlin-lsp.cmd")
    : path.join(installDir, "kotlin-lsp.sh");

  if (fs.existsSync(launcher)) return launcher;
  if (!allowDownload) return undefined;

  const curl = which("curl");
  const unzip = which("unzip");
  if (!curl || !unzip) return undefined;

  try {
    // Determine latest version
    const res = await fetch("https://api.github.com/repos/Kotlin/kotlin-lsp/releases/latest", {
      headers: { "User-Agent": "pi-lsp" },
    });
    if (!res.ok) return undefined;
    const release: any = await res.json();
    const versionRaw = (release?.name || release?.tag_name || "").toString();
    const version = versionRaw.replace(/^v/, "");
    if (!version) return undefined;

    // Map platform/arch to JetBrains naming
    const platform = process.platform;
    const arch = process.arch;

    let kotlinArch: string = arch;
    if (arch === "arm64") kotlinArch = "aarch64";
    else if (arch === "x64") kotlinArch = "x64";

    let kotlinPlatform: string = platform;
    if (platform === "darwin") kotlinPlatform = "mac";
    else if (platform === "linux") kotlinPlatform = "linux";
    else if (platform === "win32") kotlinPlatform = "win";

    const supportedCombos = new Set(["mac-x64", "mac-aarch64", "linux-x64", "linux-aarch64", "win-x64", "win-aarch64"]);
    const combo = `${kotlinPlatform}-${kotlinArch}`;
    if (!supportedCombos.has(combo)) return undefined;

    const assetName = `kotlin-lsp-${version}-${kotlinPlatform}-${kotlinArch}.zip`;
    const url = `https://download-cdn.jetbrains.com/kotlin-lsp/${version}/${assetName}`;

    fs.mkdirSync(installDir, { recursive: true });
    const zipPath = path.join(installDir, "kotlin-lsp.zip");

    const okDownload = await runCommand(curl, ["-L", "-o", zipPath, url], installDir);
    if (!okDownload || !fs.existsSync(zipPath)) return undefined;

    const okUnzip = await runCommand(unzip, ["-o", zipPath, "-d", installDir], installDir);
    try { fs.rmSync(zipPath, { force: true }); } catch {}
    if (!okUnzip) return undefined;

    if (process.platform !== "win32") {
      try { fs.chmodSync(launcher, 0o755); } catch {}
    }

    return fs.existsSync(launcher) ? launcher : undefined;
  } catch {
    return undefined;
  }
}

async function spawnKotlinLanguageServer(root: string): Promise<ChildProcessWithoutNullStreams | undefined> {
  // Prefer JetBrains Kotlin LSP (Kotlin/kotlin-lsp) – better diagnostics for Gradle/Android projects.
  const explicit = process.env.PI_LSP_KOTLIN_LSP_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return spawnWithFallback(explicit, [["--stdio"]], root);
  }

  const jetbrains = which("kotlin-lsp") || which("kotlin-lsp.sh") || which("kotlin-lsp.cmd") || await ensureJetBrainsKotlinLspInstalled();
  if (jetbrains) {
    return spawnWithFallback(jetbrains, [["--stdio"]], root);
  }

  // Fallback: org.javacs/kotlin-language-server (often lacks diagnostics without full classpath)
  const kls = which("kotlin-language-server");
  if (!kls) return undefined;
  return spawnWithFallback(kls, [[]], root);
}

async function spawnSourcekitLsp(root: string): Promise<ChildProcessWithoutNullStreams | undefined> {
  const direct = which("sourcekit-lsp");
  if (direct) return spawnWithFallback(direct, [[], ["--stdio"]], root);

  // macOS/Xcode: sourcekit-lsp is often available via xcrun
  const xcrun = which("xcrun");
  if (!xcrun) return undefined;
  return spawnWithFallback(xcrun, [["sourcekit-lsp"], ["sourcekit-lsp", "--stdio"]], root);
}

// Server Configs
export const LSP_SERVERS: LSPServerConfig[] = [
  {
    id: "dart", extensions: [".dart"],
    findRoot: (f, cwd) => findRoot(f, cwd, ["pubspec.yaml", "analysis_options.yaml"]),
    spawn: async (root) => {
      let dart = which("dart");
      const pubspec = path.join(root, "pubspec.yaml");
      if (fs.existsSync(pubspec)) {
        try {
          const content = fs.readFileSync(pubspec, "utf-8");
          if (content.includes("flutter:") || content.includes("sdk: flutter")) {
            const flutter = which("flutter");
            if (flutter) {
              const dir = path.dirname(fs.realpathSync(flutter));
              for (const p of ["cache/dart-sdk/bin/dart", "../cache/dart-sdk/bin/dart"]) {
                const c = path.join(dir, p);
                if (fs.existsSync(c)) { dart = c; break; }
              }
            }
          }
        } catch {}
      }
      if (!dart) return undefined;
      return { process: spawn(dart, ["language-server", "--protocol=lsp"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] }) };
    },
  },
  {
    id: "typescript", extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    findRoot: (f, cwd) => {
      if (findNearestFile(path.dirname(f), ["deno.json", "deno.jsonc"], cwd)) return undefined;
      return findRoot(f, cwd, ["package.json", "tsconfig.json", "jsconfig.json"]);
    },
    spawn: async (root) => {
      const local = path.join(root, "node_modules/.bin/typescript-language-server");
      const cmd = fs.existsSync(local) ? local : which("typescript-language-server");
      if (!cmd) return undefined;

      const tsserverPath = findTypeScriptServerPath(root);
      const initOptions = tsserverPath ? { tsserver: { path: tsserverPath, fallbackPath: tsserverPath } } : undefined;

      return {
        process: spawn(cmd, ["--stdio"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] }),
        initOptions,
      };
    },
  },
  { id: "vue", extensions: [".vue"], findRoot: (f, cwd) => findRoot(f, cwd, ["package.json", "vite.config.ts", "vite.config.js"]), spawn: simpleSpawn("vue-language-server") },
  { id: "svelte", extensions: [".svelte"], findRoot: (f, cwd) => findRoot(f, cwd, ["package.json", "svelte.config.js"]), spawn: simpleSpawn("svelteserver") },
  { id: "pyright", extensions: [".py", ".pyi"], findRoot: (f, cwd) => findRoot(f, cwd, ["pyproject.toml", "setup.py", "requirements.txt", "pyrightconfig.json"]), spawn: simpleSpawn("pyright-langserver") },
  { id: "gopls", extensions: [".go"], findRoot: (f, cwd) => findRoot(f, cwd, ["go.work"]) || findRoot(f, cwd, ["go.mod"]), spawn: simpleSpawn("gopls", []) },
  {
    id: "kotlin", extensions: [".kt", ".kts"],
    findRoot: (f, cwd) => findRootKotlin(f, cwd),
    spawn: async (root) => {
      const proc = await spawnKotlinLanguageServer(root);
      if (!proc) return undefined;
      return { process: proc };
    },
  },
  {
    id: "swift", extensions: [".swift"],
    findRoot: (f, cwd) => findRootSwift(f, cwd),
    spawn: async (root) => {
      const proc = await spawnSourcekitLsp(root);
      if (!proc) return undefined;
      return { process: proc };
    },
  },
  { id: "rust-analyzer", extensions: [".rs"], findRoot: (f, cwd) => findRoot(f, cwd, ["Cargo.toml"]), spawn: simpleSpawn("rust-analyzer", []) },
];

// Singleton Manager
let sharedManager: LSPManager | null = null;
let managerCwd: string | null = null;

export function getOrCreateManager(cwd: string): LSPManager {
  if (!sharedManager || managerCwd !== cwd) {
    sharedManager?.shutdown().catch(() => {});
    sharedManager = new LSPManager(cwd);
    managerCwd = cwd;
  }
  return sharedManager;
}

export function getManager(): LSPManager | null { return sharedManager; }

export async function shutdownManager(): Promise<void> {
  const manager = sharedManager;
  if (!manager) return;

  // Clear singleton pointers first so new requests never receive a manager
  // that's currently being shut down.
  sharedManager = null;
  managerCwd = null;

  await manager.shutdown();
}

const SERVER_LABELS: Record<string, string> = {
  dart: "Dart/Flutter",
  typescript: "TypeScript/JavaScript",
  vue: "Vue",
  svelte: "Svelte",
  pyright: "Python",
  gopls: "Go",
  kotlin: "Kotlin",
  swift: "Swift",
  "rust-analyzer": "Rust",
};

function expectedServerBinary(serverId: string): string {
  switch (serverId) {
    case "dart":
      return "dart";
    case "typescript":
      return "typescript-language-server";
    case "vue":
      return "vue-language-server";
    case "svelte":
      return "svelteserver";
    case "pyright":
      return "pyright-langserver";
    case "gopls":
      return "gopls";
    case "kotlin":
      return "kotlin-lsp";
    case "swift":
      return "sourcekit-lsp";
    case "rust-analyzer":
      return "rust-analyzer";
    default:
      return serverId;
  }
}

function workspaceLikelyUsesServer(serverId: string, root: string): boolean {
  switch (serverId) {
    case "typescript":
      return fs.existsSync(path.join(root, "tsconfig.json"))
        || fs.existsSync(path.join(root, "jsconfig.json"))
        || dirHasExtension(root, [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
    case "vue":
      return fs.existsSync(path.join(root, "vite.config.ts"))
        || fs.existsSync(path.join(root, "vite.config.js"))
        || dirHasExtension(root, [".vue"]);
    case "svelte":
      return fs.existsSync(path.join(root, "svelte.config.js"))
        || dirHasExtension(root, [".svelte"]);
    default:
      return true;
  }
}

function findServerBinary(serverId: string, root: string): string | undefined {
  switch (serverId) {
    case "dart":
      return which("dart") || which("flutter");
    case "typescript": {
      const local = path.join(root, "node_modules/.bin/typescript-language-server");
      return fs.existsSync(local) ? local : which("typescript-language-server");
    }
    case "vue":
      return which("vue-language-server");
    case "svelte":
      return which("svelteserver");
    case "pyright":
      return which("pyright-langserver");
    case "gopls":
      return which("gopls");
    case "kotlin":
      return which("kotlin-lsp") || which("kotlin-lsp.sh") || which("kotlin-lsp.cmd") || process.env.PI_LSP_KOTLIN_LSP_PATH || which("kotlin-language-server");
    case "swift":
      return which("sourcekit-lsp") || which("xcrun");
    case "rust-analyzer":
      return which("rust-analyzer");
    default:
      return undefined;
  }
}

export function inspectWorkspaceLsp(cwd: string): WorkspaceLspSupport[] {
  const seen = new Set<string>();
  const found: WorkspaceLspSupport[] = [];

  for (const config of LSP_SERVERS) {
    const probeExt = config.extensions[0];
    if (!probeExt) continue;
    const root = config.findRoot(path.join(cwd, `__pi_lsp_probe__${probeExt}`), cwd);
    if (!root) continue;

    const key = `${config.id}:${root}`;
    if (seen.has(key)) continue;
    if (!workspaceLikelyUsesServer(config.id, root)) continue;
    seen.add(key);

    const binaryPath = findServerBinary(config.id, root);
    found.push({
      serverId: config.id,
      language: SERVER_LABELS[config.id] || config.id,
      root,
      binary: binaryPath ? path.basename(binaryPath) : expectedServerBinary(config.id),
      binaryAvailable: !!binaryPath,
    });
  }

  return found;
}

// LSP Manager
export class LSPManager {
  private clients = new Map<string, LSPClient>();
  private spawning = new Map<string, Promise<LSPClient | undefined>>();
  private broken = new Set<string>();
  private cwd: string;
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.cleanupTimer = setInterval(() => this.cleanupIdleFiles(), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  private cleanupIdleFiles() {
    const now = Date.now();
    for (const client of this.clients.values()) {
      for (const [fp, state] of client.openFiles) {
        if (now - state.lastAccess > IDLE_TIMEOUT_MS) this.closeFile(client, fp);
      }
    }
  }

  private closeFile(client: LSPClient, absPath: string) {
    if (!client.openFiles.has(absPath)) return;
    client.openFiles.delete(absPath);
    if (client.closed) return;
    try {
      void client.connection.sendNotification(DidCloseTextDocumentNotification.type, {
        textDocument: { uri: pathToFileURL(absPath).href },
      }).catch(() => {});
    } catch {}
  }

  private evictLRU(client: LSPClient) {
    if (client.openFiles.size <= MAX_OPEN_FILES) return;
    let oldest: { path: string; time: number } | null = null;
    for (const [fp, s] of client.openFiles) {
      if (!oldest || s.lastAccess < oldest.time) oldest = { path: fp, time: s.lastAccess };
    }
    if (oldest) this.closeFile(client, oldest.path);
  }

  private key(id: string, root: string) { return `${id}:${root}`; }

  private initClientResult(config: LSPServerConfig, root: string): TE.TaskEither<InitClientError, LSPClient> {
    const k = this.key(config.id, root);

    return pipe(
      TE.tryCatch(
        () => config.spawn(root),
        (cause): InitClientError => ({
          _tag: "InitClientError",
          serverId: config.id,
          root,
          phase: "spawn",
          cause,
        }),
      ),
      TE.chain((handle) => handle
        ? TE.right(handle)
        : TE.left<InitClientError, Awaited<ReturnType<LSPServerConfig["spawn"]>> extends Promise<infer T> ? Exclude<T, undefined> : never>({
            _tag: "InitClientError",
            serverId: config.id,
            root,
            phase: "spawn",
          })),
      TE.chain((handle) => TE.tryCatch(async () => {
        const reader = new StreamMessageReader(handle.process.stdout!);
        const writer = new StreamMessageWriter(handle.process.stdin!);
        const conn = createMessageConnection(reader, writer);

        handle.process.stdin?.on("error", () => {});
        handle.process.stdout?.on("error", () => {});

        const stderr: string[] = [];
        const MAX_STDERR_LINES = 200;
        handle.process.stderr?.on("data", (chunk: Buffer) => {
          try {
            const text = chunk.toString("utf-8");
            for (const line of text.split(/\r?\n/)) {
              if (!line.trim()) continue;
              stderr.push(line);
              if (stderr.length > MAX_STDERR_LINES) stderr.splice(0, stderr.length - MAX_STDERR_LINES);
            }
          } catch {
            // ignore
          }
        });
        handle.process.stderr?.on("error", () => {});

        const client: LSPClient = {
          connection: conn,
          process: handle.process,
          diagnostics: new Map(),
          openFiles: new Map(),
          listeners: new Map(),
          stderr,
          root,
          closed: false,
        };

        conn.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[] }) => {
          const fpRaw = decodeURIComponent(new URL(params.uri).pathname);
          const fp = normalizeFsPath(fpRaw);

          client.diagnostics.set(fp, params.diagnostics);
          const listeners1 = client.listeners.get(fp);
          const listeners2 = fp !== fpRaw ? client.listeners.get(fpRaw) : undefined;

          listeners1?.slice().forEach(fn => { try { fn(); } catch { /* listener error */ } });
          listeners2?.slice().forEach(fn => { try { fn(); } catch { /* listener error */ } });
        });

        conn.onError(() => {});
        conn.onClose(() => { client.closed = true; this.clients.delete(k); });

        conn.onRequest("workspace/configuration", () => [handle.initOptions ?? {}]);
        conn.onRequest("window/workDoneProgress/create", () => null);
        conn.onRequest("client/registerCapability", () => {});
        conn.onRequest("client/unregisterCapability", () => {});
        conn.onRequest("workspace/workspaceFolders", () => [{ name: "workspace", uri: pathToFileURL(root).href }]);

        handle.process.on("exit", () => { client.closed = true; this.clients.delete(k); });
        handle.process.on("error", () => { client.closed = true; this.clients.delete(k); this.broken.add(k); });

        conn.listen();

        const initResult = await timeout(conn.sendRequest(InitializeRequest.method, {
          rootUri: pathToFileURL(root).href,
          rootPath: root,
          processId: process.pid,
          workspaceFolders: [{ name: "workspace", uri: pathToFileURL(root).href }],
          initializationOptions: handle.initOptions ?? {},
          capabilities: {
            window: { workDoneProgress: true },
            workspace: { configuration: true },
            textDocument: {
              synchronization: { didSave: true, didOpen: true, didChange: true, didClose: true },
              publishDiagnostics: { versionSupport: true },
              diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            },
          },
        }), INIT_TIMEOUT_MS, `${config.id} init`);

        client.capabilities = (initResult as any)?.capabilities;

        conn.sendNotification(InitializedNotification.type, {});
        if (handle.initOptions) {
          conn.sendNotification("workspace/didChangeConfiguration", { settings: handle.initOptions });
        }
        return client;
      }, (cause): InitClientError => ({
        _tag: "InitClientError",
        serverId: config.id,
        root,
        phase: "initialize",
        cause,
      }))),
    );
  }

  private async initClient(config: LSPServerConfig, root: string): Promise<LSPClient | undefined> {
    const k = this.key(config.id, root);
    const result = await this.initClientResult(config, root)();
    if (E.isLeft(result)) {
      this.broken.add(k);
      return undefined;
    }
    return result.right;
  }

  async getClientsForFile(filePath: string): Promise<LSPClient[]> {
    const ext = path.extname(filePath);
    const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(this.cwd, filePath);
    const clients: LSPClient[] = [];

    for (const config of LSP_SERVERS) {
      if (!config.extensions.includes(ext)) continue;
      const root = config.findRoot(absPath, this.cwd);
      if (!root) continue;
      const k = this.key(config.id, root);
      if (this.broken.has(k)) continue;

      const existing = this.clients.get(k);
      if (existing) { clients.push(existing); continue; }

      if (!this.spawning.has(k)) {
        const p = this.initClient(config, root);
        this.spawning.set(k, p);
        p.finally(() => this.spawning.delete(k));
      }
      const client = await this.spawning.get(k);
      if (client) { this.clients.set(k, client); clients.push(client); }
    }
    return clients;
  }

  private resolve(fp: string) {
    const abs = path.isAbsolute(fp) ? fp : path.resolve(this.cwd, fp);
    return normalizeFsPath(abs);
  }
  private langId(fp: string) { return LANGUAGE_IDS[path.extname(fp)] || "plaintext"; }
  private readFile(fp: string): string | null {
    return pipe(
      readUtf8FileResult(fp),
      E.getOrElseW((): string | null => null),
    );
  }

  private explainNoLsp(absPath: string): string {
    const ext = path.extname(absPath);

    if (ext === ".kt" || ext === ".kts") {
      const root = findRootKotlin(absPath, this.cwd);
      if (!root) return `No Kotlin project root detected (looked for settings.gradle(.kts), build.gradle(.kts), gradlew, pom.xml under cwd)`;

      const hasJetbrains = !!(which("kotlin-lsp") || which("kotlin-lsp.sh") || which("kotlin-lsp.cmd") || process.env.PI_LSP_KOTLIN_LSP_PATH);
      const hasKls = !!which("kotlin-language-server");

      if (!hasJetbrains && !hasKls) {
        return "No Kotlin LSP binary found. Install Kotlin/kotlin-lsp (recommended) or org.javacs/kotlin-language-server.";
      }

      const k = this.key("kotlin", root);
      if (this.broken.has(k)) return `Kotlin LSP failed to initialize for root: ${root}`;

      if (!hasJetbrains && hasKls) {
        return "Kotlin LSP is running via kotlin-language-server, but that server often does not produce diagnostics for Gradle/Android projects. Prefer Kotlin/kotlin-lsp.";
      }

      return `Kotlin LSP unavailable for root: ${root}`;
    }

    if (ext === ".swift") {
      const root = findRootSwift(absPath, this.cwd);
      if (!root) return `No Swift project root detected (looked for Package.swift, *.xcodeproj, *.xcworkspace under cwd)`;
      if (!which("sourcekit-lsp") && !which("xcrun")) return "sourcekit-lsp not found (and xcrun missing)";
      const k = this.key("swift", root);
      if (this.broken.has(k)) return `sourcekit-lsp failed to initialize for root: ${root}`;
      return `Swift LSP unavailable for root: ${root}`;
    }

    return `No LSP for ${ext}`;
  }

  private toPos(line: number, col: number) { return { line: Math.max(0, line - 1), character: Math.max(0, col - 1) }; }

  private normalizeLocs(result: Location | Location[] | LocationLink[] | null | undefined): Location[] {
    if (!result) return [];
    const items = Array.isArray(result) ? result : [result];
    if (!items.length) return [];
    if ("uri" in items[0] && "range" in items[0]) return items as Location[];
    return (items as LocationLink[]).map(l => ({ uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange }));
  }

  private normalizeSymbols(result: DocumentSymbol[] | SymbolInformation[] | null | undefined): DocumentSymbol[] {
    if (!result?.length) return [];
    const first = result[0];
    if ("location" in first) {
      return (result as SymbolInformation[]).map(s => ({
        name: s.name, kind: s.kind, range: s.location.range, selectionRange: s.location.range,
        detail: s.containerName, tags: s.tags, deprecated: s.deprecated, children: [],
      }));
    }
    return result as DocumentSymbol[];
  }

  private contentHash(text: string): string {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h) ^ text.charCodeAt(i);
    }
    return String(h >>> 0);
  }

  /**
   * Lightweight sync: open (once) and send didChange only when content actually changed.
   * does NOT send didSave — callers that need analysis triggers should use openOrUpdateForAnalysis.
   */
  private async openOrUpdate(clients: LSPClient[], absPath: string, uri: string, langId: string, content: string, evict = true) {
    const now = Date.now();
    const hash = this.contentHash(content);
    for (const client of clients) {
      if (client.closed) continue;
      const state = client.openFiles.get(absPath);
      try {
        if (state) {
          // Skip didChange if content hasn't changed — avoids unnecessary server analysis.
          if (state.contentHash === hash) {
            client.openFiles.set(absPath, { version: state.version, lastAccess: now, contentHash: hash });
            continue;
          }
          const v = state.version + 1;
          client.openFiles.set(absPath, { version: v, lastAccess: now, contentHash: hash });
          void client.connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version: v }, contentChanges: [{ text: content }],
          }).catch(() => {});
        } else {
          // For some servers (e.g. kotlin-language-server), diagnostics only start flowing after a didChange.
          // We open at version 0, then immediately send a full-content didChange at version 1.
          client.openFiles.set(absPath, { version: 1, lastAccess: now, contentHash: hash });
          void client.connection.sendNotification(DidOpenTextDocumentNotification.type, {
            textDocument: { uri, languageId: langId, version: 0, text: content },
          }).catch(() => {});
          void client.connection.sendNotification(DidChangeTextDocumentNotification.type, {
            textDocument: { uri, version: 1 }, contentChanges: [{ text: content }],
          }).catch(() => {});
          if (evict) this.evictLRU(client);
        }
        // didSave removed from the hot path — it forces extra analysis on every query.
        // Use openOrUpdateForAnalysis below when you need diagnostics/rename readiness.
      } catch {}
    }
  }

  /**
   * Full sync for analysis-heavy workflows (diagnostics, rename preflight, code actions).
   * Opens/changes + sends didSave to trigger semantic analysis.
   */
  private async openOrUpdateForAnalysis(clients: LSPClient[], absPath: string, uri: string, langId: string, content: string, evict = true) {
    await this.openOrUpdate(clients, absPath, uri, langId, content, evict);
    const hash = this.contentHash(content);
    for (const client of clients) {
      if (client.closed) continue;
      const state = client.openFiles.get(absPath);
      if (state && state.contentHash === hash) {
        // Already open with same content — still send didSave to trigger analysis.
        void client.connection.sendNotification(DidSaveTextDocumentNotification.type, {
          textDocument: { uri }, text: content,
        }).catch(() => {});
      }
    }
  }

  private async loadFileOption(filePath: string): Promise<O.Option<LoadedFileContext>> {
    const absPath = this.resolve(filePath);
    const clients = await this.getClientsForFile(absPath);
    if (!clients.length) return O.none;
    const content = this.readFile(absPath);
    if (content === null) return O.none;
    return O.some({ clients, absPath, uri: pathToFileURL(absPath).href, langId: this.langId(absPath), content });
  }

  private requestResult<A>(client: LSPClient, method: string, task: () => Promise<A>): TE.TaskEither<RequestExecutionError, A> {
    if (client.closed) {
      return TE.left({
        _tag: "RequestExecutionError",
        method,
        root: client.root,
        cause: "client_closed",
      });
    }

    return TE.tryCatch(task, (cause): RequestExecutionError => ({
      _tag: "RequestExecutionError",
      method,
      root: client.root,
      cause,
    }));
  }

  private async collectRequestResults<A>(
    clients: LSPClient[],
    method: string,
    request: (client: LSPClient) => Promise<A[]>,
  ): Promise<A[]> {
    const results = await Promise.all(clients.map(async (client) => pipe(
      await this.requestResult(client, method, () => request(client))(),
      E.getOrElseW((): A[] => []),
    )));

    return results.flat();
  }

  private async firstOptionRequest<A>(
    clients: LSPClient[],
    method: string,
    request: (client: LSPClient) => Promise<A | null | undefined>,
  ): Promise<O.Option<A>> {
    for (const client of clients) {
      const result = await this.requestResult(client, method, () => request(client))();
      if (E.isRight(result) && result.right != null) return O.some(result.right);
    }

    return O.none;
  }

  private isTypeScriptLikePath(absPath: string): boolean {
    const ext = path.extname(absPath).toLowerCase();
    return ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs" || ext === ".mts" || ext === ".cts";
  }

  private emptyDiagnosticsSettleMs(absPath: string, timeoutMs: number): number {
    if (!this.isTypeScriptLikePath(absPath)) return 2500;
    return Math.min(8000, Math.max(4000, Math.min(timeoutMs - 500, Math.floor(timeoutMs * 0.8))));
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private collectCachedDiagnostics(clients: LSPClient[], absPath: string): Diagnostic[] {
    const diags: Diagnostic[] = [];
    for (const client of clients) {
      const current = client.diagnostics.get(absPath);
      if (current) diags.push(...current);
    }
    return diags;
  }

  private async pullAndStoreDiagnostics(clients: LSPClient[], absPath: string, uri: string): Promise<boolean> {
    let responded = false;
    const pulled = await Promise.all(clients.map((client) => this.pullDiagnostics(client, absPath, uri)));
    for (let i = 0; i < clients.length; i++) {
      const result = pulled[i];
      if (result.responded) responded = true;
      if (result.diagnostics.length) clients[i].diagnostics.set(absPath, result.diagnostics);
    }
    return responded;
  }

  private async touchAndCollectDiagnostics(
    clients: LSPClient[],
    absPath: string,
    uri: string,
    langId: string,
    content: string,
    timeoutMs: number,
    evict = true,
  ): Promise<{ responded: boolean; diagnostics: Diagnostic[] }> {
    const isNew = clients.some((client) => !client.openFiles.has(absPath));
    const waits = clients.map((client) => this.waitForDiagnostics(client, absPath, timeoutMs, isNew));
    await this.openOrUpdate(clients, absPath, uri, langId, content, evict);
    const waitResults = await Promise.all(waits);

    let responded = waitResults.some((result) => result);
    let diagnostics = this.collectCachedDiagnostics(clients, absPath);
    if (!responded && clients.some((client) => client.diagnostics.has(absPath))) responded = true;

    if (!responded || diagnostics.length === 0) {
      if (await this.pullAndStoreDiagnostics(clients, absPath, uri)) responded = true;
      diagnostics = this.collectCachedDiagnostics(clients, absPath);
    }

    if (responded && diagnostics.length === 0 && isNew && this.isTypeScriptLikePath(absPath)) {
      const deadline = Date.now() + Math.min(4000, Math.max(1500, Math.floor(timeoutMs / 2)));
      // Keep re-syncing the same content to trigger more TS analysis passes.
      while (Date.now() < deadline) {
        await this.sleep(400);
        await this.openOrUpdateForAnalysis(clients, absPath, uri, langId, content, evict);
        if (await this.pullAndStoreDiagnostics(clients, absPath, uri)) responded = true;
        diagnostics = this.collectCachedDiagnostics(clients, absPath);
        if (diagnostics.length > 0) break;
      }
    }

    return { responded, diagnostics };
  }

  private waitForDiagnostics(client: LSPClient, absPath: string, timeoutMs: number, isNew: boolean): Promise<boolean> {
    return new Promise(resolve => {
      if (client.closed) return resolve(false);

      let resolved = false;
      let settleTimer: NodeJS.Timeout | null = null;
      let listener: () => void = () => {};

      const cleanupListener = () => {
        const listeners = client.listeners.get(absPath);
        if (!listeners) return;
        const idx = listeners.indexOf(listener);
        if (idx !== -1) listeners.splice(idx, 1);
        if (listeners.length === 0) client.listeners.delete(absPath);
      };

      const finish = (value: boolean) => {
        if (resolved) return;
        resolved = true;
        if (settleTimer) clearTimeout(settleTimer);
        clearTimeout(timer);
        cleanupListener();
        resolve(value);
      };

      // Some servers publish diagnostics multiple times (often empty first, then real results).
      // For new documents, if diagnostics are still empty, debounce a bit.
      listener = () => {
        if (resolved) return;

        const current = client.diagnostics.get(absPath);
        if (current && current.length > 0) return finish(true);

        if (!isNew) return finish(true);

        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => finish(true), this.emptyDiagnosticsSettleMs(absPath, timeoutMs));
        (settleTimer as any).unref?.();
      };

      const timer = setTimeout(() => finish(false), timeoutMs);
      (timer as any).unref?.();

      const listeners = client.listeners.get(absPath) || [];
      listeners.push(listener);
      client.listeners.set(absPath, listeners);
    });
  }

  private async pullDiagnostics(client: LSPClient, absPath: string, uri: string): Promise<{ diagnostics: Diagnostic[]; responded: boolean }> {
    if (client.closed) return { diagnostics: [], responded: false };

    // Only attempt Pull Diagnostics if the server advertises support.
    // (Some servers throw and log noisy errors if we call these methods.)
    if (!client.capabilities || !(client.capabilities as any).diagnosticProvider) {
      return { diagnostics: [], responded: false };
    }

    // Prefer new Pull Diagnostics if supported by the server
    try {
      const res: any = await client.connection.sendRequest(DocumentDiagnosticRequest.method, {
        textDocument: { uri },
      });

      if (res?.kind === DocumentDiagnosticReportKind.Full) {
        return { diagnostics: Array.isArray(res.items) ? res.items : [], responded: true };
      }
      if (res?.kind === DocumentDiagnosticReportKind.Unchanged) {
        return { diagnostics: client.diagnostics.get(absPath) || [], responded: true };
      }
      if (Array.isArray(res?.items)) {
        return { diagnostics: res.items, responded: true };
      }
      return { diagnostics: [], responded: true };
    } catch {
      // ignore
    }

    // Fallback: some servers only support WorkspaceDiagnosticRequest
    try {
      const res: any = await client.connection.sendRequest(WorkspaceDiagnosticRequest.method, {
        previousResultIds: [],
      });

      const items: any[] = res?.items || [];
      const match = items.find((it: any) => it?.uri === uri);
      if (match?.kind === DocumentDiagnosticReportKind.Full) {
        return { diagnostics: Array.isArray(match.items) ? match.items : [], responded: true };
      }
      if (Array.isArray(match?.items)) {
        return { diagnostics: match.items, responded: true };
      }
      return { diagnostics: [], responded: true };
    } catch {
      return { diagnostics: [], responded: false };
    }
  }

  async touchFileAndWaitResult(filePath: string, timeoutMs: number): Promise<TouchFileDiagnosticsResult> {
    const absPath = this.resolve(filePath);

    if (!fs.existsSync(absPath)) {
      return { status: "error", diagnostics: [], error: "File not found" };
    }

    const clients = await this.getClientsForFile(absPath);
    if (!clients.length) {
      return { status: "unsupported", diagnostics: [], error: this.explainNoLsp(absPath) };
    }

    const content = this.readFile(absPath);
    if (content === null) {
      return { status: "error", diagnostics: [], error: "Could not read file" };
    }

    const uri = pathToFileURL(absPath).href;
    const langId = this.langId(absPath);
    const { responded, diagnostics } = await this.touchAndCollectDiagnostics(clients, absPath, uri, langId, content, timeoutMs);

    if (!responded) {
      return { status: "timeout", diagnostics, error: "LSP did not respond" };
    }

    return { status: "success", diagnostics };
  }

  async touchFileAndWait(filePath: string, timeoutMs: number): Promise<LegacyTouchFileResult> {
    return toLegacyTouchFileResult(await this.touchFileAndWaitResult(filePath, timeoutMs));
  }

  async getDiagnosticsForFilesResult(files: string[], timeoutMs: number): Promise<FileDiagnosticsResultV2> {
    const unique = [...new Set(files.map(f => this.resolve(f)))];
    const results: FileDiagnosticsItemResult[] = [];
    const toClose: Map<LSPClient, string[]> = new Map();

    for (const absPath of unique) {
      if (!fs.existsSync(absPath)) {
        results.push({ file: absPath, diagnostics: [], status: "error", error: "File not found" });
        continue;
      }

      let clients: LSPClient[];
      try {
        clients = await this.getClientsForFile(absPath);
      } catch (e) {
        results.push({ file: absPath, diagnostics: [], status: "error", error: String(e) });
        continue;
      }

      if (!clients.length) {
        results.push({ file: absPath, diagnostics: [], status: "unsupported", error: this.explainNoLsp(absPath) });
        continue;
      }

      const content = this.readFile(absPath);
      if (content === null) {
        results.push({ file: absPath, diagnostics: [], status: "error", error: "Could not read file" });
        continue;
      }

      const uri = pathToFileURL(absPath).href;
      const langId = this.langId(absPath);

      for (const c of clients) {
        if (!c.openFiles.has(absPath)) {
          if (!toClose.has(c)) toClose.set(c, []);
          toClose.get(c)!.push(absPath);
        }
      }

      const { responded, diagnostics } = await this.touchAndCollectDiagnostics(clients, absPath, uri, langId, content, timeoutMs, false);

      if (!responded && !diagnostics.length) {
        results.push({ file: absPath, diagnostics: [], status: "timeout", error: "LSP did not respond" });
      } else {
        results.push({ file: absPath, diagnostics, status: "success" });
      }
    }

    for (const [c, fps] of toClose) {
      for (const fp of fps) this.closeFile(c, fp);
    }
    for (const c of this.clients.values()) {
      while (c.openFiles.size > MAX_OPEN_FILES) this.evictLRU(c);
    }

    return { items: results };
  }

  async getDiagnosticsForFiles(files: string[], timeoutMs: number): Promise<FileDiagnosticsResult> {
    return toLegacyFileDiagnosticsResult(await this.getDiagnosticsForFilesResult(files, timeoutMs));
  }

  async getDefinition(fp: string, line: number, col: number): Promise<Location[]> {
    const loaded = await this.loadFileOption(fp);
    if (O.isNone(loaded)) return [];
    const l = loaded.value;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    return this.collectRequestResults(l.clients, DefinitionRequest.method, async (client) =>
      this.normalizeLocs(await client.connection.sendRequest(DefinitionRequest.type, { textDocument: { uri: l.uri }, position: pos })),
    );
  }

  async getReferences(fp: string, line: number, col: number): Promise<Location[]> {
    const loaded = await this.loadFileOption(fp);
    if (O.isNone(loaded)) return [];
    const l = loaded.value;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    return this.collectRequestResults(l.clients, ReferencesRequest.method, async (client) =>
      this.normalizeLocs(await client.connection.sendRequest(ReferencesRequest.type, { textDocument: { uri: l.uri }, position: pos, context: { includeDeclaration: true } })),
    );
  }

  async getHoverOption(fp: string, line: number, col: number): Promise<O.Option<Hover>> {
    const loaded = await this.loadFileOption(fp);
    if (O.isNone(loaded)) return O.none;
    const l = loaded.value;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    return this.firstOptionRequest(l.clients, HoverRequest.method, (client) =>
      client.connection.sendRequest(HoverRequest.type, { textDocument: { uri: l.uri }, position: pos }),
    );
  }

  async getHover(fp: string, line: number, col: number): Promise<Hover | null> {
    return pipe(
      await this.getHoverOption(fp, line, col),
      O.getOrElse<Hover | null>(() => null),
    );
  }

  async getSignatureHelpOption(fp: string, line: number, col: number): Promise<O.Option<SignatureHelp>> {
    const loaded = await this.loadFileOption(fp);
    if (O.isNone(loaded)) return O.none;
    const l = loaded.value;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    const pos = this.toPos(line, col);
    return this.firstOptionRequest(l.clients, SignatureHelpRequest.method, (client) =>
      client.connection.sendRequest(SignatureHelpRequest.type, { textDocument: { uri: l.uri }, position: pos }),
    );
  }

  async getSignatureHelp(fp: string, line: number, col: number): Promise<SignatureHelp | null> {
    return pipe(
      await this.getSignatureHelpOption(fp, line, col),
      O.getOrElse<SignatureHelp | null>(() => null),
    );
  }

  async getDocumentSymbols(fp: string): Promise<DocumentSymbol[]> {
    const loaded = await this.loadFileOption(fp);
    if (O.isNone(loaded)) return [];
    const l = loaded.value;
    await this.openOrUpdate(l.clients, l.absPath, l.uri, l.langId, l.content);
    return this.collectRequestResults(l.clients, DocumentSymbolRequest.method, async (client) =>
      this.normalizeSymbols(await client.connection.sendRequest(DocumentSymbolRequest.type, { textDocument: { uri: l.uri } })),
    );
  }

  async renameOption(fp: string, line: number, col: number, newName: string): Promise<O.Option<WorkspaceEdit>> {
    const loaded = await this.loadFileOption(fp);
    if (O.isNone(loaded)) return O.none;
    const l = loaded.value;
    // Use heavy path: open + didSave to trigger semantic analysis before rename.
    await this.openOrUpdateForAnalysis(l.clients, l.absPath, l.uri, l.langId, l.content);

    const pos = this.toPos(line, col);
    const deadline = Date.now() + (this.isTypeScriptLikePath(l.absPath) ? 4000 : 0);

    do {
      const result = await this.firstOptionRequest(l.clients, RenameRequest.method, (client) =>
        client.connection.sendRequest(RenameRequest.type, {
          textDocument: { uri: l.uri },
          position: pos,
          newName,
        }),
      );
      if (O.isSome(result) || Date.now() >= deadline) return result;

      await this.sleep(300);
      // Re-sync same content to trigger more TS analysis passes.
      await this.openOrUpdateForAnalysis(l.clients, l.absPath, l.uri, l.langId, l.content);
    } while (true);
  }

  async rename(fp: string, line: number, col: number, newName: string): Promise<WorkspaceEdit | null> {
    return pipe(
      await this.renameOption(fp, line, col, newName),
      O.getOrElse<WorkspaceEdit | null>(() => null),
    );
  }

  async getCodeActions(fp: string, startLine: number, startCol: number, endLine?: number, endCol?: number): Promise<(CodeAction | Command)[]> {
    const loaded = await this.loadFileOption(fp);
    if (O.isNone(loaded)) return [];
    const l = loaded.value;
    // Use heavy path: didSave triggers deeper analysis, giving better code action context.
    await this.openOrUpdateForAnalysis(l.clients, l.absPath, l.uri, l.langId, l.content);

    const start = this.toPos(startLine, startCol);
    const end = this.toPos(endLine ?? startLine, endCol ?? startCol);
    const range = { start, end };

    const diagnostics: Diagnostic[] = [];
    for (const c of l.clients) {
      const fileDiags = c.diagnostics.get(l.absPath) || [];
      for (const d of fileDiags) {
        if (this.rangesOverlap(d.range, range)) diagnostics.push(d);
      }
    }

    return this.collectRequestResults(l.clients, CodeActionRequest.method, async (client) => {
      const result = await client.connection.sendRequest(CodeActionRequest.type, {
        textDocument: { uri: l.uri },
        range,
        context: { diagnostics, only: [CodeActionKind.QuickFix, CodeActionKind.Refactor, CodeActionKind.Source] },
      });
      return result || [];
    });
  }

  private rangesOverlap(a: { start: { line: number; character: number }; end: { line: number; character: number } }, 
                        b: { start: { line: number; character: number }; end: { line: number; character: number } }): boolean {
    if (a.end.line < b.start.line || b.end.line < a.start.line) return false;
    if (a.end.line === b.start.line && a.end.character < b.start.character) return false;
    if (b.end.line === a.start.line && b.end.character < a.start.character) return false;
    return true;
  }

  async shutdown() {
    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
    const clients = Array.from(this.clients.values());
    this.clients.clear();
    for (const c of clients) {
      const wasClosed = c.closed;
      c.closed = true;
      if (!wasClosed) {
        try {
          await Promise.race([
            c.connection.sendRequest("shutdown"),
            new Promise(r => setTimeout(r, 1000))
          ]);
        } catch {}
        try { void c.connection.sendNotification("exit").catch(() => {}); } catch {}
      }
      try { c.connection.end(); } catch {}
      try { c.process.kill(); } catch {}
    }
  }
}

// Diagnostic Formatting
export { DiagnosticSeverity };
export type SeverityFilter = "all" | "error" | "warning" | "info" | "hint";

export function formatDiagnostic(d: Diagnostic): string {
  const sev = ["", "ERROR", "WARN", "INFO", "HINT"][d.severity || 1];
  return `${sev} [${d.range.start.line + 1}:${d.range.start.character + 1}] ${d.message}`;
}

export function filterDiagnosticsBySeverity(diags: Diagnostic[], filter: SeverityFilter): Diagnostic[] {
  if (filter === "all") return diags;
  const max = { error: 1, warning: 2, info: 3, hint: 4 }[filter];
  return diags.filter(d => (d.severity || 1) <= max);
}

// URI utilities
export interface UriToPathError {
  _tag: "UriToPathError";
  uri: string;
  cause: unknown;
}

export interface SymbolPosition {
  line: number;
  character: number;
}

export function decodeFileUri(uri: string): E.Either<UriToPathError, string> {
  return E.tryCatch(
    () => fileURLToPath(uri),
    (cause): UriToPathError => ({
      _tag: "UriToPathError",
      uri,
      cause,
    }),
  );
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  return pipe(
    decodeFileUri(uri),
    E.getOrElse(() => uri),
  );
}

function symbolStart(sym: DocumentSymbol): O.Option<SymbolPosition> {
  return O.fromNullable(sym.selectionRange?.start ?? sym.range?.start);
}

function findSymbolMatch(
  symbols: ReadonlyArray<DocumentSymbol>,
  query: string,
  predicate: (name: string, normalizedQuery: string) => boolean,
): O.Option<SymbolPosition> {
  for (const sym of symbols) {
    const name = String(sym.name ?? "").toLowerCase();
    if (predicate(name, query)) {
      const current = symbolStart(sym);
      if (O.isSome(current)) return current;
    }

    if (sym.children?.length) {
      const child = findSymbolMatch(sym.children, query, predicate);
      if (O.isSome(child)) return child;
    }
  }

  return O.none;
}

// Symbol search
export function findSymbolPositionOption(symbols: DocumentSymbol[], query: string): O.Option<SymbolPosition> {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return O.none;

  return pipe(
    findSymbolMatch(symbols, normalized, (name, q) => name === q),
    O.alt(() => findSymbolMatch(symbols, normalized, (name, q) => name.includes(q))),
  );
}

export function findSymbolPosition(symbols: DocumentSymbol[], query: string): SymbolPosition | null {
  return pipe(
    findSymbolPositionOption(symbols, query),
    O.getOrElse<SymbolPosition | null>(() => null),
  );
}

export async function resolvePosition(manager: LSPManager, file: string, query: string): Promise<{ line: number; column: number } | null> {
  const symbols = await manager.getDocumentSymbols(file);
  return pipe(
    findSymbolPositionOption(symbols, query),
    O.match(
      () => null,
      (pos) => ({ line: pos.line + 1, column: pos.character + 1 }),
    ),
  );
}

/**
 * Format a list of document symbols into display lines.
 *
 * Uses `selectionRange` (the identifier's own range) rather than `range` (the
 * full declaration span) so that the reported line:column points at the symbol
 * name itself — the position that hover, definition, and references requests
 * all expect.  Falls back to `range` for servers that omit `selectionRange`.
 */
export function collectSymbols(symbols: DocumentSymbol[], depth = 0, lines: string[] = [], query?: string): string[] {
  const normalizedQuery = query?.toLowerCase();

  for (const sym of symbols) {
    const name = sym.name ?? "<unknown>";
    if (normalizedQuery && !name.toLowerCase().includes(normalizedQuery)) {
      if (sym.children?.length) collectSymbols(sym.children, depth + 1, lines, query);
      continue;
    }

    const loc = pipe(
      symbolStart(sym),
      O.match(
        () => "",
        (startPos) => `${startPos.line + 1}:${startPos.character + 1}`,
      ),
    );

    lines.push(`${"  ".repeat(depth)}${name}${loc ? ` (${loc})` : ""}`);
    if (sym.children?.length) collectSymbols(sym.children, depth + 1, lines, query);
  }
  return lines;
}
