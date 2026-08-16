import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, parse, resolve } from 'node:path'

import Database from 'better-sqlite3'

import {
  CONTRACT_BASELINE_TAG,
  DEFAULT_MIGRATIONS_FOLDER,
  assertExactLedgerEntry,
  loadMigrationManifest,
  readLibraryMigrationState,
  readMigrationLedger,
} from './migration-runner.js'
import {
  DEFAULT_CONTRACT_SQL_PATH,
  MANAGED_CONTRACT_OBJECT_NAMES,
  assertContractedSchema,
  assertContractOwnershipSchema,
  assertPreContractSchema,
  computeContractSchemaSha256,
} from './contract-schema.js'
import { canonicalizeLibraryJson } from '../services/library-service.js'

export { computeContractSchemaSha256 } from './contract-schema.js'

export const CONTRACT_SQL_PATH = DEFAULT_CONTRACT_SQL_PATH

const CONTRACT_SQL_HASH_PATTERN = /contract-sql-sha256:\s*([0-9a-f]{64})/i
const CONTRACT_SCHEMA_HASH_PATTERN =
  /contract-schema-sha256:\s*([0-9a-f]{64})/i
const CONTRACT_SQL_STAGE_PATTERN =
  /^-- contract-stage: ([a-z][a-z0-9_]*)\s*$/gim
const REBUILT_TABLE_COLUMNS = Object.freeze({
  roms: [
    'id',
    'user_id',
    'title',
    'platform',
    'file_name',
    'file_path',
    'file_size',
    'is_public',
    'parent_rom_id',
    'set_name_normalized',
    'variant_kind',
    'dat_parent_set_name',
    'family_root_set_name',
    'version_label',
    'active_build_id',
    'active_thumbnail_ref_id',
    'status',
    'created_at',
    'updated_at',
  ],
  favorites: ['user_id', 'rom_id', 'created_at'],
  rooms: [
    'id',
    'code',
    'host_user_id',
    'rom_id',
    'rom_build_id',
    'name',
    'is_public',
    'allow_play',
    'password_hash',
    'status',
    'created_at',
    'updated_at',
    'closed_at',
  ],
  save_states: [
    'id',
    'user_id',
    'rom_id',
    'rom_build_id',
    'build_fingerprint',
    'core_artifact_fingerprint',
    'content_manifest_sha256',
    'slot',
    'file_path',
    'file_size',
    'status',
    'updated_at',
  ],
})
const SUPPORT_TABLE_ORDER = Object.freeze({
  assets: 'id',
  core_artifacts: 'id',
  rom_builds: 'id',
  rom_asset_refs: 'id',
})
const REBUILT_TABLE_ORDER = Object.freeze({
  roms: 'id',
  favorites: 'user_id, rom_id',
  rooms: 'id',
  save_states: 'id',
})

function assertSqlite(sqlite) {
  if (!sqlite || typeof sqlite.prepare !== 'function' || typeof sqlite.exec !== 'function') {
    throw new TypeError('a better-sqlite3 connection is required')
  }
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function canonicalDigest(value) {
  return sha256Bytes(Buffer.from(canonicalizeLibraryJson(value), 'utf8'))
}

function scalarCount(sqlite, sql) {
  return Number(sqlite.prepare(sql).get().count)
}

function normalizedSql(sql) {
  return String(sql).trim().replace(/\s+/g, ' ')
}

function tableRows(sqlite, tableName, columns, orderBy) {
  const selection = columns.map(quoteIdentifier).join(', ')
  return sqlite
    .prepare(
      `SELECT ${selection} FROM ${quoteIdentifier(tableName)} ORDER BY ${orderBy}`,
    )
    .all()
}

function supportRows(sqlite, tableName, orderBy) {
  const columns = sqlite
    .prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`)
    .all()
    .map(({ name }) => name)
  return tableRows(sqlite, tableName, columns, orderBy)
}

function userTableNames(sqlite) {
  return sqlite
    .prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all()
    .map(({ name }) => name)
}

function logicalTableRows(sqlite, tableName) {
  const columns = sqlite
    .prepare(`PRAGMA table_xinfo(${JSON.stringify(tableName)})`)
    .all()
    .filter(({ hidden }) => Number(hidden) === 0)
  const selected = columns.map(({ name }) => quoteIdentifier(name)).join(', ')
  const primaryKey = columns
    .filter(({ pk }) => Number(pk) > 0)
    .sort((left, right) => left.pk - right.pk)
    .map(({ name }) => quoteIdentifier(name))
  const orderBy = primaryKey.length > 0
    ? primaryKey.join(', ')
    : columns.map(({ name }) => quoteIdentifier(name)).join(', ')
  return sqlite
    .prepare(
      `SELECT ${selected} FROM ${quoteIdentifier(tableName)} ORDER BY ${orderBy}`,
    )
    .all()
}

function logicalRowsDigest(sqlite, { exclude = [] } = {}) {
  const excluded = new Set(exclude)
  return canonicalDigest(
    Object.fromEntries(
      userTableNames(sqlite)
        .filter((tableName) => !excluded.has(tableName))
        .map((tableName) => [tableName, logicalTableRows(sqlite, tableName)]),
    ),
  )
}

function logicalSchemaDigest(sqlite) {
  return canonicalDigest(
    sqlite
      .prepare(`
        SELECT type, name, tbl_name AS tableName, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
      `)
      .all(),
  )
}

export function snapshotContractData(sqlite) {
  assertSqlite(sqlite)
  const rebuiltRows = Object.fromEntries(
    Object.entries(REBUILT_TABLE_COLUMNS).map(([tableName, columns]) => [
      tableName,
      tableRows(
        sqlite,
        tableName,
        columns,
        REBUILT_TABLE_ORDER[tableName],
      ),
    ]),
  )
  const supportingRows = Object.fromEntries(
    Object.entries(SUPPORT_TABLE_ORDER).map(([tableName, orderBy]) => [
      tableName,
      supportRows(sqlite, tableName, orderBy),
    ]),
  )
  const sequence = sqlite
    .prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name')
    .all()
  return {
    rebuiltRows,
    supportingRows,
    sequence,
    rebuiltDigest: canonicalDigest(rebuiltRows),
    supportingDigest: canonicalDigest(supportingRows),
    sequenceDigest: canonicalDigest(sequence),
    untouchedDigest: logicalRowsDigest(sqlite, {
      exclude: [
        ...Object.keys(REBUILT_TABLE_COLUMNS),
        'library_migration_state',
        '__drizzle_migrations',
      ],
    }),
  }
}

function snapshotFrozenDatabase(sqlite) {
  return {
    rowsDigest: logicalRowsDigest(sqlite),
    schemaDigest: logicalSchemaDigest(sqlite),
  }
}

function contractCoverage(sqlite) {
  return {
    romsMissingActiveBuild: scalarCount(
      sqlite,
      `
        SELECT COUNT(*) AS count
        FROM roms AS rom
        LEFT JOIN rom_builds AS build
          ON build.id = rom.active_build_id AND build.rom_id = rom.id
        WHERE rom.active_build_id IS NULL OR build.id IS NULL
      `,
    ),
    romsWrongThumbnailOwner: scalarCount(
      sqlite,
      `
        SELECT COUNT(*) AS count
        FROM roms AS rom
        LEFT JOIN rom_asset_refs AS ref
          ON ref.id = rom.active_thumbnail_ref_id AND ref.rom_id = rom.id
        WHERE rom.active_thumbnail_ref_id IS NOT NULL AND ref.id IS NULL
      `,
    ),
    roomsMissingOrWrongBuild: scalarCount(
      sqlite,
      `
        SELECT COUNT(*) AS count
        FROM rooms AS room
        LEFT JOIN rom_builds AS build
          ON build.id = room.rom_build_id AND build.rom_id = room.rom_id
        WHERE room.rom_build_id IS NULL OR build.id IS NULL
      `,
    ),
    savesMissingOrWrongBuildIdentity: scalarCount(
      sqlite,
      `
        SELECT COUNT(*) AS count
        FROM save_states AS save
        LEFT JOIN rom_builds AS build
          ON build.id = save.rom_build_id AND build.rom_id = save.rom_id
        LEFT JOIN core_artifacts AS core
          ON core.id = build.core_artifact_id
        WHERE save.rom_build_id IS NULL
           OR save.build_fingerprint IS NULL
           OR save.core_artifact_fingerprint IS NULL
           OR save.content_manifest_sha256 IS NULL
           OR build.id IS NULL
           OR save.build_fingerprint <> build.build_fingerprint
           OR save.content_manifest_sha256 <> build.content_manifest_sha256
           OR save.core_artifact_fingerprint <> core.artifact_fingerprint
      `,
    ),
    invalidRuntimeParents: scalarCount(
      sqlite,
      `
        SELECT COUNT(*) AS count
        FROM rom_builds AS child_build
        JOIN roms AS child_rom ON child_rom.id = child_build.rom_id
        WHERE NOT (
          (
            child_build.archive_layout = 'standalone'
            AND child_build.runtime_parent_build_id IS NULL
          )
          OR
          (
            child_build.archive_layout = 'split'
            AND child_build.runtime_parent_build_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM rom_builds AS parent_build
              JOIN roms AS parent_rom ON parent_rom.id = parent_build.rom_id
              WHERE parent_build.id = child_build.runtime_parent_build_id
                AND parent_build.archive_layout = 'standalone'
                AND parent_build.runtime_parent_build_id IS NULL
                AND parent_build.static_status = 'complete'
                AND parent_build.core_artifact_id = child_build.core_artifact_id
                AND child_rom.dat_parent_set_name IS NOT NULL
                AND child_rom.dat_parent_set_name = parent_rom.set_name_normalized COLLATE NOCASE
            )
          )
        )
      `,
    ),
    missingParentRoms: scalarCount(
      sqlite,
      `
        SELECT COUNT(*) AS count
        FROM roms AS child
        LEFT JOIN roms AS parent ON parent.id = child.parent_rom_id
        WHERE child.parent_rom_id IS NOT NULL AND parent.id IS NULL
      `,
    ),
    invalidSetNames: scalarCount(
      sqlite,
      `
        SELECT COUNT(*) AS count FROM roms
        WHERE set_name_normalized IS NULL
           OR length(set_name_normalized) = 0
           OR set_name_normalized COLLATE BINARY <> lower(set_name_normalized)
      `,
    ),
    duplicateLogicalSets: scalarCount(
      sqlite,
      `
        SELECT COUNT(*) AS count FROM (
          SELECT user_id, platform, set_name_normalized COLLATE NOCASE
          FROM roms
          GROUP BY user_id, platform, set_name_normalized COLLATE NOCASE
          HAVING COUNT(*) > 1
        )
      `,
    ),
    invalidVariantKinds: scalarCount(
      sqlite,
      `
        SELECT COUNT(*) AS count FROM roms
        WHERE variant_kind IS NOT NULL
          AND variant_kind NOT IN ('official', 'hack', 'bootleg')
      `,
    ),
  }
}

function assertZeroCoverage(coverage) {
  const failures = Object.entries(coverage).filter(([, count]) => count !== 0)
  if (failures.length > 0) {
    throw new Error(
      `contract reference coverage failed: ${failures
        .map(([name, count]) => `${name}=${count}`)
        .join(', ')}`,
    )
  }
}

function sqliteChecks(sqlite, label) {
  const foreignKeyViolations = sqlite.prepare('PRAGMA foreign_key_check').all()
  if (foreignKeyViolations.length !== 0) {
    throw new Error(`${label} foreign-key check failed`)
  }
  const integrityCheck = sqlite.pragma('integrity_check', { simple: true })
  if (integrityCheck !== 'ok') {
    throw new Error(`${label} integrity check failed: ${integrityCheck}`)
  }
  return {
    foreignKeyViolationCount: foreignKeyViolations.length,
    integrityCheck,
  }
}

function migrationEntries(migrationsFolder) {
  const manifest = loadMigrationManifest(migrationsFolder)
  const expandIndex = manifest.findIndex(
    ({ tag }) => tag === '0001_arcade_library_expand',
  )
  const contractIndex = manifest.findIndex(
    ({ tag }) => tag === CONTRACT_BASELINE_TAG,
  )
  if (expandIndex < 0 || contractIndex !== expandIndex + 1) {
    throw new Error('contract baseline must immediately follow the expand migration')
  }
  return {
    manifest,
    priorEntries: manifest.slice(0, contractIndex),
    contractEntry: manifest[contractIndex],
  }
}

function auditLedger(sqlite, entries, { contracted }) {
  const ledger = readMigrationLedger(sqlite)
  const contractPrefixLength = entries.priorEntries.length + 1
  const validLength = contracted
    ? ledger.length >= contractPrefixLength &&
      ledger.length <= entries.manifest.length
    : ledger.length === entries.priorEntries.length
  if (!validLength) {
    throw new Error(
      `migration ledger has invalid length ${ledger.length} before ${
        contracted ? 'contracted no-op' : 'contract'
      }`,
    )
  }
  const expected = contracted
    ? entries.manifest.slice(0, ledger.length)
    : entries.priorEntries
  for (let index = 0; index < ledger.length; index += 1) {
    if (
      Number(ledger[index].createdAt) !==
      Number(expected[index].folderMillis)
    ) {
      throw new Error(
        `migration ledger is not a contiguous manifest prefix at row ${index + 1}`,
      )
    }
  }
  for (const entry of expected) {
    assertExactLedgerEntry(sqlite, entry, {
      allowLegacyBaselineHashMismatch: true,
      onWarning: () => {},
    })
  }
  return ledger
}

function inspectPreContract(sqlite, entries, migrationsFolder) {
  const state = readLibraryMigrationState(sqlite)
  if (state.phase !== 'backfilled') {
    throw new Error(`contract requires migration phase backfilled; got ${state.phase}`)
  }
  auditLedger(sqlite, entries, { contracted: false })
  assertPreContractSchema(sqlite, { migrationsFolder })
  const coverage = contractCoverage(sqlite)
  assertZeroCoverage(coverage)
  const checks = sqliteChecks(sqlite, 'pre-contract database')
  const data = snapshotContractData(sqlite)
  const frozen = snapshotFrozenDatabase(sqlite)
  return { state, coverage, checks, data, frozen }
}

function sameFrozenState(left, right, label) {
  for (const field of ['rebuiltDigest', 'supportingDigest', 'sequenceDigest']) {
    if (left.data[field] !== right.data[field]) {
      throw new Error(`${label} ${field} changed during the contract gate`)
    }
  }
  if (canonicalDigest(left.coverage) !== canonicalDigest(right.coverage)) {
    throw new Error(`${label} reference coverage changed during the contract gate`)
  }
  for (const field of ['rowsDigest', 'schemaDigest']) {
    if (left.frozen[field] !== right.frozen[field]) {
      throw new Error(`${label} full database ${field} changed during the contract gate`)
    }
  }
}

function captureUnmanagedObjects(sqlite) {
  return sqlite
    .prepare(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_master
      WHERE type IN ('index', 'trigger', 'view')
        AND sql IS NOT NULL
        AND name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `)
    .all()
    .filter(({ name }) => !MANAGED_CONTRACT_OBJECT_NAMES.has(name))
    .map((row) => ({ ...row, normalizedSql: normalizedSql(row.sql) }))
}

function unmanagedComparable(objects) {
  return objects.map(({ type, name, tableName, normalizedSql: sql }) => ({
    type,
    name,
    tableName,
    sql,
  }))
}

function restoreUnmanagedObjects(sqlite, before) {
  const current = new Map(
    captureUnmanagedObjects(sqlite).map((object) => [object.name, object]),
  )
  const replayOrder = { index: 0, view: 1, trigger: 2 }
  for (const object of [...before].sort(
    (left, right) =>
      replayOrder[left.type] - replayOrder[right.type] ||
      left.name.localeCompare(right.name, 'en'),
  )) {
    const existing = current.get(object.name)
    if (existing) {
      if (
        existing.type !== object.type ||
        existing.tableName !== object.tableName ||
        existing.normalizedSql !== object.normalizedSql
      ) {
        throw new Error(`unmanaged object ${object.name} changed during contract`)
      }
      continue
    }
    sqlite.exec(object.sql)
  }
  const after = captureUnmanagedObjects(sqlite)
  if (
    canonicalizeLibraryJson(unmanagedComparable(after)) !==
    canonicalizeLibraryJson(unmanagedComparable(before))
  ) {
    throw new Error('unmanaged indexes, triggers, or views were not preserved')
  }
  return after
}

function restoreSqliteSequence(sqlite, sequence) {
  sqlite.exec('DELETE FROM sqlite_sequence')
  const insert = sqlite.prepare(
    'INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)',
  )
  for (const row of sequence) insert.run(row.name, row.seq)
  const after = sqlite
    .prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name')
    .all()
  if (canonicalizeLibraryJson(after) !== canonicalizeLibraryJson(sequence)) {
    throw new Error('sqlite_sequence was not restored exactly')
  }
  if (after.some(({ name }) => name.startsWith('__contract_new_'))) {
    throw new Error('temporary contract table leaked into sqlite_sequence')
  }
}

function assertContractSqlBinding(contractSqlPath, migrationsFolder) {
  const contractSql = readFileSync(contractSqlPath)
  const marker = readFileSync(
    resolve(migrationsFolder, `${CONTRACT_BASELINE_TAG}.sql`),
    'utf8',
  )
  const expectedHash = marker.match(CONTRACT_SQL_HASH_PATTERN)?.[1]?.toLowerCase()
  if (!expectedHash) {
    throw new Error('contract baseline marker is missing contract-sql-sha256')
  }
  const actualHash = sha256Bytes(contractSql)
  if (actualHash !== expectedHash) {
    throw new Error(
      `contract SQL hash mismatch: marker expects ${expectedHash}, got ${actualHash}`,
    )
  }
  const expectedSchemaHash = marker
    .match(CONTRACT_SCHEMA_HASH_PATTERN)?.[1]
    ?.toLowerCase()
  if (!expectedSchemaHash) {
    throw new Error('contract baseline marker is missing contract-schema-sha256')
  }
  const actualSchemaHash = computeContractSchemaSha256({
    contractSqlPath,
    migrationsFolder,
  })
  if (actualSchemaHash !== expectedSchemaHash) {
    throw new Error(
      `contract schema hash mismatch: marker expects ${expectedSchemaHash}, got ${actualSchemaHash}`,
    )
  }
  return {
    bytes: contractSql,
    sha256: actualHash,
    schemaSha256: actualSchemaHash,
  }
}

function assertNoSymlinkAncestors(path) {
  let current = resolve(path)
  const root = parse(current).root
  while (true) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`backup path contains a symbolic link: ${current}`)
    }
    if (current === root) break
    current = dirname(current)
  }
}

function prepareBackupPath(dbPath, backupPath) {
  if (typeof backupPath !== 'string' || !isAbsolute(backupPath)) {
    throw new Error('contract requires an absolute fresh backup path')
  }
  const absoluteBackupPath = resolve(backupPath)
  const absoluteDbPath = realpathSync(resolve(dbPath))
  if (absoluteBackupPath.toLowerCase() === absoluteDbPath.toLowerCase()) {
    throw new Error('backup path must be different from the source database')
  }
  assertNoSymlinkAncestors(absoluteBackupPath)
  if (existsSync(absoluteBackupPath)) {
    const target = lstatSync(absoluteBackupPath)
    if (target.isSymbolicLink()) {
      throw new Error('backup target must not be a symbolic link')
    }
    throw new Error('fresh backup path already exists')
  }
  mkdirSync(dirname(absoluteBackupPath), { recursive: true })
  assertNoSymlinkAncestors(dirname(absoluteBackupPath))
  return absoluteBackupPath
}

function claimFreshBackupPath(backupPath) {
  assertNoSymlinkAncestors(backupPath)
  let descriptor
  try {
    descriptor = openSync(backupPath, 'wx')
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('fresh backup path already exists or appeared after preflight')
    }
    throw error
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  const claimed = lstatSync(backupPath)
  if (claimed.isSymbolicLink() || !claimed.isFile() || claimed.size !== 0) {
    throw new Error('fresh backup path could not be claimed safely')
  }
}

export async function createBackupOutsideTransaction({
  sourcePath,
  destinationPath,
}) {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
    if (source.inTransaction) {
      throw new Error('backup source connection must be outside a transaction')
    }
    await source.backup(destinationPath)
  } finally {
    source.close()
  }
}

function verifyBackup({ backupPath, expected, entries, migrationsFolder }) {
  if (!existsSync(backupPath)) throw new Error('contract backup was not created')
  const metadata = lstatSync(backupPath)
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0) {
    throw new Error('contract backup must be a non-empty regular file')
  }
  const backup = new Database(backupPath, {
    readonly: true,
    fileMustExist: true,
  })
  try {
    backup.pragma('foreign_keys = ON')
    const inspected = inspectPreContract(backup, entries, migrationsFolder)
    sameFrozenState(expected, inspected, 'backup')
    const checks = sqliteChecks(backup, 'contract backup')
    return {
      path: backupPath,
      size: metadata.size,
      sha256: sha256Bytes(readFileSync(backupPath)),
      integrityCheck: checks.integrityCheck,
      foreignKeyViolationCount: checks.foreignKeyViolationCount,
      phase: inspected.state.phase,
      rebuiltDigest: inspected.data.rebuiltDigest,
      supportingDigest: inspected.data.supportingDigest,
      sequenceDigest: inspected.data.sequenceDigest,
      untouchedDigest: inspected.data.untouchedDigest,
      fullRowsDigest: inspected.frozen.rowsDigest,
      fullSchemaDigest: inspected.frozen.schemaDigest,
    }
  } finally {
    backup.close()
  }
}

function insertContractLedger(sqlite, contractEntry) {
  const existing = readMigrationLedger(sqlite).filter(
    ({ createdAt }) => Number(createdAt) === Number(contractEntry.folderMillis),
  )
  if (existing.length !== 0) {
    throw new Error('contract baseline ledger entry already exists before contract')
  }
  const result = sqlite
    .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
    .run(contractEntry.hash, contractEntry.folderMillis)
  if (result.changes !== 1) {
    throw new Error('contract baseline ledger entry was not recorded')
  }
}

function assertContractedState(
  sqlite,
  entries,
  contractSqlPath,
  migrationsFolder,
) {
  const state = readLibraryMigrationState(sqlite)
  if (state.phase !== 'contracted') {
    throw new Error(`contracted database phase drifted to ${state.phase}`)
  }
  const ledger = auditLedger(sqlite, entries, { contracted: true })
  const schemaOptions = { contractSqlPath, migrationsFolder }
  if (ledger.length > entries.priorEntries.length + 1) {
    assertContractOwnershipSchema(sqlite, schemaOptions)
  } else {
    assertContractedSchema(sqlite, schemaOptions)
  }
  const coverage = contractCoverage(sqlite)
  assertZeroCoverage(coverage)
  const checks = sqliteChecks(sqlite, 'contracted database')
  return {
    state,
    coverage,
    checks,
    data: snapshotContractData(sqlite),
    unmanagedObjects: captureUnmanagedObjects(sqlite),
  }
}

function noOpEvidence(
  sqlite,
  entries,
  contractSql,
  contractSqlPath,
  migrationsFolder,
) {
  const inspected = assertContractedState(
    sqlite,
    entries,
    contractSqlPath,
    migrationsFolder,
  )
  return {
    schemaVersion: 1,
    kind: 'arcade-library-contract-evidence-v1',
    status: 'contracted',
    noop: true,
    phase: { before: 'contracted', after: 'contracted' },
    backup: null,
    migration: {
      tag: entries.contractEntry.tag,
      hash: entries.contractEntry.hash,
      timestamp: entries.contractEntry.folderMillis,
      contractSqlSha256: contractSql.sha256,
      contractSchemaSha256: contractSql.schemaSha256,
    },
    before: {
      rebuiltDigest: inspected.data.rebuiltDigest,
      supportingDigest: inspected.data.supportingDigest,
      sequenceDigest: inspected.data.sequenceDigest,
      untouchedDigest: inspected.data.untouchedDigest,
    },
    after: {
      rebuiltDigest: inspected.data.rebuiltDigest,
      supportingDigest: inspected.data.supportingDigest,
      sequenceDigest: inspected.data.sequenceDigest,
    },
    checks: {
      rowsPreserved: true,
      supportingRowsPreserved: true,
      untouchedRowsPreserved: true,
      sequencePreserved: true,
      unmanagedObjectsPreserved: true,
      integrityCheck: inspected.checks.integrityCheck,
      foreignKeyViolationCount: inspected.checks.foreignKeyViolationCount,
    },
    rollback: null,
  }
}

function restoreConnectionPragmas(sqlite, originalLegacyAlterTable) {
  if (sqlite.inTransaction) sqlite.exec('ROLLBACK')
  sqlite.pragma(`legacy_alter_table = ${originalLegacyAlterTable ? 'ON' : 'OFF'}`)
  sqlite.pragma('foreign_keys = ON')
  if (Number(sqlite.pragma('foreign_keys', { simple: true })) !== 1) {
    throw new Error('contract runner could not restore foreign_keys=ON')
  }
  if (
    Number(sqlite.pragma('legacy_alter_table', { simple: true })) !==
    Number(originalLegacyAlterTable)
  ) {
    throw new Error('contract runner could not restore legacy_alter_table')
  }
}

function describeBackupAttempt(backupPath, backup) {
  if (backup) return { ...backup, exists: true, verified: true }
  if (!existsSync(backupPath)) {
    return { path: backupPath, exists: false, verified: false }
  }
  const metadata = lstatSync(backupPath)
  const regularFile = metadata.isFile() && !metadata.isSymbolicLink()
  return {
    path: backupPath,
    exists: true,
    verified: false,
    regularFile,
    symbolicLink: metadata.isSymbolicLink(),
    size: metadata.size,
    sha256: regularFile ? sha256Bytes(readFileSync(backupPath)) : null,
  }
}

function rollbackEvidence({ dbPath, backup, backupAttempt, entries }) {
  const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const phase = readLibraryMigrationState(sqlite).phase
    const ledger = readMigrationLedger(sqlite)
    const contractRecorded = ledger.some(
      ({ createdAt }) =>
        Number(createdAt) === Number(entries.contractEntry.folderMillis),
    )
    return {
      attempted: true,
      succeeded: phase === 'backfilled' && !contractRecorded,
      phaseAfter: phase,
      contractLedgerRecorded: contractRecorded,
      backupPreserved: backup
        ? existsSync(backup.path) &&
          sha256Bytes(readFileSync(backup.path)) === backup.sha256
        : backupAttempt.exists
          ? existsSync(backupAttempt.path) &&
            (backupAttempt.sha256 === null ||
              sha256Bytes(readFileSync(backupAttempt.path)) === backupAttempt.sha256)
          : null,
    }
  } finally {
    sqlite.close()
  }
}

function committedPostverifyEvidence({ dbPath, backup, entries }) {
  const backupAttempt = describeBackupAttempt(backup.path, backup)
  let phaseAfter = 'unknown'
  let contractLedgerRecorded = null
  let integrityCheck = null
  let inspectionError = null
  try {
    const sqlite = new Database(dbPath, { readonly: true, fileMustExist: true })
    try {
      phaseAfter = readLibraryMigrationState(sqlite).phase
      contractLedgerRecorded = readMigrationLedger(sqlite).some(
        ({ createdAt }) =>
          Number(createdAt) === Number(entries.contractEntry.folderMillis),
      )
      integrityCheck = sqlite.pragma('integrity_check', { simple: true })
    } finally {
      sqlite.close()
    }
  } catch (error) {
    inspectionError = error.message
  }
  return {
    schemaVersion: 1,
    kind: 'arcade-library-contract-evidence-v1',
    status: 'committed_but_postverify_failed',
    noop: false,
    phase: { before: 'backfilled', after: phaseAfter },
    backup,
    backupAttempt,
    postCommit: {
      contractLedgerRecorded,
      integrityCheck,
      inspectionError,
    },
    rollback: {
      attempted: false,
      succeeded: false,
      reason: 'transaction_already_committed',
      phaseAfter,
      contractLedgerRecorded,
      backupPreserved: backupAttempt.exists,
    },
  }
}

async function executeContractSqlWithStages({
  sqlite,
  contractSql,
  failureInjector,
  context,
}) {
  let cursor = 0
  for (const match of contractSql.matchAll(CONTRACT_SQL_STAGE_PATTERN)) {
    const sqlBeforeStage = contractSql.slice(cursor, match.index)
    if (sqlBeforeStage.trim() !== '') sqlite.exec(sqlBeforeStage)
    await failureInjector(match[1].toLowerCase(), context)
    cursor = match.index + match[0].length
  }
  const remainingSql = contractSql.slice(cursor)
  if (remainingSql.trim() !== '') sqlite.exec(remainingSql)
}

export async function contractLibraryDatabase({
  dbPath,
  backupPath,
  migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
  contractSqlPath = CONTRACT_SQL_PATH,
  backupDatabase = async ({ sourcePath, destinationPath, createBackup }) =>
    createBackup({ sourcePath, destinationPath }),
  failureInjector = () => {},
} = {}) {
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw new Error('contract requires a database path')
  }
  if (typeof backupDatabase !== 'function') {
    throw new TypeError('backupDatabase must be a function')
  }
  if (typeof failureInjector !== 'function') {
    throw new TypeError('failureInjector must be a function')
  }
  const absoluteDbPath = realpathSync(resolve(dbPath))
  const entries = migrationEntries(migrationsFolder)
  const contractSql = assertContractSqlBinding(contractSqlPath, migrationsFolder)

  const initial = new Database(absoluteDbPath, {
    readonly: true,
    fileMustExist: true,
  })
  let initialPhase
  try {
    initial.pragma('foreign_keys = ON')
    initialPhase = readLibraryMigrationState(initial).phase
    if (initialPhase === 'contracted') {
      return noOpEvidence(
        initial,
        entries,
        contractSql,
        contractSqlPath,
        migrationsFolder,
      )
    }
    if (initialPhase !== 'backfilled') {
      throw new Error(
        `contract requires migration phase backfilled; got ${initialPhase}`,
      )
    }
    inspectPreContract(initial, entries, migrationsFolder)
  } finally {
    initial.close()
  }

  const absoluteBackupPath = prepareBackupPath(absoluteDbPath, backupPath)
  await failureInjector('before_write_lock', {
    dbPath: absoluteDbPath,
    backupPath: absoluteBackupPath,
  })
  const sqlite = new Database(absoluteDbPath, { timeout: 10_000 })
  const originalLegacyAlterTable = Number(
    sqlite.pragma('legacy_alter_table', { simple: true }),
  )
  let backup = null
  let before = null
  let unmanagedBefore = null
  let completed = false
  try {
    if (sqlite.inTransaction) {
      throw new Error('contract runner requires a connection outside a transaction')
    }
    sqlite.pragma('foreign_keys = OFF')
    if (Number(sqlite.pragma('foreign_keys', { simple: true })) !== 0) {
      throw new Error('foreign_keys must be OFF before BEGIN IMMEDIATE')
    }
    sqlite.pragma('legacy_alter_table = ON')
    sqlite.exec('BEGIN IMMEDIATE')
    const lockedPhase = readLibraryMigrationState(sqlite).phase
    if (lockedPhase === 'contracted') {
      sqlite.exec('ROLLBACK')
      restoreConnectionPragmas(sqlite, originalLegacyAlterTable)
      const evidence = noOpEvidence(
        sqlite,
        entries,
        contractSql,
        contractSqlPath,
        migrationsFolder,
      )
      sqlite.close()
      return evidence
    }
    if (lockedPhase !== 'backfilled') {
      throw new Error(
        `contract requires migration phase backfilled after write lock; got ${lockedPhase}`,
      )
    }
    await failureInjector('after_write_freeze', { sqlite })
    claimFreshBackupPath(absoluteBackupPath)

    before = inspectPreContract(sqlite, entries, migrationsFolder)
    unmanagedBefore = captureUnmanagedObjects(sqlite)
    const sequenceBefore = before.data.sequence

    await backupDatabase({
      sourcePath: absoluteDbPath,
      destinationPath: absoluteBackupPath,
      createBackup: createBackupOutsideTransaction,
    })
    backup = verifyBackup({
      backupPath: absoluteBackupPath,
      expected: before,
      entries,
      migrationsFolder,
    })
    await failureInjector('after_backup', { sqlite, backup })

    const frozenAgain = inspectPreContract(sqlite, entries, migrationsFolder)
    sameFrozenState(before, frozenAgain, 'source')
    if (
      canonicalizeLibraryJson(unmanagedComparable(captureUnmanagedObjects(sqlite))) !==
      canonicalizeLibraryJson(unmanagedComparable(unmanagedBefore))
    ) {
      throw new Error('unmanaged schema objects changed after backup')
    }

    await executeContractSqlWithStages({
      sqlite,
      contractSql: contractSql.bytes.toString('utf8'),
      failureInjector,
      context: { sqlite, backup },
    })
    await failureInjector('after_contract_sql', { sqlite, backup })
    restoreUnmanagedObjects(sqlite, unmanagedBefore)
    await failureInjector('after_unmanaged_restore', { sqlite, backup })
    restoreSqliteSequence(sqlite, sequenceBefore)
    await failureInjector('after_sequence_restore', { sqlite, backup })

    assertContractedSchema(sqlite, { contractSqlPath, migrationsFolder })
    const coverage = contractCoverage(sqlite)
    assertZeroCoverage(coverage)
    const migrated = snapshotContractData(sqlite)
    for (const field of [
      'rebuiltDigest',
      'supportingDigest',
      'sequenceDigest',
      'untouchedDigest',
    ]) {
      if (migrated[field] !== before.data[field]) {
        throw new Error(`contract copy mismatch at ${field}`)
      }
    }
    sqliteChecks(sqlite, 'pre-commit contracted database')
    await failureInjector('before_ledger', { sqlite, backup })

    insertContractLedger(sqlite, entries.contractEntry)
    await failureInjector('after_ledger', { sqlite, backup })
    const phaseChange = sqlite
      .prepare(
        "UPDATE library_migration_state SET phase = 'contracted' WHERE id = 1 AND phase = 'backfilled'",
      )
      .run()
    if (phaseChange.changes !== 1) {
      throw new Error('contract could not advance migration phase to contracted')
    }
    await failureInjector('after_phase', { sqlite, backup })

    const inside = assertContractedState(
      sqlite,
      entries,
      contractSqlPath,
      migrationsFolder,
    )
    if (inside.data.rebuiltDigest !== before.data.rebuiltDigest) {
      throw new Error('contracted rows changed before commit')
    }
    if (inside.data.supportingDigest !== before.data.supportingDigest) {
      throw new Error('supporting rows changed before commit')
    }
    if (inside.data.sequenceDigest !== before.data.sequenceDigest) {
      throw new Error('sqlite_sequence changed before commit')
    }
    if (inside.data.untouchedDigest !== before.data.untouchedDigest) {
      throw new Error('untouched table rows changed before commit')
    }
    if (
      canonicalizeLibraryJson(unmanagedComparable(inside.unmanagedObjects)) !==
      canonicalizeLibraryJson(unmanagedComparable(unmanagedBefore))
    ) {
      throw new Error('unmanaged objects changed before commit')
    }
    await failureInjector('before_commit', { sqlite, backup })
    sqlite.exec('COMMIT')
    completed = true
  } catch (error) {
    if (sqlite.inTransaction) sqlite.exec('ROLLBACK')
    try {
      restoreConnectionPragmas(sqlite, originalLegacyAlterTable)
    } finally {
      sqlite.close()
    }
    const backupAttempt = describeBackupAttempt(absoluteBackupPath, backup)
    const rollback = rollbackEvidence({
      dbPath: absoluteDbPath,
      backup,
      backupAttempt,
      entries,
    })
    error.contractEvidence = {
      schemaVersion: 1,
      kind: 'arcade-library-contract-evidence-v1',
      status: rollback.succeeded ? 'rolled_back' : 'rollback_failed',
      noop: false,
      phase: { before: 'backfilled', after: rollback.phaseAfter },
      backup,
      backupAttempt,
      rollback,
    }
    throw error
  }

  let after
  try {
    try {
      restoreConnectionPragmas(sqlite, originalLegacyAlterTable)
    } finally {
      sqlite.close()
    }
    if (!completed) throw new Error('contract transaction did not complete')
    await failureInjector('after_commit', { backup })

    const verified = new Database(absoluteDbPath, {
      readonly: true,
      fileMustExist: true,
    })
    try {
      verified.pragma('foreign_keys = ON')
      after = assertContractedState(
        verified,
        entries,
        contractSqlPath,
        migrationsFolder,
      )
    } finally {
      verified.close()
    }
    if (after.data.rebuiltDigest !== before.data.rebuiltDigest) {
      throw new Error('post-commit row digest mismatch')
    }
    if (after.data.supportingDigest !== before.data.supportingDigest) {
      throw new Error('post-commit supporting row digest mismatch')
    }
    if (after.data.sequenceDigest !== before.data.sequenceDigest) {
      throw new Error('post-commit sqlite_sequence mismatch')
    }
    if (after.data.untouchedDigest !== before.data.untouchedDigest) {
      throw new Error('post-commit untouched table row mismatch')
    }
    if (
      canonicalizeLibraryJson(unmanagedComparable(after.unmanagedObjects)) !==
      canonicalizeLibraryJson(unmanagedComparable(unmanagedBefore))
    ) {
      throw new Error('post-commit unmanaged object mismatch')
    }
  } catch (error) {
    if (sqlite.open) sqlite.close()
    error.contractEvidence = committedPostverifyEvidence({
      dbPath: absoluteDbPath,
      backup,
      entries,
    })
    throw error
  }

  return {
    schemaVersion: 1,
    kind: 'arcade-library-contract-evidence-v1',
    status: 'contracted',
    noop: false,
    phase: { before: 'backfilled', after: 'contracted' },
    backup,
    migration: {
      tag: entries.contractEntry.tag,
      hash: entries.contractEntry.hash,
      timestamp: entries.contractEntry.folderMillis,
      contractSqlSha256: contractSql.sha256,
      contractSchemaSha256: contractSql.schemaSha256,
    },
    before: {
      rebuiltDigest: before.data.rebuiltDigest,
      supportingDigest: before.data.supportingDigest,
      sequenceDigest: before.data.sequenceDigest,
      untouchedDigest: before.data.untouchedDigest,
      unmanagedObjectDigest: canonicalDigest(unmanagedComparable(unmanagedBefore)),
    },
    after: {
      rebuiltDigest: after.data.rebuiltDigest,
      supportingDigest: after.data.supportingDigest,
      sequenceDigest: after.data.sequenceDigest,
      untouchedDigest: after.data.untouchedDigest,
      unmanagedObjectDigest: canonicalDigest(
        unmanagedComparable(after.unmanagedObjects),
      ),
    },
    checks: {
      rowsPreserved: true,
      supportingRowsPreserved: true,
      untouchedRowsPreserved: true,
      sequencePreserved: true,
      unmanagedObjectsPreserved: true,
      integrityCheck: after.checks.integrityCheck,
      foreignKeyViolationCount: after.checks.foreignKeyViolationCount,
    },
    rollback: null,
  }
}
