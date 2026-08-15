import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import {
  CONTRACT_BASELINE_TAG,
  applyMigrationEntries,
  assertExactLedgerEntry,
  loadMigrationManifest,
  prepareDatabaseForRuntime,
  readLibraryMigrationState,
  readMigrationLedger,
} from '../server/db/migration-runner.js'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_FOLDER = join(PROJECT_ROOT, 'server', 'db', 'migrations')
const EXPECTED_LIBRARY_TABLES = [
  'assets',
  'batch_build_refs',
  'build_source_members',
  'build_validation_runs',
  'core_artifacts',
  'import_batches',
  'import_operations',
  'library_migration_state',
  'rom_asset_refs',
  'rom_builds',
]

function openDatabase(t, name = 'app.db') {
  const directory = mkdtempSync(join(tmpdir(), 'arcade-library-'))
  const path = join(directory, name)
  const sqlite = new Database(path)
  sqlite.pragma('foreign_keys = ON')
  t.after(() => {
    if (sqlite.open) sqlite.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { sqlite, path, directory }
}

function migrationEntries() {
  const manifest = loadMigrationManifest(MIGRATIONS_FOLDER)
  const tags = manifest.map((entry) => entry.tag)
  assert.deepEqual(
    tags.slice(0, 2),
    ['0000_baseline', '0001_arcade_library_expand'],
  )
  assert.equal(new Set(tags).size, tags.length)
  const expandIndex = tags.indexOf('0001_arcade_library_expand')
  return manifest.slice(0, expandIndex + 1)
}

function copyExpandMigrationFixture(destination) {
  const entries = migrationEntries()
  mkdirSync(join(destination, 'meta'), { recursive: true })
  for (const entry of entries) {
    cpSync(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      join(destination, `${entry.tag}.sql`),
    )
    const snapshotName = `${String(entry.idx).padStart(4, '0')}_snapshot.json`
    const snapshotPath = join(MIGRATIONS_FOLDER, 'meta', snapshotName)
    if (existsSync(snapshotPath)) {
      cpSync(snapshotPath, join(destination, 'meta', snapshotName))
    }
  }
  const checkedInJournal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  )
  writeFileSync(
    join(destination, 'meta', '_journal.json'),
    `${JSON.stringify(
      {
        ...checkedInJournal,
        entries: checkedInJournal.entries.slice(0, entries.length),
      },
      null,
      2,
    )}\n`,
  )
  return entries
}

function tableNames(sqlite) {
  return sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map(({ name }) => name)
}

function columnNames(sqlite, table) {
  return sqlite.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all().map(({ name }) => name)
}

function legacySnapshot(sqlite) {
  const selections = {
    users:
      'id, username, password_hash, role, status, created_at, updated_at',
    roms:
      'id, user_id, title, platform, file_name, file_path, file_size, is_public, parent_rom_id, version_label, status, created_at, updated_at',
    favorites: 'user_id, rom_id, created_at',
    rooms:
      'id, code, host_user_id, rom_id, name, is_public, allow_play, password_hash, status, created_at, updated_at, closed_at',
    save_states:
      'id, user_id, rom_id, slot, file_path, file_size, status, updated_at',
  }
  return {
    rows: Object.fromEntries(
      Object.entries(selections).map(([table, columns]) => [
        table,
        sqlite.prepare(`SELECT ${columns} FROM ${table} ORDER BY rowid`).all(),
      ]),
    ),
    sequence: sqlite
      .prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name')
      .all(),
    rootpages: sqlite
      .prepare(`
        SELECT name, rootpage
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('roms', 'favorites', 'rooms', 'save_states')
        ORDER BY name
      `)
      .all(),
    favoritesSql: sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'favorites'")
      .get().sql,
    sentinelObjects: sqlite
      .prepare(`
        SELECT type, name, tbl_name AS tableName, sql
        FROM sqlite_master
        WHERE name IN ('legacy_rom_title_probe', 'legacy_rom_update_probe')
        ORDER BY name
      `)
      .all(),
  }
}

function populateLegacyFixture(sqlite) {
  sqlite.exec(`
    CREATE INDEX legacy_rom_title_probe ON roms(title);
    CREATE TRIGGER legacy_rom_update_probe
      AFTER UPDATE OF title ON roms
      BEGIN
        SELECT 1;
      END;
    INSERT INTO users (id, username, password_hash, role, status)
      VALUES (7, 'owner', 'hash', 'admin', 1);
    INSERT INTO roms
      (id, user_id, title, platform, file_name, file_path, file_size, is_public, parent_rom_id, version_label, status)
      VALUES
      (1, 7, 'The King of Fighters 97', 'arcade', 'kof97.zip', 'roms/kof97.zip', 100, 1, NULL, 'parent', 1),
      (7, 7, 'Deleted Hack', 'arcade', 'hack.zip', 'roms/hack.zip', 200, 0, 1, 'hack', 0);
    INSERT INTO favorites (user_id, rom_id) VALUES (7, 1), (7, 7);
    INSERT INTO rooms
      (id, code, host_user_id, rom_id, name, is_public, allow_play, status, closed_at)
      VALUES (4, 'ROOM01', 7, 7, 'old room', 0, 1, 0, unixepoch());
    INSERT INTO save_states
      (id, user_id, rom_id, slot, file_path, file_size, status)
      VALUES (9, 7, 7, 2, 'saves/7/7/2.state', 321, 1);
    UPDATE sqlite_sequence SET seq = 41 WHERE name = 'users';
    UPDATE sqlite_sequence SET seq = 77 WHERE name = 'roms';
    UPDATE sqlite_sequence SET seq = 88 WHERE name = 'rooms';
    UPDATE sqlite_sequence SET seq = 99 WHERE name = 'save_states';
  `)
}

function insertBuildFixture(sqlite) {
  sqlite.exec(`
    INSERT INTO assets (id, kind, file_path, mime_type, file_size, sha256)
      VALUES
      (1, 'core_js', 'sha/11', 'text/javascript', 1, '${'1'.repeat(64)}'),
      (2, 'core_wasm', 'sha/22', 'application/wasm', 1, '${'2'.repeat(64)}'),
      (3, 'rom', 'sha/33', 'application/zip', 1, '${'3'.repeat(64)}');
    INSERT INTO core_artifacts
      (id, core_name, display_version, source_commit, js_asset_id, js_sha256,
       wasm_asset_id, wasm_sha256, artifact_fingerprint, is_enabled)
      VALUES
      (1, 'fbneo', '1.0', 'abc', 1, '${'1'.repeat(64)}', 2, '${'2'.repeat(64)}', '${'a'.repeat(64)}', 1);
    INSERT INTO rom_builds
      (id, rom_id, core_artifact_id, archive_asset_id, archive_sha256,
       content_manifest_sha256, build_fingerprint, static_status, archive_layout,
       runtime_parent_build_id)
      VALUES
      (10, 1, 1, 3, '${'3'.repeat(64)}', '${'4'.repeat(64)}', '${'b'.repeat(64)}', 'complete', 'standalone', NULL),
      (11, 7, 1, 3, '${'3'.repeat(64)}', '${'5'.repeat(64)}', '${'c'.repeat(64)}', 'complete', 'split', 10);
  `)
}

test('baseline metadata exactly describes the already-shipped baseline SQL', () => {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  )
  const snapshot = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '0000_snapshot.json'), 'utf8'),
  )

  assert.equal(journal.entries[0].tag, '0000_baseline')
  assert.equal(journal.entries[0].when, 1776699852299)
  assert.equal(snapshot.id, '39118c45-7452-4885-bc9e-e6d9ea3ce52c')
  assert.equal(snapshot.prevId, '00000000-0000-0000-0000-000000000000')
  assert.ok(snapshot.tables.roms.columns.parent_rom_id)
  assert.ok(snapshot.tables.roms.columns.version_label)
  assert.ok(snapshot.tables.roms.indexes.idx_roms_parent)
  assert.ok(snapshot.tables.favorites)
  assert.deepEqual(
    Object.values(snapshot.tables.favorites.compositePrimaryKeys)[0].columns,
    ['user_id', 'rom_id'],
  )
})

test('fresh database applies baseline plus expand-only library schema', (t) => {
  const { sqlite } = openDatabase(t)
  const entries = migrationEntries()

  applyMigrationEntries(sqlite, entries)

  assert.deepEqual(
    EXPECTED_LIBRARY_TABLES.filter((name) => !tableNames(sqlite).includes(name)),
    [],
  )
  const state = readLibraryMigrationState(sqlite)
  assert.equal(state.phase, 'expanded')
  assert.ok(Number.isInteger(state.updatedAt))
  assert.deepEqual(
    ['set_name_normalized', 'variant_kind', 'dat_parent_set_name', 'family_root_set_name', 'active_build_id', 'active_thumbnail_ref_id'].filter(
      (name) => !columnNames(sqlite, 'roms').includes(name),
    ),
    [],
  )
  assert.ok(columnNames(sqlite, 'rooms').includes('rom_build_id'))
  assert.deepEqual(
    [
      'rom_build_id',
      'build_fingerprint',
      'core_artifact_fingerprint',
      'content_manifest_sha256',
    ].filter(
      (name) => !columnNames(sqlite, 'save_states').includes(name),
    ),
    [],
  )
  assert.deepEqual(
    ['import_batch_id', 'member_role', 'member_order'].filter(
      (name) => !columnNames(sqlite, 'build_source_members').includes(name),
    ),
    [],
  )
  assert.equal(readMigrationLedger(sqlite).length, 2)
  for (const table of EXPECTED_LIBRARY_TABLES.filter(
    (name) => name !== 'library_migration_state',
  )) {
    assert.equal(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count,
      0,
      `${table} must be empty after expand`,
    )
  }
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS count FROM library_migration_state').get().count,
    1,
  )
})

test('expand preserves every legacy row, deleted ROM, child row, ID, and sequence', (t) => {
  const { sqlite } = openDatabase(t)
  const entries = migrationEntries()
  applyMigrationEntries(sqlite, [entries[0]])
  populateLegacyFixture(sqlite)
  const before = legacySnapshot(sqlite)

  applyMigrationEntries(sqlite, [entries[1]], { manifestEntries: entries })

  assert.deepEqual(legacySnapshot(sqlite), before)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM roms WHERE status = 0').get().count, 1)
  for (const column of [
    'set_name_normalized',
    'variant_kind',
    'dat_parent_set_name',
    'family_root_set_name',
    'active_build_id',
    'active_thumbnail_ref_id',
  ]) {
    assert.equal(
      sqlite.prepare(`SELECT COUNT(*) AS count FROM roms WHERE ${column} IS NOT NULL`).get().count,
      0,
    )
  }
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS count FROM rooms WHERE rom_build_id IS NOT NULL').get()
      .count,
    0,
  )
  assert.equal(
    sqlite
      .prepare(`
        SELECT COUNT(*) AS count FROM save_states
        WHERE rom_build_id IS NOT NULL
           OR build_fingerprint IS NOT NULL
           OR core_artifact_fingerprint IS NOT NULL
           OR content_manifest_sha256 IS NOT NULL
      `)
      .get().count,
    0,
  )
  assert.equal(sqlite.prepare('PRAGMA foreign_key_check').all().length, 0)
  assert.equal(sqlite.pragma('integrity_check', { simple: true }), 'ok')
})

test('expand is idempotent and migration phases can only advance', (t) => {
  const { sqlite } = openDatabase(t)
  const entries = migrationEntries()
  applyMigrationEntries(sqlite, entries)
  const firstLedger = readMigrationLedger(sqlite)

  applyMigrationEntries(sqlite, entries)
  assert.deepEqual(readMigrationLedger(sqlite), firstLedger)

  assert.throws(
    () =>
      sqlite
        .prepare(
          "INSERT OR REPLACE INTO library_migration_state (id, phase) VALUES (1, 'contracted')",
        )
        .run(),
    /cannot be reinserted|phase/i,
  )
  assert.equal(readLibraryMigrationState(sqlite).phase, 'expanded')

  assert.throws(
    () =>
      sqlite.prepare("UPDATE library_migration_state SET phase = 'contracted' WHERE id = 1").run(),
    /exactly one|skip|phase/i,
  )
  assert.equal(readLibraryMigrationState(sqlite).phase, 'expanded')
  sqlite.prepare("UPDATE library_migration_state SET phase = 'backfilled' WHERE id = 1").run()
  assert.equal(readLibraryMigrationState(sqlite).phase, 'backfilled')
  assert.throws(
    () =>
      sqlite.prepare("UPDATE library_migration_state SET phase = 'expanded' WHERE id = 1").run(),
    /exactly one|phase/i,
  )
  sqlite.prepare("UPDATE library_migration_state SET phase = 'contracted' WHERE id = 1").run()
  assert.equal(readLibraryMigrationState(sqlite).phase, 'contracted')
  assert.throws(
    () => sqlite.prepare('DELETE FROM library_migration_state WHERE id = 1').run(),
    /cannot be deleted/i,
  )
})

test('concurrent expand runners serialize without duplicating ledger rows', async (t) => {
  const { sqlite, path } = openDatabase(t)
  sqlite.pragma('busy_timeout = 10000')
  sqlite.exec(`
    CREATE TABLE "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    );
    BEGIN IMMEDIATE;
  `)

  const workerSource = `
    import Database from 'better-sqlite3'
    import { expandLibraryDatabase } from './server/db/migration-runner.js'
    const sqlite = new Database(process.argv[1], { timeout: 10_000 })
    sqlite.pragma('foreign_keys = ON')
    process.stdout.write('ready\\n')
    try {
      expandLibraryDatabase(sqlite, { migrationsFolder: process.argv[2] })
      process.stdout.write('ok\\n')
    } finally {
      sqlite.close()
    }
  `
  const startWorker = () => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', workerSource, path, MIGRATIONS_FOLDER],
      {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    let resolveReady
    const ready = new Promise((resolve) => {
      resolveReady = resolve
    })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.includes('ready\n')) resolveReady()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const result = new Promise((resolve) => {
      child.on('close', (status) => resolve({ status, stdout, stderr }))
    })
    return { child, ready, result }
  }

  const workers = [startWorker(), startWorker()]
  let lockHeld = true
  try {
    await Promise.all(workers.map(({ ready }) => ready))
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.ok(workers.every(({ child }) => child.exitCode === null))
    sqlite.exec('COMMIT')
    lockHeld = false

    const results = await Promise.all(workers.map(({ result }) => result))
    assert.ok(
      results.every(({ status }) => status === 0),
      JSON.stringify(results, null, 2),
    )
    assert.deepEqual(
      readMigrationLedger(sqlite).map(({ createdAt }) => Number(createdAt)),
      migrationEntries().map(({ folderMillis }) => folderMillis),
    )
  } finally {
    if (lockHeld) sqlite.exec('ROLLBACK')
    for (const { child } of workers) {
      if (child.exitCode === null) child.kill()
    }
  }
})

test('strict ledger validation rejects a wrong hash even at the correct timestamp', (t) => {
  const { sqlite } = openDatabase(t)
  const [baseline, expand] = migrationEntries()
  applyMigrationEntries(sqlite, [baseline])
  sqlite
    .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
    .run('0'.repeat(64), expand.folderMillis)

  assert.throws(() => assertExactLedgerEntry(sqlite, expand), /hash mismatch/i)
  assert.throws(
    () =>
      applyMigrationEntries(sqlite, [expand], {
        manifestEntries: [baseline, expand],
      }),
    /hash mismatch/i,
  )
})

test('legacy baseline accepts only its deterministic LF or CRLF hash variants', (t) => {
  const { sqlite } = openDatabase(t)
  const [baseline] = loadMigrationManifest(MIGRATIONS_FOLDER)
  applyMigrationEntries(sqlite, [baseline])
  const raw = readFileSync(join(MIGRATIONS_FOLDER, '0000_baseline.sql'), 'utf8')
  const lfHash = createHash('sha256')
    .update(raw.replace(/\r\n/g, '\n'), 'utf8')
    .digest('hex')
  const crlfHash = createHash('sha256')
    .update(raw.replace(/\r?\n/g, '\r\n'), 'utf8')
    .digest('hex')
  sqlite.prepare('UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?').run(
    baseline.hash === lfHash ? crlfHash : lfHash,
    baseline.folderMillis,
  )
  const warnings = []
  const accepted = assertExactLedgerEntry(sqlite, baseline, {
    onWarning: (warning) => warnings.push(warning),
  })
  assert.equal(accepted.legacyBaseline, true)
  assert.equal(warnings.length, 1)

  sqlite.prepare('UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?').run(
    '9'.repeat(64),
    baseline.folderMillis,
  )
  assert.throws(
    () => assertExactLedgerEntry(sqlite, baseline, { onWarning: () => {} }),
    /baseline.*hash mismatch|hash mismatch/i,
  )
})

test('strict ledger validation rejects the right hash at a wrong timestamp', (t) => {
  const { sqlite } = openDatabase(t)
  const [baseline, expand] = migrationEntries()
  applyMigrationEntries(sqlite, [baseline])
  sqlite
    .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
    .run(expand.hash, expand.folderMillis - 1)

  assert.throws(
    () =>
      applyMigrationEntries(sqlite, [expand], {
        manifestEntries: [baseline, expand],
      }),
    /unknown.*timestamp|missing|timestamp/i,
  )
})

test('strict ledger validation rejects a missing expand entry behind a later known migration', (t) => {
  const { sqlite } = openDatabase(t)
  const [baseline, expand] = migrationEntries()
  const future = {
    ...expand,
    idx: expand.idx + 1,
    tag: '0003_future_probe',
    folderMillis: expand.folderMillis + 1,
    hash: '8'.repeat(64),
    sql: ['CREATE TABLE future_probe (id integer PRIMARY KEY)'],
  }
  const manifest = [baseline, expand, future]
  applyMigrationEntries(sqlite, [baseline], { manifestEntries: manifest })
  sqlite
    .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
    .run(future.hash, future.folderMillis)

  assert.throws(
    () => applyMigrationEntries(sqlite, [expand], { manifestEntries: manifest }),
    /missing migration|behind ledger|prior migration/i,
  )
  assert.equal(tableNames(sqlite).includes('future_probe'), false)
})

test('baseline IF NOT EXISTS cannot bless a superficially incompatible database', (t) => {
  const { sqlite } = openDatabase(t)
  const [baseline] = loadMigrationManifest(MIGRATIONS_FOLDER)
  sqlite.exec('CREATE TABLE users (id integer PRIMARY KEY)')

  assert.throws(
    () => applyMigrationEntries(sqlite, [baseline]),
    /baseline|missing|no such column/i,
  )
  assert.deepEqual(readMigrationLedger(sqlite), [])
})

test('baseline shape rejects default drift even when names and types still match', (t) => {
  const { sqlite } = openDatabase(t)
  const [baseline] = loadMigrationManifest(MIGRATIONS_FOLDER)
  const baselineSql = readFileSync(
    join(MIGRATIONS_FOLDER, '0000_baseline.sql'),
    'utf8',
  )
  const romCreate = baselineSql
    .split('--> statement-breakpoint')[0]
    .replace('`status` integer DEFAULT 1 NOT NULL', '`status` integer DEFAULT 0 NOT NULL')
  sqlite.exec(romCreate)

  assert.throws(
    () => applyMigrationEntries(sqlite, [baseline]),
    /roms\.status.*default|default.*roms\.status/i,
  )
  assert.deepEqual(readMigrationLedger(sqlite), [])
})

test('baseline shape rejects nullability drift even when names and types still match', (t) => {
  const { sqlite } = openDatabase(t)
  const [baseline] = loadMigrationManifest(MIGRATIONS_FOLDER)
  const baselineSql = readFileSync(
    join(MIGRATIONS_FOLDER, '0000_baseline.sql'),
    'utf8',
  )
  const romCreate = baselineSql
    .split('--> statement-breakpoint')[0]
    .replace('`status` integer DEFAULT 1 NOT NULL', '`status` integer DEFAULT 1')
  sqlite.exec(romCreate)

  assert.throws(
    () => applyMigrationEntries(sqlite, [baseline]),
    /roms\.status.*nullability|nullability.*roms\.status/i,
  )
  assert.deepEqual(readMigrationLedger(sqlite), [])
})

test('baseline shape rejects loss of AUTOINCREMENT semantics', (t) => {
  const { sqlite } = openDatabase(t)
  const [baseline] = loadMigrationManifest(MIGRATIONS_FOLDER)
  const baselineSql = readFileSync(
    join(MIGRATIONS_FOLDER, '0000_baseline.sql'),
    'utf8',
  )
  const romCreate = baselineSql
    .split('--> statement-breakpoint')[0]
    .replace('PRIMARY KEY AUTOINCREMENT', 'PRIMARY KEY')
  sqlite.exec(romCreate)

  assert.throws(
    () => applyMigrationEntries(sqlite, [baseline]),
    /roms\.id.*autoincrement|autoincrement.*roms\.id/i,
  )
  assert.deepEqual(readMigrationLedger(sqlite), [])
})

test('baseline shape rejects a partial replacement for a full unique index', (t) => {
  const { sqlite } = openDatabase(t)
  const [baseline] = loadMigrationManifest(MIGRATIONS_FOLDER)
  applyMigrationEntries(sqlite, [baseline])
  sqlite.exec(`
    DROP INDEX users_username_unique;
    CREATE UNIQUE INDEX users_username_unique
      ON users(username)
      WHERE status = 1;
  `)

  assert.throws(
    () => assertExactLedgerEntry(sqlite, baseline),
    /users_username_unique.*partial|index users_username_unique.*drifted/i,
  )
})

test('a failed expand transaction leaves legacy data and the migration ledger intact', (t) => {
  const { sqlite } = openDatabase(t)
  const [baseline, expand] = migrationEntries()
  applyMigrationEntries(sqlite, [baseline])
  populateLegacyFixture(sqlite)
  const before = legacySnapshot(sqlite)
  const ledgerBefore = readMigrationLedger(sqlite)

  const forcedFailure = {
    ...expand,
    tag: '0001_forced_failure',
    hash: 'f'.repeat(64),
    sql: [...expand.sql, 'THIS IS NOT VALID SQLITE'],
  }
  assert.throws(
    () =>
      applyMigrationEntries(sqlite, [forcedFailure], {
        manifestEntries: [baseline, forcedFailure],
      }),
    /syntax|near/i,
  )
  assert.equal(tableNames(sqlite).includes('library_migration_state'), false)
  assert.deepEqual(
    EXPECTED_LIBRARY_TABLES.filter((name) => tableNames(sqlite).includes(name)),
    [],
  )
  assert.equal(columnNames(sqlite, 'roms').includes('active_build_id'), false)
  assert.equal(columnNames(sqlite, 'rooms').includes('rom_build_id'), false)
  assert.equal(columnNames(sqlite, 'save_states').includes('build_fingerprint'), false)
  assert.deepEqual(legacySnapshot(sqlite), before)
  assert.deepEqual(readMigrationLedger(sqlite), ledgerBefore)
})

test('expanded schema enforces one accepted run per build and runtime-parent restrict', (t) => {
  const { sqlite } = openDatabase(t)
  applyMigrationEntries(sqlite, migrationEntries())
  populateLegacyFixture(sqlite)
  insertBuildFixture(sqlite)

  sqlite.exec(`
    INSERT INTO build_validation_runs
      (rom_build_id, browser_sha256, harness_version, core_artifact_fingerprint,
       result, acceptance, accepted_at, policy_version)
      VALUES (10, '${'d'.repeat(64)}', 'h1', '${'a'.repeat(64)}', 'passed', 'accepted', unixepoch(), 'p1');
  `)
  assert.throws(
    () =>
      sqlite.exec(`
        INSERT INTO build_validation_runs
          (rom_build_id, browser_sha256, harness_version, core_artifact_fingerprint,
           result, acceptance, accepted_at, policy_version)
          VALUES (10, '${'e'.repeat(64)}', 'h1', '${'a'.repeat(64)}', 'failed', 'accepted', unixepoch(), 'p1');
      `),
    /unique/i,
  )
  assert.throws(
    () =>
      sqlite.exec(`
        INSERT INTO build_validation_runs
          (rom_build_id, browser_sha256, harness_version, core_artifact_fingerprint,
           result, acceptance, accepted_at, policy_version)
          VALUES (11, '${'f'.repeat(64)}', 'h1', '${'a'.repeat(64)}', 'inconclusive', 'accepted', unixepoch(), 'p1');
      `),
    /check constraint/i,
  )
  assert.throws(() => sqlite.prepare('DELETE FROM rom_builds WHERE id = 10').run(), /foreign key/i)
})

test('runtime applies only through expand and refuses before seed or future migrations', (t) => {
  const { sqlite, path, directory } = openDatabase(t)
  const futureMigrations = join(directory, 'migrations')
  copyExpandMigrationFixture(futureMigrations)
  const journalPath = join(futureMigrations, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  const lastEntry = journal.entries.at(-1)
  journal.entries.push({
    idx: lastEntry.idx + 1,
    version: '6',
    when: lastEntry.when + 1,
    tag: '0003_future_probe',
    breakpoints: true,
  })
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  writeFileSync(
    join(futureMigrations, '0003_future_probe.sql'),
    'CREATE TABLE future_probe (id integer PRIMARY KEY);\n',
  )

  assert.throws(
    () => prepareDatabaseForRuntime(sqlite, { migrationsFolder: futureMigrations }),
    /phase.*expanded.*migrate-library\.js/i,
  )
  assert.equal(readLibraryMigrationState(sqlite).phase, 'expanded')
  assert.equal(tableNames(sqlite).includes('future_probe'), false)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)

  sqlite.close()
  const processResult = spawnSync(process.execPath, ['server/index.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DB_PATH: path,
      PORT: '-1',
      ADMIN_USERNAME: 'must-not-be-seeded',
      ADMIN_PASSWORD: 'must-not-be-seeded',
    },
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  })
  assert.notEqual(processResult.status, 0)
  assert.match(`${processResult.stdout}\n${processResult.stderr}`, /migrate-library\.js/i)

  const reopened = new Database(path, { readonly: true })
  try {
    assert.equal(reopened.prepare('SELECT COUNT(*) AS count FROM users').get().count, 0)
  } finally {
    reopened.close()
  }
})

test('runtime requires the contract baseline immediately after expand', (t) => {
  const { sqlite, directory } = openDatabase(t)
  applyMigrationEntries(sqlite, migrationEntries())
  sqlite.prepare("UPDATE library_migration_state SET phase = 'backfilled' WHERE id = 1").run()
  sqlite.prepare("UPDATE library_migration_state SET phase = 'contracted' WHERE id = 1").run()

  const reorderedMigrations = join(directory, 'migrations-reordered')
  copyExpandMigrationFixture(reorderedMigrations)
  const journalPath = join(reorderedMigrations, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  const expandEntry = journal.entries.at(-1)
  journal.entries.push(
    {
      idx: expandEntry.idx + 1,
      version: '6',
      when: expandEntry.when + 1,
      tag: '0003_future_probe',
      breakpoints: true,
    },
    {
      idx: expandEntry.idx + 2,
      version: '6',
      when: expandEntry.when + 2,
      tag: CONTRACT_BASELINE_TAG,
      breakpoints: true,
    },
  )
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  writeFileSync(
    join(reorderedMigrations, '0003_future_probe.sql'),
    'CREATE TABLE future_probe (id integer PRIMARY KEY);\n',
  )
  writeFileSync(
    join(reorderedMigrations, `${CONTRACT_BASELINE_TAG}.sql`),
    'SELECT 1;\n',
  )
  const reorderedManifest = loadMigrationManifest(reorderedMigrations)
  const contract = reorderedManifest.find(
    ({ tag }) => tag === CONTRACT_BASELINE_TAG,
  )
  sqlite
    .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
    .run(contract.hash, contract.folderMillis)

  assert.throws(
    () =>
      prepareDatabaseForRuntime(sqlite, {
        migrationsFolder: reorderedMigrations,
      }),
    /contract baseline.*immediately follow|migration ordering/i,
  )
  assert.equal(tableNames(sqlite).includes('future_probe'), false)
})

test('contracted runtime still accepts the known baseline line-ending hash variant', (t) => {
  const { sqlite, directory } = openDatabase(t)
  const contractedMigrations = join(directory, 'migrations-contracted')
  copyExpandMigrationFixture(contractedMigrations)
  const journalPath = join(contractedMigrations, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  const expandEntry = journal.entries.at(-1)
  journal.entries.push({
    idx: expandEntry.idx + 1,
    version: '6',
    when: expandEntry.when + 1,
    tag: CONTRACT_BASELINE_TAG,
    breakpoints: true,
  })
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  writeFileSync(
    join(contractedMigrations, `${CONTRACT_BASELINE_TAG}.sql`),
    'SELECT 1;\n',
  )

  const manifest = loadMigrationManifest(contractedMigrations)
  const [baseline, expand, contract] = manifest
  applyMigrationEntries(sqlite, [baseline, expand], { manifestEntries: manifest })
  sqlite.prepare("UPDATE library_migration_state SET phase = 'backfilled' WHERE id = 1").run()
  sqlite.prepare("UPDATE library_migration_state SET phase = 'contracted' WHERE id = 1").run()
  sqlite
    .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
    .run(contract.hash, contract.folderMillis)

  const baselineSql = readFileSync(
    join(contractedMigrations, '0000_baseline.sql'),
    'utf8',
  )
  const alternateHash = createHash('sha256')
    .update(baselineSql.replace(/\r?\n/g, '\r\n'), 'utf8')
    .digest('hex')
  assert.notEqual(alternateHash, baseline.hash)
  sqlite
    .prepare('UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?')
    .run(alternateHash, baseline.folderMillis)

  const warnings = []
  const result = prepareDatabaseForRuntime(sqlite, {
    migrationsFolder: contractedMigrations,
    onWarning: (warning) => warnings.push(warning),
  })
  assert.equal(result.state.phase, 'contracted')
  assert.ok(warnings.length >= 1)
})

test('Task 1 CLI exposes status/expand and fails closed for later phases', (t) => {
  const { path } = openDatabase(t)
  const run = (mode) =>
    spawnSync(process.execPath, ['scripts/migrate-library.js', mode], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DB_PATH: path },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })

  const initialStatus = run('status')
  assert.equal(initialStatus.status, 0, initialStatus.stderr)
  assert.equal(JSON.parse(initialStatus.stdout).phase, 'absent')

  const expand = run('expand')
  assert.equal(expand.status, 0, expand.stderr)
  assert.equal(JSON.parse(expand.stdout).phase, 'expanded')

  for (const mode of ['backfill', 'contract', 'all']) {
    const result = run(mode)
    assert.notEqual(result.status, 0, `${mode} unexpectedly succeeded`)
    assert.match(`${result.stdout}\n${result.stderr}`, /not available until Task [23]/i)
  }
})

test('status refuses a missing database without creating its parent directory', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'arcade-status-missing-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const missingParent = join(directory, 'does-not-exist', 'nested')
  const missingDatabase = join(missingParent, 'app.db')

  const result = spawnSync(process.execPath, ['scripts/migrate-library.js', 'status'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, DB_PATH: missingDatabase },
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  })

  assert.notEqual(result.status, 0)
  assert.match(`${result.stdout}\n${result.stderr}`, /database|exist|open/i)
  assert.equal(existsSync(missingParent), false)
  assert.equal(existsSync(missingDatabase), false)
})

test('status classifies exact, legacy line-ending, and invalid hashes without writes', (t) => {
  const { sqlite, path } = openDatabase(t)
  const [baseline] = migrationEntries()
  applyMigrationEntries(sqlite, [baseline])
  const runStatus = () =>
    spawnSync(process.execPath, ['scripts/migrate-library.js', 'status'], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DB_PATH: path },
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    })
  const readStatus = () => {
    const before = readFileSync(path)
    const result = runStatus()
    const after = readFileSync(path)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(after, before, 'status must not mutate database bytes')
    return JSON.parse(result.stdout)
  }

  const exact = readStatus()
  assert.equal(exact.ledger[0].hashStatus, 'exact')
  assert.equal('hashMatches' in exact.ledger[0], false)

  const baselineSql = readFileSync(
    join(MIGRATIONS_FOLDER, '0000_baseline.sql'),
    'utf8',
  )
  const crlfHash = createHash('sha256')
    .update(baselineSql.replace(/\r?\n/g, '\r\n'), 'utf8')
    .digest('hex')
  assert.notEqual(crlfHash, baseline.hash)
  sqlite
    .prepare('UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?')
    .run(crlfHash, baseline.folderMillis)
  assert.equal(readStatus().ledger[0].hashStatus, 'legacy_line_endings')

  sqlite
    .prepare('UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?')
    .run('7'.repeat(64), baseline.folderMillis)
  assert.equal(readStatus().ledger[0].hashStatus, 'invalid')
})

test('expand SQL is LF-pinned and contains no destructive legacy-table operation', () => {
  const attributes = readFileSync(join(PROJECT_ROOT, '.gitattributes'), 'utf8')
  assert.match(attributes, /^server\/db\/migrations\/\*\.sql text eol=lf$/m)
  assert.match(attributes, /^server\/db\/contract-migrations\/\*\.sql text eol=lf$/m)

  const migrationPath = join(MIGRATIONS_FOLDER, '0001_arcade_library_expand.sql')
  const bytes = readFileSync(migrationPath)
  const sql = bytes.toString('utf8')
  for (const sqlPath of [
    join(MIGRATIONS_FOLDER, '0000_baseline.sql'),
    migrationPath,
    join(
      PROJECT_ROOT,
      'server',
      'db',
      'contract-migrations',
      '0001_arcade_library_contract.sql',
    ),
  ]) {
    assert.equal(
      readFileSync(sqlPath).includes(13),
      false,
      `${sqlPath} contains CR bytes`,
    )
  }
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i)
  assert.doesNotMatch(sql, /\bALTER\s+TABLE\b[^;]*\bRENAME\b/i)
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\s+(?:`)?(?:roms|favorites|rooms|save_states)(?:`)?/i)
  assert.doesNotMatch(sql, /\bUPDATE\s+(?:`)?(?:roms|favorites|rooms|save_states)(?:`)?/i)

  const legacyAlterStatements = [
    ...sql.matchAll(
      /ALTER TABLE\s+`?(roms|rooms|save_states)`?\s+ADD\s+(?:COLUMN\s+)?([^;]+);/gi,
    ),
  ]
  assert.equal(legacyAlterStatements.length, 11)
  assert.ok(legacyAlterStatements.every(([, , definition]) => !/\bNOT\s+NULL\b/i.test(definition)))
})

test('Task 1 contract SQL is inert, fail-closed, and outside runtime migrations', (t) => {
  if (
    loadMigrationManifest(MIGRATIONS_FOLDER).some(
      ({ tag }) => tag === CONTRACT_BASELINE_TAG,
    )
  ) {
    t.skip('the real Task 3 contract baseline is now checked in')
    return
  }
  const contractSql = readFileSync(
    join(
      PROJECT_ROOT,
      'server',
      'db',
      'contract-migrations',
      '0001_arcade_library_contract.sql',
    ),
    'utf8',
  )
  assert.match(contractSql, /requires_task_3/i)
  assert.doesNotMatch(contractSql, /\b(?:DROP|ALTER|DELETE|UPDATE|INSERT|CREATE)\b/i)

  const runtimeRunner = readFileSync(
    join(PROJECT_ROOT, 'server', 'db', 'migration-runner.js'),
    'utf8',
  )
  assert.doesNotMatch(runtimeRunner, /contract-migrations/)
})

test('checked-in expanded snapshot produces no new drizzle migration', (t) => {
  const scratchRoot = join(PROJECT_ROOT, '.superpowers', 'test-tmp')
  mkdirSync(scratchRoot, { recursive: true })
  const directory = mkdtempSync(join(scratchRoot, 'drizzle-generate-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  mkdirSync(join(directory, 'server', 'db'), { recursive: true })
  cpSync(join(PROJECT_ROOT, 'server', 'db', 'schema.js'), join(directory, 'server', 'db', 'schema.js'))
  cpSync(MIGRATIONS_FOLDER, join(directory, 'server', 'db', 'migrations'), {
    recursive: true,
  })
  writeFileSync(
    join(directory, 'drizzle.config.js'),
    `import { defineConfig } from 'drizzle-kit'\nexport default defineConfig({ dialect: 'sqlite', schema: './server/db/schema.js', out: './server/db/migrations', casing: 'snake_case' })\n`,
  )
  const before = readdirSync(join(directory, 'server', 'db', 'migrations')).filter((name) =>
    name.endsWith('.sql'),
  )

  const result = spawnSync(
    process.execPath,
    [join(PROJECT_ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs'), 'generate', '--config', 'drizzle.config.js'],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    },
  )
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(`${result.stdout}\n${result.stderr}`, /No schema changes/i)
  const after = readdirSync(join(directory, 'server', 'db', 'migrations')).filter((name) =>
    name.endsWith('.sql'),
  )
  assert.deepEqual(after, before)

  const runnerSource = readFileSync(
    join(PROJECT_ROOT, 'server', 'db', 'migration-runner.js'),
    'utf8',
  )
  const expand = migrationEntries()[1]
  assert.equal(runnerSource.includes(expand.hash), false, 'runtime must not hard-code SQL hashes')
})
