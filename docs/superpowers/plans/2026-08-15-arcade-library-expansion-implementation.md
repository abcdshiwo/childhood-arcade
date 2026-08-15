# Arcade Library Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` for isolated file domains, `test-driven-development` for every behavior change, and `verification-before-completion` before every commit and deployment gate.

**Goal:** Deliver the fixed in-game toolbar, CRT arcade gallery, content-addressed thumbnails, immutable multi-core ROM builds, and the complete W165 candidate ledger on `arcade.abcds.de`, with every published game tied to an accepted runtime validation and every source file retained.

**Architecture:** Keep the current Nostalgist host-streaming room model. Split logical games from immutable ROM builds and append-only validation runs. Store ROM/core/BIOS/thumbnail assets by hash in shared data, bind rooms and saves to an exact build, and import the W165 archive through a trusted offline batch pipeline. Static DAT/source completeness creates a private candidate only; an accepted isolated-browser pass creates the public subset.

**Tech stack:** Vue 3, Vite, Hono, better-sqlite3/Drizzle, Nostalgist 0.21, RetroArch Emscripten, FBNeo, MAME2003-Plus, FBA2012, Node 24 test runner, Vitest/Vue Test Utils, Python 3 zip/Pillow batch tooling, Playwright 1.58.2 bundled Headless Shell revision 1208, systemd, Nginx, SSH ProxyJump.

**Non-negotiable boundaries:**

- Never launch system Chrome/Edge for ROM validation and never serve ROM/BIOS through a local `127.0.0.1` HTTP server.
- Do not put ROMs, the encrypted source archive, save samples, generated thumbnails, normalized ZIPs, validation evidence, or batch runtime output in Git.
- Preserve existing ROM IDs 1-7, including deleted rows, current files, favorites, saves, rooms, `sqlite_sequence`, service units, and unrelated Nginx sites.
- A static DAT/source match is `unverified`, not `ready`; only an accepted `passed` validation may publish a build.
- Normal batch rollback reverses only recorded batch operations. Whole-database restore is allowed only before production writes reopen.
- The implementation order is strict: contracts -> expand -> legacy backfill -> contract -> APIs/rooms/saves -> toolbar -> gallery -> importer -> smoke -> deploy. Tasks that share `roms.js`, `Player.vue`, `global.css`, or `package*.json` do not run concurrently.

---

## Task 0: Freeze hash-pinned non-ROM contract inputs

**Files:**

- Create `tools/arcade-import/contracts/README.md`
- Create compact contract manifests under `tools/arcade-import/contracts/`
- Create `tools/arcade-import/contracts/SHA256SUMS.txt`
- Add the three audited FBA2012 JS/WASM artifacts under `data/cores/`
- Modify `.gitignore`
- Create `scripts/check-arcade-staged-files.mjs`
- Create `scripts/run-test-suite.mjs`
- Create `test/contract-inputs.test.js`
- Create `vitest.config.js`
- Modify `package.json` and `package-lock.json`

- [ ] Write failing tests for exact manifest counts/hashes, unique selected rows, core provenance, path allowlists, and rejection of ROM/save/generated-image extensions from the Git index.
- [ ] Freeze the authoritative audit inputs before schema/backfill work: FBNeo 277, MAME2003-Plus incremental 97, folded FBA2012 282, total 656 driver rows and 655 distinct byte contracts.
- [ ] Include exact core/DAT/source provenance, alias folding, parent dependencies, normalized relation kind, and thumbnail mapping evidence. Call these manifests **hash-pinned**, not signed; `SHA256SUMS.txt` is the trust anchor and no public-key signature is claimed.
- [ ] Copy only audited FBA2012 runtime core JS/WASM files whose hashes match the frozen manifest; never download a replacement at runtime.
- [ ] Install the complete test foundation before feature tasks: pinned `playwright-core@1.58.2` without browser download, Vitest, Vue Test Utils, and a DOM test environment. Define `test:node`, `test:component`, and `test:browser` scripts; make `npm test` execute all three suites through a cross-platform runner.
- [ ] Configure Vitest to include nested `test/components/**/*.test.js`; configure the browser runner to include `test/browser/**/*.spec.mjs`. Add a canary test proving each script discovers at least one intended test so nested suites cannot silently be skipped.
- [ ] Force all generated ROMs, thumbnails, evidence, source extracts, and batch working files to paths outside the worktree. Add path-level ignores plus a staged-file guard that fails CI if forbidden assets enter Git.
- [ ] Verify `656` unique selected rows, `655` contracts, relation totals `227 parent + 361 clone + 4 hack + 64 bootleg`, thumbnail totals `463 direct/alias + 53 parent + 140 source-reference`, and all five enabled core contracts.
- [ ] Commit as `chore: freeze arcade import contracts`.

## Task 1: Expand-only schema and explicit migration orchestration

**Files:**

- Create `test/library-expand-migration.test.js`
- Create `test/build-contract.test.js`
- Create `server/services/build-contract.js`
- Modify `server/db/schema.js`
- Create `server/db/migrations/0001_arcade_library_expand.sql`
- Modify `server/db/migrations/meta/_journal.json`
- Create/update `server/db/migrations/meta/0001_snapshot.json`
- Create `server/db/contract-migrations/0001_arcade_library_contract.sql`
- Create `scripts/migrate-library.js`
- Modify `server/db/index.js`

- [ ] Write failing tests for build fingerprint canonicalization, static/validation status mapping, one accepted validation per build, active build/thumbnail same-ROM ownership, parent delete restriction, migration phase guards, and legacy row/ID preservation.
- [ ] Make the normal Drizzle migration strictly **expand-only**: create `core_artifacts`, `assets`, `import_batches`, `rom_builds`, `build_validation_runs`, `batch_build_refs`, `build_source_members`, `rom_asset_refs`, `import_operations`, and a migration-state table; add only nullable compatibility columns to existing tables.
- [ ] Do not drop or rebuild `roms`, `favorites`, `rooms`, or `save_states` in the Drizzle migration. Automatic startup migration must never be able to consume the contract migration.
- [ ] Add a dedicated `scripts/migrate-library.js` orchestrator with `status`, `expand`, `backfill`, `contract`, and `all` modes. It must run JavaScript backfill between the two SQL phases and refuse unsafe phase skips.
- [ ] Move the destructive table rebuild to the out-of-band contract SQL/runner. Apply `PRAGMA foreign_keys=OFF` **before** `BEGIN IMMEDIATE`, rebuild/copy/rename every affected parent and child table, recreate indexes/triggers, restore `sqlite_sequence`, run `foreign_key_check` and `integrity_check` before commit, then re-enable foreign keys.
- [ ] Make runtime startup apply only expand-safe migrations and refuse to start the new application code unless the library migration state is `contracted`, with a clear operator message.
- [ ] Prove on a disposable baseline DB that expand alone changes no legacy row counts or IDs and that a forced failure leaves the source DB intact.
- [ ] Commit as `feat: add phased arcade library migration`.

## Task 2: Content store and complete legacy backfill

**Files:**

- Create `server/services/content-store.js`
- Create `server/services/library-service.js`
- Create `server/services/legacy-backfill.js`
- Create `scripts/backfill-legacy-library.js`
- Create `test/content-store.test.js`
- Create `test/legacy-backfill.test.js`
- Modify `deploy/childhood-arcade.env.example`

- [ ] Write failing tests for path containment, content-addressed atomic writes, deduplication/refcounts, immutable core fingerprints, all-existing-row coverage, deleted-row preservation, and idempotent legacy backfill.
- [ ] Store shared assets under `LIBRARY_ASSET_ROOT` by full SHA-256; temporary writes must verify size/hash before atomic rename.
- [ ] Register existing FBNeo/MAME JS/WASM, exact DAT, BIOS, and current ROM files from their actual hashes; do not infer a build from a filename.
- [ ] Backfill **every** existing ROM row, including soft-deleted rows, into an immutable legacy build without changing ROM IDs or replacing source files. Populate active build, room build, save build/core fingerprints, favorite ownership, parent references, and thumbnail refs where applicable.
- [ ] Preserve the old seven public games as `unverified` candidates until Task 9 validates their exact current fingerprints; no fabricated accepted run is allowed.
- [ ] Make backfill dry-run the default, emit before/after JSON evidence, and require an explicit apply flag from the migration orchestrator.
- [ ] Verify two consecutive backfills are identical and the second performs zero writes.
- [ ] Commit as `feat: add content store and legacy builds`.

## Task 3: Contract migration with child-row preservation

**Files:**

- Create `test/library-contract-migration.test.js`
- Extend `scripts/migrate-library.js`
- Modify `server/db/contract-migrations/0001_arcade_library_contract.sql`
- Modify `server/db/schema.js`
- Create `server/db/migrations/0002_arcade_library_contract_baseline.sql`
- Modify `server/db/migrations/meta/_journal.json`
- Create `server/db/migrations/meta/0002_snapshot.json`

- [ ] Build a fixture DB containing active/deleted ROMs, non-default `sqlite_sequence`, favorites, open/closed rooms, saves, parent/clone relations, and duplicate asset references; snapshot all rows before migration.
- [ ] Require migration phase `backfilled`, a fresh consistent backup path, and zero missing build refs before contract may start.
- [ ] Rebuild `roms`, `favorites`, `rooms`, and `save_states` with real composite ownership/foreign-key constraints while preserving every row, ID, deletion timestamp, sequence, and child relation.
- [ ] Make room canonical state `rom_build_id`; add build/core/content fingerprints to saves; enforce active build/thumbnail same-ROM ownership and runtime-parent restrictions.
- [ ] On any copy/count/hash/FK/integrity mismatch, roll back the transaction and leave phase `backfilled`; never partially mark it contracted.
- [ ] After contract succeeds, record the exact `0002` migration hash/timestamp in Drizzle's migration ledger and advance the checked-in metadata to a final contracted `0002_snapshot`. Runtime startup must never execute `0002` early; the explicit orchestrator is the only component allowed to apply/mark it.
- [ ] Run a schema-generation/check test against the contracted fixture and assert the current `server/db/schema.js` produces zero pending diff. This prevents future `drizzle-kit` runs from rediscovering the already-applied contract changes.
- [ ] Verify exact before/after row and digest equality, `PRAGMA foreign_key_check` empty, `PRAGMA integrity_check='ok'`, and a second contract attempt is a no-op.
- [ ] Commit as `feat: enforce arcade build ownership`.

## Task 4: Build-addressed ROM/core APIs and CRUD compatibility

**Files:**

- Create `test/rom-build-api.test.js`
- Modify `server/routes/roms.js`
- Modify `server/routes/cores.js`
- Modify `server/routes/bios.js`
- Modify `server/routes/admin.js`
- Modify `src/api/client.js`
- Modify `src/data/config.js`
- Modify `src/composables/nostalgist.js`
- Modify `src/views/MyRoms.vue`
- Modify `src/views/Admin.vue`

- [ ] Write failing service/API tests for public accepted-ready filtering, private unverified manual uploads, build-addressed file authorization, retired build room access, core selection by build, soft delete/restore, and reference-protected hard delete.
- [ ] Add build-addressed ROM/dependency routes and versioned core/BIOS artifact routes. A split clone response must authorize and return the exact parent build plus child build, in deterministic mount order.
- [ ] Refactor public/mine/admin serializers to return logical ROM plus active build/core/thumbnail metadata.
- [ ] Make normal upload create a logical ROM, content asset, manual build, and private/unverified active build in one transaction; retain the ordinary visitor upload size limit while trusted batch import bypasses it through a separate offline path.
- [ ] Remove runtime reliance on `platform.cores[0]` and `roms.filePath`; Nostalgist must use URLs for the exact build artifacts and mount both parent/child ZIPs when required.
- [ ] Keep old API fields temporarily where required by current UI, derive them from active build, and cover their eventual removal with tests.
- [ ] Commit as `feat: serve immutable rom builds`.

## Task 5: Rooms and saves lock exact builds

**Files:**

- Create `test/room-build-lock.test.js`
- Create `test/save-build-lock.test.js`
- Modify `server/routes/rooms.js`
- Modify `server/routes/rooms-ws.js`
- Modify `server/room-hub.js`
- Modify `server/routes/saves.js`
- Modify `src/api/client.js`
- Modify `src/components/CreateRoomDialog.vue`
- Modify `src/components/EditRoomDialog.vue`
- Modify `src/views/Rooms.vue`
- Modify `src/views/Player.vue`

- [ ] Write failing tests proving room creation revalidates an accepted ready active build server-side, the room remains on its original build after gallery updates, cross-ROM build IDs are rejected, and room players receive parent dependencies.
- [ ] Make Player in room mode load only `room.romBuildId`; it must never resolve the logical ROM's newer active build.
- [ ] Include build/set/version/core labels in room responses and disable ROM/version switching in `EditRoomDialog` and Player after the room is created.
- [ ] Key cloud save-state paths, API parameters, and browser storage by build ID plus core/content fingerprint; isolate legacy local keys instead of auto-loading them into a new build.
- [ ] When an unassigned legacy localStorage save is found, show a one-time manual-import prompt with the source warning. Never auto-load it. Explicit import copies it into the currently displayed exact build only after confirmation; dismiss/import writes a tombstone so the same legacy key is not prompted again. Test accept, dismiss, reload, wrong-build isolation, and tombstone behavior.
- [ ] Ensure build retirement and batch rollback never delete room-referenced builds or user save files.
- [ ] Commit as `feat: lock rooms and saves to rom builds`.

## Task 6: Persistent toolbar and reliable coin/start controls

**Files:**

- Create `test/control-pulse.test.js`
- Extend `test/emulator-canvas.test.js`
- Create `test/components/game-overlay.test.js`
- Create `test/browser/player-toolbar.spec.mjs`
- Modify `src/components/emulator-portal/GameOverlay.vue`
- Modify `src/components/emulator-portal/EmulatorPortal.vue`
- Modify `src/composables/useWebRTC.js`
- Modify `src/views/Player.vue`
- Modify `src/assets/global.css`

- [ ] Add a real Vue component test stack and write failing rendered-component tests for toolbar visibility during metadata load, core load, guest wait, error, reconnect, and player-container fullscreen.
- [ ] Write failing tests for a reliable ordered `controls` DataChannel, `peerSessionEpoch + sequence` IDs, ACK/retry, deduplication, boot-frozen P1/P2 mappings, and cleanup on disconnect/unmount.
- [ ] Add visible `投币` and `开始` buttons for arcade; use platform-appropriate Select/Start labels elsewhere.
- [ ] Local host/solo pulses must use the verified global dispatcher and hold the boot-frozen key for 150 ms.
- [ ] Guest pulses execute only on the host; realtime movement/action messages remain on the existing low-latency channel.
- [ ] Fullscreen the entire player container so the toolbar remains visible.
- [ ] Run a real bundled-browser UI test for solo and two-context host/guest P2 controls; source-regex tests alone are not an acceptance gate.
- [ ] Commit as `feat: add reliable arcade toolbar controls`.

## Task 7: CRT gallery and content-addressed thumbnails

**Files:**

- Create `test/thumbnail-api.test.js`
- Create `test/components/gallery.test.js`
- Create `test/browser/gallery.spec.mjs`
- Modify `server/routes/roms.js`
- Modify `src/views/Gallery.vue`
- Modify `src/components/VersionPickerDialog.vue` or retire it from gallery flow
- Modify `src/App.vue`
- Modify `src/assets/global.css`

- [ ] Write failing API tests for full-SHA thumbnail URLs, active thumbnail refs, exact/alias/parent/source-reference labels, immutable caching, hash mismatch 404, and shared asset refcounts.
- [ ] Write rendered-component/browser tests for 500+ cards, lazy loading, keyboard focus, reduced motion, filters, stable image frames, and responsive behavior.
- [ ] Implement `/api/roms/:id/thumbnail?v=<64-char-sha256>` using active refs only.
- [ ] Render every variant as its own card with title, set, core, version, official/HACK/bootleg/clone badges, and explicit `参考图` labels.
- [ ] Apply the approved CRT neon visual system, stable 4:3 image frames, lazy loading, visible keyboard focus, reduced-motion support, and responsive layout.
- [ ] Search/filter by title, set, version, core, platform, and variant type.
- [ ] Commit as `feat: redesign the arcade gallery`.

## Task 8: Trusted W165 importer and closed candidate ledger

**Files:**

- Create `tools/arcade-import/prepare_batch.py`
- Create `tools/arcade-import/verify_batch.py`
- Create `tools/arcade-import/commit_batch.js`
- Create `tools/arcade-import/rollback_batch.js`
- Create `tools/arcade-import/README.md`
- Create `test/import-manifest.test.js`
- Create `test/import-rollback.test.js`

- [ ] Write failing tests for path traversal rejection, global size+CRC lookup, deterministic ZIP names/content, split/standalone plans, alias collapse, thumbnail match kinds, dry-run, idempotency, and operation-log rollback.
- [ ] Derive the immutable candidate manifest from Task 0: exactly 656 unique driver rows and 655 distinct byte contracts. Never replace it with the smaller publish subset.
- [ ] Build normalized ZIPs from the 241 source ZIP byte pool, keep the encrypted source archive as cold source, and preserve all auxiliary folders plus the 35 save samples in batch evidence.
- [ ] For all 98 split clones, record the exact parent build dependency, authorize both assets, and generate a two-ZIP runtime mount plan; standalone candidates must have no undeclared parent.
- [ ] Convert 493 unique screenshots to content-addressed WebP; emit exactly 463 direct/alias, 53 parent, and 140 source-reference links, with zero missing display images.
- [ ] Keep NVRAM candidates archival only; assert no `.fs`/`.nv` is written into runtime save directories.
- [ ] Persist exactly one resolution row for each of the 656 candidates, plus every operation in the ledger. A candidate's final compatibility state may be `ready`, `blocked`, `unsupported`, or `unverified`; it must never disappear.
- [ ] Make dry-run the default; run it twice and prove byte-identical manifests and zero second-run writes.
- [ ] Commit importer/rollback tools only; keep normalized ROMs, thumbnails, and evidence outside Git.

## Task 9: Isolated browser validation and publish derivation

**Files:**

- Create `tools/arcade-smoke/run-smoke.mjs`
- Create `tools/arcade-smoke/derive-publish-manifest.mjs`
- Create `tools/arcade-smoke/capture-production-legacy.mjs`
- Create `tools/arcade-smoke/README.md`
- Create `test/smoke-contract.test.js`

- [ ] Write failing tests for the exact Headless Shell path/hash, isolated per-case profiles, route whitelist, zero download events/files, zero listener ports, result schema, retry policy, and append-only evidence.
- [ ] Pin the execution contract: bundled Headless Shell revision 1208, executable SHA-256 `AC9BC025ED6BE1BA6CF403116A68D2467C3E8DA03844E642498E77CC2C799AC2`, service workers blocked, `acceptDownloads=false`, virtual `.invalid` origin, and catch-all network abort.
- [ ] Run the 1 KiB no-ROM canary and prove no system Chrome/Edge, external download manager/window/process, localhost file server, or unapproved network request is invoked.
- [ ] Before validating IDs 1-7, take a non-mutating-source, consistent SQLite online-backup snapshot from production and stage the exact DB mapping plus every referenced ROM/core/BIOS byte file outside the worktree through `scp -O -J`. Record remote path, size, and SHA-256; local staging or filename assumptions are not authoritative.
- [ ] Validate those authoritative production fingerprints as a separate legacy deployment gate. Reuse an older pass only when build fingerprint, all asset hashes, core artifact fingerprint, BIOS fingerprint, and harness contract are byte-identical. Legacy runs do not change the 656-row W165 candidate ledger.
- [ ] Enforce skip-existing reconciliation: an identical fingerprint reuses the legacy build; a different fingerprint creates a separate candidate build without replacing the existing file or ROM ID. Publish derivation selects at most one active build for each logical ROM.
- [ ] Validate representative standalone and split builds across all five enabled cores, including two-ZIP parent/child mounting, before the full run.
- [ ] Run all 656 candidates at conservative concurrency. Key each run by build fingerprint plus ROM/parent/core/BIOS hashes and the harness contract, not rehearsal database IDs. Retries append new runs, so raw validation-run count may exceed 656.
- [ ] Raw validation outcomes are only `passed`, `failed`, or `inconclusive`; a timeout is a structured `failureCode`, while `unsupported` belongs to the candidate's static/final compatibility state rather than a browser-run outcome.
- [ ] Resolve exactly one final candidate state from the append-only runs without deleting attempts. Assert 656 unique candidate-resolution rows, 655 contracts, no missing/duplicate/extra candidate, final-state totals summing to 656, thumbnail totals `463+53+140=656`, coverage of all five cores, and both split/standalone modes.
- [ ] Persist all raw attempts as private evidence. Derive a separate publish manifest containing one selected active build per logical ROM where the candidate is `ready` and its accepted run is `passed`; never mutate or truncate the 656-row candidate manifest.
- [ ] Gate deployment on IDs 1-7 being accepted, public, and startable. If any fails, keep the old release/DB live and fix or explicitly remove that release from scope before retrying.
- [ ] Commit the harness and derivation code only; keep profiles/results/screenshots outside Git.

## Task 10: Build release, transfer, migrate, import, and deploy

**Files:**

- Create `scripts/backup-library-db.js`
- Extend deployment docs/scripts for maintenance, migrate-only mode, shared asset paths, and batch rollback.
- Generated release/batch artifacts stay outside Git.

- [ ] Run full local gate: `npm ci`, `npm test`, component/browser tests, `npm run build`, `npm audit --omit=dev`, syntax checks, staged-asset guard, expand/backfill/contract on a production DB copy, `git diff --check`.
- [ ] Create an immutable release and a chunked batch with per-file and per-chunk SHA-256 manifests.
- [ ] Transfer with Windows legacy SCP through the measured jump host: `scp.exe -O -J root@43.159.2.240:59222 -P 59222 ... root@160.236.110.53:...`; use 64/128 MiB resumable chunks and never store a proxy-side ROM copy. Do not use the known-hanging SFTP path.
- [ ] Verify remote hashes and disk headroom; assemble under `/srv/childhood-arcade/shared/data/import-staging/<batch-id>`.
- [ ] Rehearse expand -> JavaScript backfill -> contract -> batch import -> smoke/public derivation on a copied production DB and representative assets.
- [ ] Enter short write maintenance. Before any destructive migration, freeze writes and create a consistent better-sqlite3 backup with the new CLI; verify its digest and open it read-only.
- [ ] Run the explicit migrate-only orchestrator, import the accepted subset plus complete private evidence, atomically switch release, and restart only `childhood-arcade.service`.
- [ ] Before writes reopen, prove old-release + DB-backup restore works and use it on failure. After writes reopen, prohibit whole-DB restore; use forward fixes or the callable operation-log batch rollback CLI.
- [ ] Verify systemd active/enabled, health timer, tunnel, Nginx config, SQLite integrity/FKs, unrelated sites, IDs 1-7 public/startable, saves/favorites/rooms preserved, public card count equals active selected ready logical-ROM rows (not raw passed-run count), thumbnails, room join, locked room build, split clone mounting, and P1/P2 toolbar controls.
- [ ] Keep the previous release, verified disaster backup, cold source, hash-pinned manifests, complete candidate ledger, publish manifest, and validation evidence.

## Completion gate

- [ ] Toolbar remains visible and coin/start works for solo, host, and guest in real browser tests and production.
- [ ] Gallery is visibly redesigned, handles 500+ cards, and every published variant has a truthful thumbnail match label.
- [ ] All 241 source ZIPs and auxiliary files are retained in cold source/evidence; generated assets remain outside Git.
- [ ] The candidate-resolution ledger contains exactly 656 rows and 655 byte contracts with a final compatibility status for every row; append-only validation attempts may exceed 656, and only selected builds with an accepted passed run are public.
- [ ] Existing IDs 1-7 remain public and startable with exact accepted fingerprints.
- [ ] Every public ROM starts with its recorded core/build; split clones mount their exact parent; rooms and saves never cross builds.
- [ ] Production is healthy, persistent, restart-safe, rollback-capable, and independently verified without harming other sites/services or opening a system download window.
