import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

import {
  CONTRACT_BASELINE_TAG,
  applyMigrationEntries,
  loadMigrationManifest,
  prepareDatabaseForRuntime,
  readLibraryMigrationState,
  readMigrationLedger,
} from '../server/db/migration-runner.js'
import {
  CONTRACT_SQL_PATH,
  computeContractSchemaSha256,
  contractLibraryDatabase,
} from '../server/db/contract-runner.js'
import { assertContractedSchema } from '../server/db/contract-schema.js'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIGRATIONS_FOLDER = join(PROJECT_ROOT, 'server', 'db', 'migrations')
const SHA = Object.freeze({
  js: '1'.repeat(64),
  wasm: '2'.repeat(64),
  archive: '3'.repeat(64),
  thumbnail: '4'.repeat(64),
  contentParent: '5'.repeat(64),
  contentClone: '6'.repeat(64),
  core: 'a'.repeat(64),
  buildParent: 'b'.repeat(64),
  buildClone: 'c'.repeat(64),
})

function expandedEntries() {
  const manifest = loadMigrationManifest(MIGRATIONS_FOLDER)
  const expandIndex = manifest.findIndex(
    ({ tag }) => tag === '0001_arcade_library_expand',
  )
  assert.ok(expandIndex >= 0)
  return manifest.slice(0, expandIndex + 1)
}

function openFixture(t, { phase = 'backfilled', missingPointers = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'arcade-contract-'))
  const dbPath = join(directory, 'app.db')
  const sqlite = new Database(dbPath)
  sqlite.pragma('foreign_keys = ON')
  applyMigrationEntries(sqlite, expandedEntries(), {
    manifestEntries: loadMigrationManifest(MIGRATIONS_FOLDER),
  })
  populateBackfilledFixture(sqlite, { missingPointers })
  if (phase === 'backfilled') {
    sqlite
      .prepare("UPDATE library_migration_state SET phase = 'backfilled' WHERE id = 1")
      .run()
  } else {
    assert.equal(phase, 'expanded')
  }
  sqlite.close()
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    dbPath,
    backupPath: join(directory, 'backups', 'before-contract.sqlite'),
  }
}

function populateBackfilledFixture(sqlite, { missingPointers = false } = {}) {
  sqlite.exec(`
    INSERT INTO users
      (id, username, password_hash, role, status, created_at, updated_at)
      VALUES (7, 'owner', 'hash', 'admin', 1, 1700000000, 1700000001);

    INSERT INTO settings (key, value, updated_at)
      VALUES ('unrelated-setting', 'must-survive', 1700000002);

    INSERT INTO roms
      (id, user_id, title, platform, file_name, file_path, file_size,
       is_public, parent_rom_id, version_label, status, created_at, updated_at,
       set_name_normalized, variant_kind, dat_parent_set_name,
       family_root_set_name, active_build_id, active_thumbnail_ref_id)
      VALUES
      (1, 7, 'The King of Fighters 97', 'arcade', 'kof97.zip',
       'roms/kof97.zip', 100, 1, NULL, 'parent', 1, 1700000010,
       1700000011, 'kof97', NULL, NULL, 'kof97', NULL, NULL),
      (7, 7, 'Deleted Hack', 'arcade', 'kof97pls.zip',
       'roms/kof97pls.zip', 200, 0, 1, 'hack', 0, 1700000020,
       1700000021, 'kof97pls', 'hack', 'kof97', 'kof97', NULL, NULL);

    INSERT INTO assets
      (id, kind, file_path, mime_type, file_size, sha256, created_at)
      VALUES
      (1, 'core_js', 'sha256/11', 'text/javascript', 1, '${SHA.js}', 1700000030),
      (2, 'core_wasm', 'sha256/22', 'application/wasm', 1, '${SHA.wasm}', 1700000031),
      (3, 'rom', 'sha256/33', 'application/zip', 1, '${SHA.archive}', 1700000032),
      (4, 'thumbnail', 'sha256/44', 'image/webp', 1, '${SHA.thumbnail}', 1700000033);

    INSERT INTO core_artifacts
      (id, core_name, display_version, source_commit, js_asset_id, js_sha256,
       wasm_asset_id, wasm_sha256, dat_asset_id, dat_sha256, bios_asset_id,
       bios_manifest_sha256, artifact_fingerprint, provenance_json,
       is_enabled, created_at)
      VALUES
      (1, 'fbneo', '1.0', 'abc', 1, '${SHA.js}', 2, '${SHA.wasm}',
       NULL, NULL, NULL, NULL, '${SHA.core}', '{}', 1, 1700000040);

    INSERT INTO rom_builds
      (id, rom_id, core_artifact_id, archive_asset_id, archive_sha256,
       content_manifest_sha256, build_fingerprint, static_status,
       static_failure_code, static_failure_details_json, archive_layout,
       runtime_parent_build_id, created_at)
      VALUES
      (10, 1, 1, 3, '${SHA.archive}', '${SHA.contentParent}',
       '${SHA.buildParent}', 'complete', NULL, NULL, 'standalone', NULL,
       1700000050),
      (11, 7, 1, 3, '${SHA.archive}', '${SHA.contentClone}',
       '${SHA.buildClone}', 'complete', NULL, NULL, 'split', 10,
       1700000051);

    INSERT INTO rom_asset_refs
      (id, rom_id, asset_id, match_kind, source_set_name,
       source_file_sha256, import_batch_id, created_at)
      VALUES
      (20, 1, 4, 'exact', 'kof97', '${SHA.thumbnail}', NULL, 1700000060),
      (21, 7, 4, 'parent', 'kof97', '${SHA.thumbnail}', NULL, 1700000061);

    UPDATE roms
      SET active_build_id = 10, active_thumbnail_ref_id = 20
      WHERE id = 1;
    UPDATE roms
      SET active_build_id = 11, active_thumbnail_ref_id = 21
      WHERE id = 7;

    INSERT INTO favorites (user_id, rom_id, created_at)
      VALUES (7, 1, 1700000070), (7, 7, 1700000071);

    INSERT INTO rooms
      (id, code, host_user_id, rom_id, name, is_public, allow_play,
       password_hash, status, created_at, updated_at, closed_at, rom_build_id)
      VALUES
      (4, 'OPEN01', 7, 1, 'open room', 1, 1, NULL, 1,
       1700000080, 1700000081, NULL, 10),
      (5, 'CLOSE1', 7, 7, 'closed room', 0, 0, 'pw', 0,
       1700000082, 1700000083, 1700000084, 11);

    INSERT INTO save_states
      (id, user_id, rom_id, slot, file_path, file_size, status, updated_at,
       rom_build_id, build_fingerprint, core_artifact_fingerprint,
       content_manifest_sha256)
      VALUES
      (9, 7, 1, 0, 'saves/7/1/0.state', 321, 1, 1700000090,
       10, '${SHA.buildParent}', '${SHA.core}', '${SHA.contentParent}'),
      (10, 7, 7, 2, 'saves/7/7/2.state', 654, 0, 1700000091,
       11, '${SHA.buildClone}', '${SHA.core}', '${SHA.contentClone}');

    CREATE TABLE unmanaged_contract_audit (
      id integer PRIMARY KEY AUTOINCREMENT,
      rom_id integer NOT NULL,
      title text NOT NULL
    );
    CREATE TABLE unmanaged_external_probe (
      id integer PRIMARY KEY AUTOINCREMENT,
      rom_id integer NOT NULL
    );
    CREATE INDEX legacy_rom_title_probe ON roms(title);
    CREATE TRIGGER legacy_rom_update_probe
      AFTER UPDATE OF title ON roms
      BEGIN
        INSERT INTO unmanaged_contract_audit (rom_id, title)
        VALUES (NEW.id, NEW.title);
      END;
    CREATE VIEW legacy_room_catalog AS
      SELECT rooms.id, rooms.code, roms.title
      FROM rooms JOIN roms ON roms.id = rooms.rom_id;
    CREATE TRIGGER legacy_external_rom_probe
      AFTER INSERT ON unmanaged_external_probe
      BEGIN
        SELECT title FROM roms WHERE id = NEW.rom_id;
      END;

    UPDATE sqlite_sequence SET seq = 41 WHERE name = 'users';
    UPDATE sqlite_sequence SET seq = 77 WHERE name = 'roms';
    UPDATE sqlite_sequence SET seq = 88 WHERE name = 'rooms';
    UPDATE sqlite_sequence SET seq = 99 WHERE name = 'save_states';
    UPDATE sqlite_sequence SET seq = 123 WHERE name = 'assets';
    UPDATE sqlite_sequence SET seq = 124 WHERE name = 'core_artifacts';
    UPDATE sqlite_sequence SET seq = 125 WHERE name = 'rom_builds';
    UPDATE sqlite_sequence SET seq = 126 WHERE name = 'rom_asset_refs';
    UPDATE sqlite_sequence SET seq = 127 WHERE name = 'unmanaged_contract_audit';
  `)

  if (missingPointers) {
    sqlite.prepare('UPDATE rooms SET rom_build_id = NULL WHERE id = 5').run()
  }
}

function snapshotRows(sqlite) {
  const order = {
    roms: 'id',
    favorites: 'user_id, rom_id',
    rooms: 'id',
    save_states: 'id',
    assets: 'id',
    core_artifacts: 'id',
    rom_builds: 'id',
    rom_asset_refs: 'id',
  }
  return {
    tables: Object.fromEntries(
      Object.entries(order).map(([table, columns]) => [
        table,
        sqlite.prepare(`SELECT * FROM ${table} ORDER BY ${columns}`).all(),
      ]),
    ),
    sequence: sqlite
      .prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name')
      .all(),
    unmanaged: sqlite
      .prepare(`
        SELECT type, name, tbl_name AS tableName, sql
        FROM sqlite_master
        WHERE name IN (
          'legacy_rom_title_probe',
          'legacy_rom_update_probe',
          'legacy_external_rom_probe',
          'legacy_room_catalog'
        )
        ORDER BY type, name
      `)
      .all(),
  }
}

function readSnapshot(dbPath, { readonly = true } = {}) {
  const sqlite = new Database(dbPath, { readonly, fileMustExist: true })
  if (!readonly) sqlite.pragma('foreign_keys = ON')
  try {
    return snapshotRows(sqlite)
  } finally {
    sqlite.close()
  }
}

function digestFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function tableColumn(sqlite, table, column) {
  return sqlite
    .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all()
    .find(({ name }) => name === column)
}

test('contract preserves every child row, deleted ROM, relation, duplicate ref, sequence, and unmanaged object', async (t) => {
  const { dbPath, backupPath } = openFixture(t)
  const before = readSnapshot(dbPath)

  const evidence = await contractLibraryDatabase({
    dbPath,
    backupPath,
    migrationsFolder: MIGRATIONS_FOLDER,
  })

  assert.equal(evidence.kind, 'arcade-library-contract-evidence-v1')
  assert.equal(evidence.noop, false)
  assert.deepEqual(evidence.phase, { before: 'backfilled', after: 'contracted' })
  assert.equal(evidence.backup.path, backupPath)
  assert.equal(evidence.backup.integrityCheck, 'ok')
  assert.equal(evidence.backup.foreignKeyViolationCount, 0)
  assert.equal(evidence.rollback, null)
  assert.equal(evidence.checks.rowsPreserved, true)
  assert.equal(evidence.checks.sequencePreserved, true)
  assert.equal(evidence.checks.unmanagedObjectsPreserved, true)
  assert.equal(evidence.migration.tag, CONTRACT_BASELINE_TAG)

  assert.equal(isAbsolute(evidence.backup.path), true)
  assert.equal(existsSync(backupPath), true)
  assert.ok(lstatSync(backupPath).size > 0)
  assert.equal(digestFile(backupPath), evidence.backup.sha256)
  assert.deepEqual(readSnapshot(backupPath), before)

  const sqlite = new Database(dbPath)
  sqlite.pragma('foreign_keys = ON')
  try {
    const after = snapshotRows(sqlite)
    assert.deepEqual(after, before)
    assert.equal(readLibraryMigrationState(sqlite).phase, 'contracted')
    assert.equal(sqlite.pragma('integrity_check', { simple: true }), 'ok')
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), [])

    assert.equal(tableColumn(sqlite, 'roms', 'active_build_id').notnull, 0)
    assert.equal(tableColumn(sqlite, 'rooms', 'rom_build_id').notnull, 1)
    for (const column of [
      'rom_build_id',
      'build_fingerprint',
      'core_artifact_fingerprint',
      'content_manifest_sha256',
    ]) {
      assert.equal(tableColumn(sqlite, 'save_states', column).notnull, 1)
    }
    assert.equal(
      sqlite.prepare('SELECT variant_kind FROM roms WHERE id = 1').get()
        .variant_kind,
      null,
      'variant_kind must remain nullable',
    )
    assert.throws(
      () =>
        sqlite.exec(`
          INSERT INTO roms
            (user_id, title, platform, file_name, file_path, file_size,
             is_public, set_name_normalized, variant_kind, status)
          VALUES
            (7, 'Uppercase shortname', 'arcade', 'upper.zip',
             'roms/upper.zip', 1, 0, 'UPPER', 'official', 1);
        `),
      /check constraint|set_name_normalized/i,
    )

    assert.throws(
      () => sqlite.prepare('UPDATE roms SET active_build_id = 11 WHERE id = 1').run(),
      /foreign key/i,
    )
    assert.throws(
      () =>
        sqlite
          .prepare('UPDATE roms SET active_thumbnail_ref_id = 21 WHERE id = 1')
          .run(),
      /foreign key/i,
    )
    assert.throws(
      () => sqlite.prepare('UPDATE rooms SET rom_build_id = 11 WHERE id = 4').run(),
      /foreign key/i,
    )
    assert.throws(
      () =>
        sqlite
          .prepare(
            `UPDATE save_states SET build_fingerprint = '${SHA.buildClone}' WHERE id = 9`,
          )
          .run(),
      /save state|build identity|constraint/i,
    )
    assert.throws(
      () =>
        sqlite.exec(`
          INSERT INTO rom_builds
            (rom_id, core_artifact_id, archive_asset_id, archive_sha256,
             content_manifest_sha256, build_fingerprint, static_status,
             archive_layout, runtime_parent_build_id)
          VALUES
            (1, 1, 3, '${SHA.archive}', '${'7'.repeat(64)}',
             '${'d'.repeat(64)}', 'complete', 'split', 11);
        `),
      /runtime parent|direct parent|standalone/i,
    )
    assert.throws(
      () =>
        sqlite
          .prepare("UPDATE rom_builds SET static_status = 'blocked' WHERE id = 10")
          .run(),
      /immutable|runtime parent|build/i,
    )
    assert.throws(
      () =>
        sqlite
          .prepare(`UPDATE core_artifacts SET artifact_fingerprint = '${'e'.repeat(64)}' WHERE id = 1`)
          .run(),
      /immutable|core artifact/i,
    )
    assert.throws(
      () =>
        sqlite
          .prepare(`UPDATE assets SET sha256 = '${'f'.repeat(64)}' WHERE id = 1`)
          .run(),
      /immutable|asset identity/i,
    )
    assert.throws(
      () =>
        sqlite
          .prepare("UPDATE roms SET set_name_normalized = 'other' WHERE id = 1")
          .run(),
      /immutable|runtime parent|ROM contract/i,
    )

    sqlite.prepare("UPDATE roms SET title = 'KOF 97' WHERE id = 1").run()
    assert.deepEqual(
      sqlite
        .prepare('SELECT rom_id, title FROM unmanaged_contract_audit ORDER BY id')
        .all(),
      [{ rom_id: 1, title: 'KOF 97' }],
    )
    assert.equal(
      sqlite.prepare('SELECT COUNT(*) AS count FROM legacy_room_catalog').get()
        .count,
      2,
    )
    sqlite.prepare('INSERT INTO unmanaged_external_probe (rom_id) VALUES (1)').run()
  } finally {
    sqlite.close()
  }
})

test('a second contract is a strict no-op and rejects schema or ledger drift', async (t) => {
  const { dbPath, backupPath, directory } = openFixture(t)
  await contractLibraryDatabase({
    dbPath,
    backupPath,
    migrationsFolder: MIGRATIONS_FOLDER,
  })
  const backupBytes = readFileSync(backupPath)
  const secondBackup = join(directory, 'must-not-be-created.sqlite')

  const noop = await contractLibraryDatabase({
    dbPath,
    backupPath: secondBackup,
    migrationsFolder: MIGRATIONS_FOLDER,
  })
  assert.equal(noop.noop, true)
  assert.deepEqual(noop.phase, { before: 'contracted', after: 'contracted' })
  assert.equal(noop.backup, null)
  assert.equal(existsSync(secondBackup), false)
  assert.deepEqual(readFileSync(backupPath), backupBytes)

  const sqlite = new Database(dbPath)
  let originalTriggerSql
  try {
    originalTriggerSql = sqlite
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'save_states_build_identity_insert'",
      )
      .get().sql
    sqlite.exec(`
      DROP TRIGGER save_states_build_identity_insert;
      CREATE TRIGGER save_states_build_identity_insert
      BEFORE INSERT ON save_states
      BEGIN
        SELECT 1;
      END;
    `)
  } finally {
    sqlite.close()
  }
  const driftedRuntime = new Database(dbPath)
  driftedRuntime.pragma('foreign_keys = ON')
  try {
    assert.throws(
      () =>
        prepareDatabaseForRuntime(driftedRuntime, {
          migrationsFolder: MIGRATIONS_FOLDER,
        }),
      /contracted trigger save_states_build_identity_insert.*drift/i,
    )
  } finally {
    driftedRuntime.close()
  }
  await assert.rejects(
    contractLibraryDatabase({
      dbPath,
      backupPath: join(directory, 'drift.sqlite'),
      migrationsFolder: MIGRATIONS_FOLDER,
    }),
    /contracted schema|save_states_build_identity_insert|drift/i,
  )
  assert.equal(existsSync(join(directory, 'drift.sqlite')), false)

  const indexDrift = new Database(dbPath)
  try {
    indexDrift.exec(`
      DROP TRIGGER save_states_build_identity_insert;
      ${originalTriggerSql};
      DROP INDEX idx_roms_active_build;
      CREATE INDEX idx_roms_active_build ON roms (title);
    `)
  } finally {
    indexDrift.close()
  }
  await assert.rejects(
    contractLibraryDatabase({
      dbPath,
      backupPath: join(directory, 'index-drift.sqlite'),
      migrationsFolder: MIGRATIONS_FOLDER,
    }),
    /contracted schema|idx_roms_active_build|drift/i,
  )
  assert.equal(existsSync(join(directory, 'index-drift.sqlite')), false)
})

test('strict no-op rejects column defaults, checks, and room index drift', async (t) => {
  const cases = [
    {
      name: 'column-default',
      mutate(sqlite) {
        const tableSql = sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'rooms'")
          .get().sql
        const drifted = tableSql.replace(
          '`is_public` integer DEFAULT true NOT NULL',
          '`is_public` integer DEFAULT false NOT NULL',
        )
        assert.notEqual(drifted, tableSql)
        sqlite.unsafeMode(true)
        sqlite.pragma('writable_schema = ON')
        try {
          sqlite
            .prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'rooms'")
            .run(drifted)
        } finally {
          sqlite.pragma('writable_schema = OFF')
          sqlite.unsafeMode(false)
        }
      },
      error: /default.*drift|schema.*drift/i,
    },
    {
      name: 'check',
      mutate(sqlite) {
        const tableSql = sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roms'")
          .get().sql
        const drifted = tableSql.replace(
          "`variant_kind` IN ('official', 'hack', 'bootleg')",
          "`variant_kind` IN ('official', 'hack')",
        )
        assert.notEqual(drifted, tableSql)
        sqlite.unsafeMode(true)
        sqlite.pragma('writable_schema = ON')
        try {
          sqlite
            .prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'roms'")
            .run(drifted)
        } finally {
          sqlite.pragma('writable_schema = OFF')
          sqlite.unsafeMode(false)
        }
      },
      error: /check.*drift|schema.*drift/i,
    },
    {
      name: 'rooms-code-index',
      mutate(sqlite) {
        sqlite.exec(`
          DROP INDEX rooms_code_unique;
          CREATE UNIQUE INDEX rooms_code_unique ON rooms (name);
        `)
      },
      error: /rooms_code_unique|index.*drift|schema.*drift/i,
    },
    {
      name: 'index-collation',
      mutate(sqlite) {
        sqlite.exec(`
          DROP INDEX roms_owner_platform_set_unique;
          CREATE UNIQUE INDEX roms_owner_platform_set_unique
            ON roms (user_id, platform, set_name_normalized COLLATE BINARY);
        `)
      },
      error: /roms_owner_platform_set_unique|collation|index.*drift/i,
    },
    {
      name: 'column-collation',
      mutate(sqlite) {
        const tableSql = sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'roms'")
          .get().sql
        const drifted = tableSql.replace(
          '`set_name_normalized` text COLLATE NOCASE NOT NULL',
          '`set_name_normalized` text COLLATE BINARY NOT NULL',
        )
        assert.notEqual(drifted, tableSql)
        sqlite.unsafeMode(true)
        sqlite.pragma('writable_schema = ON')
        try {
          sqlite
            .prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'roms'")
            .run(drifted)
        } finally {
          sqlite.pragma('writable_schema = OFF')
          sqlite.unsafeMode(false)
        }
      },
      error: /table roms SQL.*drift|column.*collation|schema.*drift/i,
    },
  ]

  for (const drift of cases) {
    const { dbPath, backupPath } = openFixture(t)
    await contractLibraryDatabase({
      dbPath,
      backupPath,
      migrationsFolder: MIGRATIONS_FOLDER,
    })
    const sqlite = new Database(dbPath)
    try {
      try {
        drift.mutate(sqlite)
      } catch (error) {
        assert.fail(`${drift.name} mutation failed: ${error.stack ?? error.message}`)
      }
    } finally {
      sqlite.close()
    }
    const noopBackup = `${backupPath}.${drift.name}`
    await assert.rejects(
      contractLibraryDatabase({
        dbPath,
        backupPath: noopBackup,
        migrationsFolder: MIGRATIONS_FOLDER,
      }),
      drift.error,
      drift.name,
    )
    assert.equal(existsSync(noopBackup), false, drift.name)
  }
})

test('contract refuses an unsafe phase or missing build coverage before creating a backup', async (t) => {
  const expanded = openFixture(t, { phase: 'expanded' })
  await assert.rejects(
    contractLibraryDatabase({
      dbPath: expanded.dbPath,
      backupPath: expanded.backupPath,
      migrationsFolder: MIGRATIONS_FOLDER,
    }),
    /phase.*backfilled/i,
  )
  assert.equal(existsSync(expanded.backupPath), false)

  const missing = openFixture(t, { missingPointers: true })
  await assert.rejects(
    contractLibraryDatabase({
      dbPath: missing.dbPath,
      backupPath: missing.backupPath,
      migrationsFolder: MIGRATIONS_FOLDER,
    }),
    /room.*build|missing.*build|coverage/i,
  )
  assert.equal(existsSync(missing.backupPath), false)
  const sqlite = new Database(missing.dbPath, { readonly: true })
  try {
    assert.equal(readLibraryMigrationState(sqlite).phase, 'backfilled')
  } finally {
    sqlite.close()
  }
})

test('contract rejects unknown hotfix columns before backup instead of dropping their data', async (t) => {
  const fixture = openFixture(t)
  const sqlite = new Database(fixture.dbPath)
  try {
    sqlite.exec('ALTER TABLE roms ADD COLUMN unmanaged_payload text')
    sqlite
      .prepare("UPDATE roms SET unmanaged_payload = 'must-survive' WHERE id = 1")
      .run()
  } finally {
    sqlite.close()
  }

  await assert.rejects(
    contractLibraryDatabase({
      dbPath: fixture.dbPath,
      backupPath: fixture.backupPath,
      migrationsFolder: MIGRATIONS_FOLDER,
    }),
    /pre-contract schema.*column.*drift/i,
  )
  assert.equal(existsSync(fixture.backupPath), false)
  const preserved = new Database(fixture.dbPath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    assert.equal(
      preserved
        .prepare('SELECT unmanaged_payload FROM roms WHERE id = 1')
        .get().unmanaged_payload,
      'must-survive',
    )
    assert.equal(readLibraryMigrationState(preserved).phase, 'backfilled')
  } finally {
    preserved.close()
  }

  const generated = openFixture(t)
  const generatedDb = new Database(generated.dbPath)
  try {
    generatedDb.exec(`
      ALTER TABLE roms ADD COLUMN unmanaged_generated text
        GENERATED ALWAYS AS (title) VIRTUAL;
    `)
  } finally {
    generatedDb.close()
  }
  await assert.rejects(
    contractLibraryDatabase({
      dbPath: generated.dbPath,
      backupPath: generated.backupPath,
      migrationsFolder: MIGRATIONS_FOLDER,
    }),
    /pre-contract schema.*column.*drift/i,
  )
  assert.equal(existsSync(generated.backupPath), false)
})

test('contract backup must be a new absolute non-symlink path', async (t) => {
  const { dbPath, directory } = openFixture(t)

  await assert.rejects(
    contractLibraryDatabase({
      dbPath,
      backupPath: 'relative-backup.sqlite',
      migrationsFolder: MIGRATIONS_FOLDER,
    }),
    /absolute.*backup|backup.*absolute/i,
  )

  const existing = join(directory, 'existing.sqlite')
  writeFileSync(existing, 'sentinel')
  await assert.rejects(
    contractLibraryDatabase({
      dbPath,
      backupPath: existing,
      migrationsFolder: MIGRATIONS_FOLDER,
    }),
    /already exists|fresh backup/i,
  )
  assert.equal(readFileSync(existing, 'utf8'), 'sentinel')

  const symlinkTarget = join(directory, 'symlink-target.sqlite')
  writeFileSync(symlinkTarget, 'target')
  const symlink = join(directory, 'backup-link.sqlite')
  try {
    symlinkSync(symlinkTarget, symlink, 'file')
  } catch (error) {
    t.diagnostic(`symlink test skipped: ${error.message}`)
    return
  }
  await assert.rejects(
    contractLibraryDatabase({
      dbPath,
      backupPath: symlink,
      migrationsFolder: MIGRATIONS_FOLDER,
    }),
    /symbolic|link|already exists/i,
  )
  assert.equal(readFileSync(symlinkTarget, 'utf8'), 'target')
})

test('contract never overwrites a backup target created after preflight', async (t) => {
  const { dbPath, backupPath } = openFixture(t)
  let evidence
  await assert.rejects(
    contractLibraryDatabase({
      dbPath,
      backupPath,
      migrationsFolder: MIGRATIONS_FOLDER,
      failureInjector(stage) {
        if (stage === 'after_write_freeze') {
          writeFileSync(backupPath, 'racing-sentinel')
        }
      },
    }),
    (error) => {
      evidence = error.contractEvidence
      return /fresh backup|already exists|appeared/i.test(error.message)
    },
  )
  assert.equal(readFileSync(backupPath, 'utf8'), 'racing-sentinel')
  assert.equal(evidence.status, 'rolled_back')
  assert.equal(evidence.rollback.phaseAfter, 'backfilled')
})

test('contract freezes writers for backup and revalidates the frozen state before copy', async (t) => {
  const { dbPath, backupPath } = openFixture(t)
  let observedWriterBlock = false

  await contractLibraryDatabase({
    dbPath,
    backupPath,
    migrationsFolder: MIGRATIONS_FOLDER,
    backupDatabase: async ({ sourcePath, destinationPath, createBackup }) => {
      const contender = new Database(sourcePath, { timeout: 0 })
      try {
        assert.throws(
          () => contender.prepare("UPDATE roms SET title = 'raced' WHERE id = 1").run(),
          /locked|busy/i,
        )
        observedWriterBlock = true
      } finally {
        contender.close()
      }
      return createBackup({ sourcePath, destinationPath })
    },
  })

  assert.equal(observedWriterBlock, true)
  assert.equal(readSnapshot(backupPath).tables.roms[0].title, 'The King of Fighters 97')
})

test('a runner that loses the write-lock race returns a strict contracted no-op', async (t) => {
  const { dbPath, backupPath, directory } = openFixture(t)
  const winnerBackup = join(directory, 'winner.sqlite')
  let winner
  const loser = await contractLibraryDatabase({
    dbPath,
    backupPath,
    migrationsFolder: MIGRATIONS_FOLDER,
    failureInjector: async (stage) => {
      if (stage === 'before_write_lock') {
        winner = await contractLibraryDatabase({
          dbPath,
          backupPath: winnerBackup,
          migrationsFolder: MIGRATIONS_FOLDER,
        })
      }
    },
  })
  assert.equal(winner.noop, false)
  assert.equal(loser.noop, true)
  assert.equal(existsSync(winnerBackup), true)
  assert.equal(existsSync(backupPath), false)
})

test('backup verification rejects unrelated row or unmanaged schema loss with machine-readable evidence', async (t) => {
  const corruptions = [
    {
      name: 'unrelated-row',
      apply(sqlite) {
        sqlite.prepare("DELETE FROM settings WHERE key = 'unrelated-setting'").run()
      },
      error: /full database rowsDigest changed/i,
    },
    {
      name: 'unmanaged-view',
      apply(sqlite) {
        sqlite.exec('DROP VIEW legacy_room_catalog')
      },
      error: /full database schemaDigest changed/i,
    },
  ]
  for (const corruption of corruptions) {
    const { dbPath, backupPath } = openFixture(t)
    let evidence
    await assert.rejects(
      contractLibraryDatabase({
        dbPath,
        backupPath,
        migrationsFolder: MIGRATIONS_FOLDER,
        backupDatabase: async ({ sourcePath, destinationPath, createBackup }) => {
          await createBackup({ sourcePath, destinationPath })
          const copied = new Database(destinationPath)
          try {
            corruption.apply(copied)
          } finally {
            copied.close()
          }
        },
      }),
      (error) => {
        evidence = error.contractEvidence
        return corruption.error.test(error.message)
      },
      corruption.name,
    )
    assert.equal(evidence.status, 'rolled_back', corruption.name)
    assert.equal(evidence.backup, null, corruption.name)
    assert.equal(evidence.backupAttempt.path, backupPath, corruption.name)
    assert.equal(evidence.backupAttempt.exists, true, corruption.name)
    assert.equal(evidence.backupAttempt.verified, false, corruption.name)
    assert.equal(evidence.rollback.backupPreserved, true, corruption.name)
    const source = new Database(dbPath, { readonly: true })
    try {
      assert.equal(readLibraryMigrationState(source).phase, 'backfilled')
    } finally {
      source.close()
    }
  }
})

test('every destructive contract gate rolls back rows, sequence, objects, ledger, and phase', async (t) => {
  const stages = [
    'after_write_freeze',
    'after_backup',
    'after_copy',
    'after_drop_rename',
    'after_contract_sql',
    'after_unmanaged_restore',
    'after_sequence_restore',
    'before_ledger',
    'after_ledger',
    'after_phase',
    'before_commit',
  ]
  for (const failureStage of stages) {
    const { dbPath, backupPath } = openFixture(t)
    const before = readSnapshot(dbPath)
    let failureEvidence
    await assert.rejects(
      contractLibraryDatabase({
        dbPath,
        backupPath,
        migrationsFolder: MIGRATIONS_FOLDER,
        failureInjector: (stage) => {
          if (stage === failureStage) {
            throw new Error(`forced_contract_failure:${failureStage}`)
          }
        },
      }),
      (error) => {
        failureEvidence = error.contractEvidence
        return error.message === `forced_contract_failure:${failureStage}`
      },
      failureStage,
    )

    assert.equal(failureEvidence.status, 'rolled_back', failureStage)
    assert.equal(failureEvidence.rollback.attempted, true, failureStage)
    assert.equal(failureEvidence.rollback.succeeded, true, failureStage)
    assert.equal(failureEvidence.rollback.phaseAfter, 'backfilled', failureStage)
    if (failureStage === 'after_write_freeze') {
      assert.equal(failureEvidence.backup, null)
      assert.equal(failureEvidence.rollback.backupPreserved, null)
      assert.equal(existsSync(backupPath), false)
    } else {
      assert.equal(failureEvidence.rollback.backupPreserved, true, failureStage)
      assert.equal(failureEvidence.backup.path, backupPath)
      assert.equal(existsSync(backupPath), true)
      assert.equal(digestFile(backupPath), failureEvidence.backup.sha256)
      assert.deepEqual(readSnapshot(backupPath), before)
    }

    const sqlite = new Database(dbPath)
    sqlite.pragma('foreign_keys = ON')
    try {
      assert.equal(readLibraryMigrationState(sqlite).phase, 'backfilled')
      assert.equal(tableColumn(sqlite, 'roms', 'active_build_id').notnull, 0)
      assert.deepEqual(snapshotRows(sqlite), before)
      assert.equal(
        readMigrationLedger(sqlite).some(
          ({ createdAt }) =>
            Number(createdAt) ===
            loadMigrationManifest(MIGRATIONS_FOLDER).find(
              ({ tag }) => tag === CONTRACT_BASELINE_TAG,
            ).folderMillis,
        ),
        false,
      )
      assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), [])
      assert.equal(sqlite.pragma('integrity_check', { simple: true }), 'ok')
    } finally {
      sqlite.close()
    }
  }
})

test('post-commit verification failures report committed state without claiming rollback', async (t) => {
  const { dbPath, backupPath, directory } = openFixture(t)
  let evidence
  await assert.rejects(
    contractLibraryDatabase({
      dbPath,
      backupPath,
      migrationsFolder: MIGRATIONS_FOLDER,
      failureInjector(stage) {
        if (stage === 'after_commit') {
          throw new Error('forced_postcommit_verification_failure')
        }
      },
    }),
    (error) => {
      evidence = error.contractEvidence
      return error.message === 'forced_postcommit_verification_failure'
    },
  )
  assert.equal(evidence.status, 'committed_but_postverify_failed')
  assert.deepEqual(evidence.phase, {
    before: 'backfilled',
    after: 'contracted',
  })
  assert.equal(evidence.backup.path, backupPath)
  assert.equal(evidence.backupAttempt.verified, true)
  assert.equal(evidence.rollback.attempted, false)
  assert.equal(evidence.rollback.reason, 'transaction_already_committed')

  const noOp = await contractLibraryDatabase({
    dbPath,
    backupPath: join(directory, 'not-created.sqlite'),
    migrationsFolder: MIGRATIONS_FOLDER,
  })
  assert.equal(noOp.noop, true)
})

test('runtime 0002 is fail-closed while the explicit contract runner records its exact hash', async (t) => {
  const manifest = loadMigrationManifest(MIGRATIONS_FOLDER)
  assert.deepEqual(
    manifest.slice(0, 3).map(({ tag }) => tag),
    ['0000_baseline', '0001_arcade_library_expand', CONTRACT_BASELINE_TAG],
  )
  const contractEntry = manifest[2]
  const markerPath = join(MIGRATIONS_FOLDER, `${CONTRACT_BASELINE_TAG}.sql`)
  const marker = readFileSync(markerPath, 'utf8')
  assert.match(marker, /explicit|orchestrator|contract/i)
  assert.doesNotMatch(marker, /\b(?:DROP|ALTER|DELETE|UPDATE|INSERT|CREATE)\b/i)
  assert.equal(
    marker.match(/contract-sql-sha256:\s*([0-9a-f]{64})/i)?.[1],
    digestFile(CONTRACT_SQL_PATH),
    'the ledger marker must be cryptographically bound to the real contract SQL',
  )
  assert.equal(
    marker.match(/contract-schema-sha256:\s*([0-9a-f]{64})/i)?.[1],
    computeContractSchemaSha256({
      contractSqlPath: CONTRACT_SQL_PATH,
      migrationsFolder: MIGRATIONS_FOLDER,
    }),
    'the marker must bind the final snapshot and managed trigger/index SQL',
  )

  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  )
  const journalEntries = journal.entries.slice(0, 3)
  assert.deepEqual(
    journalEntries.map(({ idx, tag }) => ({ idx, tag })),
    [
      { idx: 0, tag: '0000_baseline' },
      { idx: 1, tag: '0001_arcade_library_expand' },
      { idx: 2, tag: CONTRACT_BASELINE_TAG },
    ],
  )
  assert.ok(
    journalEntries.every(
      (entry, index) => index === 0 || entry.when > journalEntries[index - 1].when,
    ),
    'migration journal timestamps must increase monotonically',
  )
  assert.equal(journalEntries[2].when, contractEntry.folderMillis)
  const expandSnapshot = JSON.parse(
    readFileSync(
      join(MIGRATIONS_FOLDER, 'meta', '0001_snapshot.json'),
      'utf8',
    ),
  )
  const contractSnapshot = JSON.parse(
    readFileSync(
      join(MIGRATIONS_FOLDER, 'meta', '0002_snapshot.json'),
      'utf8',
    ),
  )
  assert.equal(contractSnapshot.prevId, expandSnapshot.id)

  const markerDb = new Database(':memory:')
  try {
    assert.throws(() => markerDb.exec(marker), /no such function|explicit/i)
  } finally {
    markerDb.close()
  }

  const { dbPath, backupPath } = openFixture(t)
  await contractLibraryDatabase({
    dbPath,
    backupPath,
    migrationsFolder: MIGRATIONS_FOLDER,
  })
  const sqlite = new Database(dbPath)
  sqlite.pragma('foreign_keys = ON')
  try {
    const ledgerEntry = readMigrationLedger(sqlite).find(
      ({ createdAt }) => Number(createdAt) === contractEntry.folderMillis,
    )
    assert.equal(ledgerEntry.hash, contractEntry.hash)
    const baseline = manifest[0]
    const baselineSql = readFileSync(
      join(MIGRATIONS_FOLDER, `${baseline.tag}.sql`),
      'utf8',
    )
    const alternateBaselineHash = createHash('sha256')
      .update(baselineSql.replace(/\r?\n/g, '\r\n'), 'utf8')
      .digest('hex')
    assert.notEqual(alternateBaselineHash, baseline.hash)
    sqlite
      .prepare('UPDATE __drizzle_migrations SET hash = ? WHERE created_at = ?')
      .run(alternateBaselineHash, baseline.folderMillis)
    const warnings = []
    const runtime = prepareDatabaseForRuntime(sqlite, {
      migrationsFolder: MIGRATIONS_FOLDER,
      onWarning: (warning) => warnings.push(warning),
    })
    assert.equal(runtime.state.phase, 'contracted')
    assert.ok(warnings.length >= 1)
    assert.equal(runtime.contractSchema.schemaSha256, computeContractSchemaSha256({
      contractSqlPath: CONTRACT_SQL_PATH,
      migrationsFolder: MIGRATIONS_FOLDER,
    }))
  } finally {
    sqlite.close()
  }
})

test('runtime applies a future managed-table migration and starts cleanly a second time', async (t) => {
  const { dbPath, backupPath, directory } = openFixture(t)
  await contractLibraryDatabase({
    dbPath,
    backupPath,
    migrationsFolder: MIGRATIONS_FOLDER,
  })

  const futureMigrations = join(directory, 'future-migrations')
  cpSync(MIGRATIONS_FOLDER, futureMigrations, { recursive: true })
  const journalPath = join(futureMigrations, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
  const contractEntry = journal.entries.at(-1)
  journal.entries.push({
    idx: contractEntry.idx + 1,
    version: '6',
    when: contractEntry.when + 1,
    tag: '0003_future_managed_change',
    breakpoints: true,
  })
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
  writeFileSync(
    join(futureMigrations, '0003_future_managed_change.sql'),
    'ALTER TABLE settings ADD COLUMN future_value text;\n',
  )

  const sqlite = new Database(dbPath)
  sqlite.pragma('foreign_keys = ON')
  try {
    const first = prepareDatabaseForRuntime(sqlite, {
      migrationsFolder: futureMigrations,
    })
    assert.equal(first.state.phase, 'contracted')
    assert.ok(tableColumn(sqlite, 'settings', 'future_value'))

    const second = prepareDatabaseForRuntime(sqlite, {
      migrationsFolder: futureMigrations,
    })
    assert.equal(second.state.phase, 'contracted')
    const futureLedger = loadMigrationManifest(futureMigrations).at(-1)
    assert.equal(
      readMigrationLedger(sqlite).filter(
        ({ createdAt }) => Number(createdAt) === futureLedger.folderMillis,
      ).length,
      1,
    )
  } finally {
    sqlite.close()
  }

  const noOpBackup = join(directory, 'future-noop-must-not-exist.sqlite')
  const noOp = await contractLibraryDatabase({
    dbPath,
    backupPath: noOpBackup,
    migrationsFolder: futureMigrations,
  })
  assert.equal(noOp.noop, true)
  assert.equal(existsSync(noOpBackup), false)
})

test('migration CLI requires explicit apply/backup and contract/all resume safely', (t) => {
  const contractFixture = openFixture(t)
  const run = (fixture, ...args) =>
    spawnSync(process.execPath, ['scripts/migrate-library.js', ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, DB_PATH: fixture.dbPath },
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    })

  const missingApply = run(
    contractFixture,
    'contract',
    '--backup',
    contractFixture.backupPath,
  )
  assert.notEqual(missingApply.status, 0)
  assert.match(`${missingApply.stdout}\n${missingApply.stderr}`, /--apply/i)
  assert.equal(existsSync(contractFixture.backupPath), false)

  const missingBackup = run(contractFixture, 'contract', '--apply')
  assert.notEqual(missingBackup.status, 0)
  assert.match(`${missingBackup.stdout}\n${missingBackup.stderr}`, /--backup/i)

  const contracted = run(
    contractFixture,
    'contract',
    '--apply',
    '--backup',
    contractFixture.backupPath,
  )
  assert.equal(contracted.status, 0, contracted.stderr)
  const contractedEvidence = JSON.parse(contracted.stdout)
  assert.equal(contractedEvidence.kind, 'arcade-library-contract-evidence-v1')
  assert.equal(contractedEvidence.noop, false)

  const status = run(contractFixture, 'status')
  assert.equal(status.status, 0, status.stderr)
  const statusEvidence = JSON.parse(status.stdout)
  assert.equal(statusEvidence.phase, 'contracted')
  assert.equal(
    statusEvidence.ledger.find(({ tag }) => tag === CONTRACT_BASELINE_TAG)
      .hashStatus,
    'exact',
  )

  const noOpWithoutBackup = run(contractFixture, 'contract', '--apply')
  assert.equal(noOpWithoutBackup.status, 0, noOpWithoutBackup.stderr)
  assert.equal(JSON.parse(noOpWithoutBackup.stdout).noop, true)

  const allFixture = openFixture(t)
  const allBackup = join(allFixture.directory, 'all-backup.sqlite')
  const all = run(
    allFixture,
    'all',
    '--apply',
    '--backup',
    allBackup,
  )
  assert.equal(all.status, 0, all.stderr)
  const allEvidence = JSON.parse(all.stdout)
  assert.equal(allEvidence.kind, 'arcade-library-all-evidence-v1')
  assert.equal(allEvidence.steps.backfill, 'already-backfilled')
  assert.equal(allEvidence.contract.phase.after, 'contracted')
  assert.equal(existsSync(allBackup), true)

  const rollback = run(allFixture, 'rollback')
  assert.notEqual(rollback.status, 0)
  assert.match(`${rollback.stdout}\n${rollback.stderr}`, /usage|unknown/i)
})

test('the contracted fixture matches 0002 and produces zero pending Drizzle diff', async (t) => {
  const fixture = openFixture(t)
  await contractLibraryDatabase({
    dbPath: fixture.dbPath,
    backupPath: fixture.backupPath,
    migrationsFolder: MIGRATIONS_FOLDER,
  })
  const contracted = new Database(fixture.dbPath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    assertContractedSchema(contracted, {
      migrationsFolder: MIGRATIONS_FOLDER,
      contractSqlPath: CONTRACT_SQL_PATH,
    })
  } finally {
    contracted.close()
  }

  const scratchRoot = join(PROJECT_ROOT, '.superpowers', 'test-tmp')
  mkdirSync(scratchRoot, { recursive: true })
  const directory = mkdtempSync(join(scratchRoot, 'contract-drizzle-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))

  mkdirSync(join(directory, 'server', 'db'), { recursive: true })
  cpSync(
    join(PROJECT_ROOT, 'server', 'db', 'schema.js'),
    join(directory, 'server', 'db', 'schema.js'),
  )
  cpSync(MIGRATIONS_FOLDER, join(directory, 'server', 'db', 'migrations'), {
    recursive: true,
  })
  writeFileSync(
    join(directory, 'drizzle.config.js'),
    `import { defineConfig } from 'drizzle-kit'\nexport default defineConfig({ dialect: 'sqlite', schema: './server/db/schema.js', out: './server/db/migrations', casing: 'snake_case' })\n`,
  )
  const before = readdirSync(join(directory, 'server', 'db', 'migrations')).filter(
    (name) => name.endsWith('.sql'),
  )
  const result = spawnSync(
    process.execPath,
    [
      join(PROJECT_ROOT, 'node_modules', 'drizzle-kit', 'bin.cjs'),
      'generate',
      '--config',
      'drizzle.config.js',
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    },
  )
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(`${result.stdout}\n${result.stderr}`, /No schema changes/i)
  const after = readdirSync(join(directory, 'server', 'db', 'migrations')).filter(
    (name) => name.endsWith('.sql'),
  )
  assert.deepEqual(after, before)
})
