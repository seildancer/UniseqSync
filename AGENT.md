## Uniseq

Local-first, file-first outliner PKM desktop app built with Tauri + React + Milkdown. Markdown files are the only durable product truth. All other state (caches, refs, hierarchy, watcher state) is derived and disposable.

## Codebase Layout

- `src/` — Rust backend crate (`uniseq-backend`). Core types, parser, page identity, reference indexing, filesystem ops, watcher.
- `src-tauri/` — Tauri desktop shell. Bridges backend to the frontend via Tauri commands, owns DTO serialization and app-level persistence (last workspace path, page order store).
- `web/` — React frontend. Editor UI, page tree, stream UI, navigation, polling.

## Page Model

Two page kinds, both file-backed:

| Kind | Location | File naming | Page ID |
|---|---|---|---|
| Regular | `pages/` | flat: `A___B___C.md` | `pages:A/B/C` |
| Stream | top-level stream folder | `yyyy_mm_dd.md` | `stream:journals/2026_05_07` |

Stream folders (`journals/`, `diary/`, any non-reserved folder containing only `yyyy_mm_dd.md` files) are storage buckets only — they have no page hierarchy. Regular and stream pages with the same visible segments are distinct identities. Stream pages are not targetable via `[[Page]]` syntax.

Reserved top-level folders: `pages/`, `assets/`, `uniseq/`. `prepare_workspace_root` backfills these plus `journals/` and `diary/` on open.

## Block Model

The backend only understands two block kinds:
- `Outliner` — line starting with `-` followed by end-of-line, space, or tab
- `Plaintext` — everything else (including blank lines that survive as separators)

No general Markdown parsing. References inside fenced code blocks are ignored. Indentation-only code blocks are not special.

Page references: `[[Page]]` and `#Page`. Only `block → page` references, never `block → block`. Missing reference targets are materialized as empty files on discovery.

## Write Model

- **Content writes** are frontend-driven via `write_page_content`. Writes are optimistic; the caller may supply an expected file fingerprint revision to detect conflicts. Rust reparses immediately and updates derived state.
- **Structural mutations** are backend-owned: create, rename, move, merge, delete (pages and streams). These go through `apply_*` operations with transaction recovery — interrupted ops replay to their recorded final state rather than rolling back.
- **Virtual stream writes** (`write_virtual_stream_page`) create the file only if content is non-empty. This enables lazy file creation in the stream editor.

## Discovery And Reconciliation

- Discovery scans the workspace, loads pages into `WorkspaceCache`, and materializes missing parent pages and missing reference targets.
- `WorkspaceSession` owns the live cache, filesystem snapshot, event queue, and watcher.
- Watcher: native by default, polling fallback on failure.
- Incremental reconciliation handles known-file modifications. Full refresh handles structural changes (creates, deletes, renames, watcher bursts).
- Frontend invalidation events: `WorkspaceReloaded`, `PagesChanged`, `PageRemoved`, watcher mode/degradation events. Frontend polls `drain_workspace_events`.

## Page Ordering

Page sibling order is stored in `workspace-page-order.json` in the app config directory (not inside the workspace). The store is normalized on every read — unknown page IDs are dropped, new pages appended alphabetically. Rename, move, and delete automatically remap or remove the affected subtree in the store.

## Search

`search_pages` queries title, page ID, and content. Results are ranked (title matches first) and include a content snippet for content matches.

## Design Decisions

- **File-first, no hidden DB.** The markdown files are the product. The cache is always reconstructible from files.
- **Flat block model.** No durable block UUIDs. Block identity is a source span within a page revision (`BlockHandle`). Stale handles are rejected.
- **Single parser, minimal semantics.** The backend only parses what it needs (block structure + page refs). It does not implement general Markdown.
- **Frontend owns content, backend owns structure.** The line is clear: content text through `write_page_content`; creates/renames/moves/deletes through structural commands.
- **Stream pages are append-only date buckets.** They don't participate in hierarchy, aren't ref targets, and support lazy creation via virtual writes.
- **No `block → block` references, no global block IDs.** These are explicit non-goals.
