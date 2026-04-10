---
name: use-lsp
description: Use the lsp tool effectively for semantic code navigation, diagnostics, rename, and code actions in supported projects. Load this when the task involves definitions, references, type info, safe renames, or validating edits with language-server feedback.
---

# Use LSP

Use this skill when the workspace has LSP support and the task is about **symbols**, **types**, **references**, **refactors**, or **diagnostics**.

## Prefer `lsp` over text search for semantic tasks

Use `lsp` for:

- go to definition
- find references
- hover or type information
- list symbols in a file
- rename a symbol safely
- inspect code actions / quick fixes
- run diagnostics after edits

Use `bash` / `read` first only when you do **not** know the relevant file yet.

## Recommended workflow

1. If unsure whether the workspace supports LSP, call:
   - `lsp action=status`
2. If the file path is unknown:
   - use `bash` / `read` to find likely files
3. For symbol-aware questions:
   - use `lsp action=definition|references|hover|signature|symbols`
4. After making edits in supported languages:
   - use `lsp action=diagnostics` for one file
   - use `lsp action=workspace-diagnostics` for multiple touched files
5. If `lsp` reports unsupported or times out:
   - explain that limitation
   - fall back to `read` / `bash`

## Query-based resolution

For actions like `definition`, `references`, `hover`, `signature`, and `rename`, you can often pass:

- `file`
- `query`

instead of exact `line` / `column`.

Use that when you know the symbol name but not its exact position.

## Good patterns

- "Where is `foo` defined in `src/bar.ts`?" → `lsp action=definition file=... query=foo`
- "Find all references to `getManager`" → locate file, then `lsp action=references`
- "Rename `oldName` to `newName`" → `lsp action=rename`
- "What errors remain after my edits?" → `lsp action=workspace-diagnostics`
- "What quick fix is available here?" → `lsp action=codeAction`

## Avoid

- using `grep` as the primary tool for type or reference questions in supported projects
- doing manual multi-file rename plans when `lsp rename` can provide a semantic edit set
- skipping diagnostics after non-trivial edits in supported languages
