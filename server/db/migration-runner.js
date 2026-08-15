import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readMigrationFiles } from 'drizzle-orm/migrator'

export const BASELINE_MIGRATION_TAG = '0000_baseline'
export const EXPAND_MIGRATION_TAG = '0001_arcade_library_expand'
export const CONTRACT_BASELINE_TAG = '0002_arcade_library_contract_baseline'
export const DEFAULT_MIGRATIONS_FOLDER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'migrations',
)

function assertSqliteConnection(sqlite) {
  if (!sqlite || typeof sqlite.prepare !== 'function' || typeof sqlite.exec !== 'function') {
    throw new TypeError('a better-sqlite3 connection is required')
  }
}

function tableExists(sqlite, tableName) {
  return Boolean(
    sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName),
  )
}

function ensureMigrationLedger(sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `)
}

function findMigration(entries, tag) {
  const matches = entries.filter((entry) => entry.tag === tag)
  if (matches.length !== 1) {
    throw new Error(`expected exactly one migration tagged ${tag}, found ${matches.length}`)
  }
  return matches[0]
}

function validateJournal(journal, files) {
  if (!Array.isArray(journal.entries) || journal.entries.length !== files.length) {
    throw new Error('migration journal and SQL file manifest are out of sync')
  }

  const tags = new Set()
  let priorTimestamp = -Infinity
  for (const entry of journal.entries) {
    if (!Number.isInteger(entry.idx) || !Number.isFinite(entry.when) || !entry.tag) {
      throw new Error('migration journal contains an invalid entry')
    }
    if (tags.has(entry.tag)) throw new Error(`duplicate migration tag: ${entry.tag}`)
    if (entry.when <= priorTimestamp) {
      throw new Error('migration journal timestamps must be strictly increasing')
    }
    tags.add(entry.tag)
    priorTimestamp = entry.when
  }
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function deterministicLineEndingHashes(rawSql) {
  const lf = rawSql.replace(/\r\n/g, '\n')
  const crlf = lf.replace(/\n/g, '\r\n')
  return [...new Set([sha256Text(rawSql), sha256Text(lf), sha256Text(crlf)])]
}

export function loadMigrationManifest(migrationsFolder = DEFAULT_MIGRATIONS_FOLDER) {
  const folder = resolve(migrationsFolder)
  const journal = JSON.parse(
    readFileSync(resolve(folder, 'meta', '_journal.json'), 'utf8'),
  )
  const files = readMigrationFiles({ migrationsFolder: folder })
  validateJournal(journal, files)

  return journal.entries.map((journalEntry, index) => {
    const rawSql = readFileSync(resolve(folder, `${journalEntry.tag}.sql`), 'utf8')
    return {
      idx: journalEntry.idx,
      version: journalEntry.version,
      tag: journalEntry.tag,
      breakpoints: journalEntry.breakpoints,
      folderMillis: files[index].folderMillis,
      hash: files[index].hash,
      sql: files[index].sql,
      allowedLegacyHashes:
        journalEntry.tag === BASELINE_MIGRATION_TAG
          ? deterministicLineEndingHashes(rawSql)
          : undefined,
      baselineSnapshot:
        journalEntry.tag === BASELINE_MIGRATION_TAG
          ? JSON.parse(
              readFileSync(resolve(folder, 'meta', '0000_snapshot.json'), 'utf8'),
            )
          : undefined,
    }
  })
}

export function readMigrationLedger(sqlite) {
  assertSqliteConnection(sqlite)
  if (!tableExists(sqlite, '__drizzle_migrations')) return []
  return sqlite
    .prepare(`
      SELECT rowid AS rowId, id, hash, created_at AS createdAt
      FROM __drizzle_migrations
      ORDER BY created_at, rowid
    `)
    .all()
}

function quotedPragmaArgument(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function expectedPrimaryKeyColumns(table) {
  const composite = Object.values(table.compositePrimaryKeys ?? {})[0]
  if (composite) return composite.columns
  return Object.values(table.columns)
    .filter((column) => column.primaryKey)
    .map((column) => column.name)
}

function hasWholeOuterParentheses(value) {
  if (!value.startsWith('(') || !value.endsWith(')')) return false

  let depth = 0
  let quote = null
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote) {
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (depth === 0 && index < value.length - 1) return false
    if (depth < 0) return false
  }
  return depth === 0 && quote === null
}

function normalizeSqliteDefault(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)

  let normalized = String(value).trim()
  while (hasWholeOuterParentheses(normalized)) {
    normalized = normalized.slice(1, -1).trim()
  }
  if (
    (normalized.startsWith("'") && normalized.endsWith("'")) ||
    (normalized.startsWith('"') && normalized.endsWith('"'))
  ) {
    return normalized
  }
  return normalized.toLowerCase()
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function columnHasAutoincrement(tableSql, columnName) {
  const escapedName = escapeRegExp(columnName)
  const identifier = `(?:\`${escapedName}\`|"${escapedName}"|\\[${escapedName}\\]|${escapedName})`
  return new RegExp(
    `(?:^|[,(]\\s*)${identifier}\\s+integer\\s+primary\\s+key\\s+autoincrement\\b`,
    'i',
  ).test(tableSql)
}

function actualForeignKeySignatures(sqlite, tableName) {
  const rows = sqlite
    .prepare(`PRAGMA foreign_key_list(${quotedPragmaArgument(tableName)})`)
    .all()
  const grouped = new Map()
  for (const row of rows) {
    const group = grouped.get(row.id) ?? {
      tableTo: row.table,
      columnsFrom: [],
      columnsTo: [],
      onDelete: String(row.on_delete).toLowerCase(),
      onUpdate: String(row.on_update).toLowerCase(),
    }
    group.columnsFrom[row.seq] = row.from
    group.columnsTo[row.seq] = row.to
    grouped.set(row.id, group)
  }
  return [...grouped.values()].map((foreignKey) => JSON.stringify(foreignKey))
}

export function assertBaselineShape(
  sqlite,
  snapshot = JSON.parse(
    readFileSync(
      resolve(DEFAULT_MIGRATIONS_FOLDER, 'meta', '0000_snapshot.json'),
      'utf8',
    ),
  ),
) {
  assertSqliteConnection(sqlite)
  for (const [tableName, table] of Object.entries(snapshot.tables)) {
    if (!tableExists(sqlite, tableName)) {
      throw new Error(`legacy baseline is missing table ${tableName}`)
    }
    const tableSql = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName).sql

    const actualColumns = new Map(
      sqlite
        .prepare(`PRAGMA table_info(${quotedPragmaArgument(tableName)})`)
        .all()
        .map((column) => [column.name, column]),
    )
    for (const expectedColumn of Object.values(table.columns)) {
      const actual = actualColumns.get(expectedColumn.name)
      if (!actual) {
        throw new Error(
          `legacy baseline is missing ${tableName}.${expectedColumn.name}`,
        )
      }
      if (String(actual.type).toLowerCase() !== expectedColumn.type.toLowerCase()) {
        throw new Error(
          `legacy baseline column ${tableName}.${expectedColumn.name} has type ${actual.type}, expected ${expectedColumn.type}`,
        )
      }
      if (Boolean(actual.notnull) !== Boolean(expectedColumn.notNull)) {
        throw new Error(
          `legacy baseline column ${tableName}.${expectedColumn.name} nullability has drifted`,
        )
      }
      if (
        normalizeSqliteDefault(actual.dflt_value) !==
        normalizeSqliteDefault(expectedColumn.default)
      ) {
        throw new Error(
          `legacy baseline column ${tableName}.${expectedColumn.name} default has drifted`,
        )
      }
      if (
        expectedColumn.autoincrement &&
        !columnHasAutoincrement(tableSql, expectedColumn.name)
      ) {
        throw new Error(
          `legacy baseline column ${tableName}.${expectedColumn.name} lost AUTOINCREMENT`,
        )
      }
    }

    const actualPrimaryKey = [...actualColumns.values()]
      .filter(({ pk }) => pk > 0)
      .sort((left, right) => left.pk - right.pk)
      .map(({ name }) => name)
    const expectedPrimaryKey = expectedPrimaryKeyColumns(table)
    if (JSON.stringify(actualPrimaryKey) !== JSON.stringify(expectedPrimaryKey)) {
      throw new Error(
        `legacy baseline ${tableName} primary key must be (${expectedPrimaryKey.join(', ')})`,
      )
    }

    const actualIndexes = new Map(
      sqlite
        .prepare(`PRAGMA index_list(${quotedPragmaArgument(tableName)})`)
        .all()
        .map((indexRow) => [indexRow.name, indexRow]),
    )
    for (const expectedIndex of Object.values(table.indexes ?? {})) {
      const actualIndex = actualIndexes.get(expectedIndex.name)
      if (!actualIndex) {
        throw new Error(`legacy baseline is missing index ${expectedIndex.name}`)
      }
      const actualIndexColumns = sqlite
        .prepare(`PRAGMA index_info(${quotedPragmaArgument(expectedIndex.name)})`)
        .all()
        .sort((left, right) => left.seqno - right.seqno)
        .map(({ name }) => name)
      if (
        Boolean(actualIndex.unique) !== expectedIndex.isUnique ||
        Boolean(actualIndex.partial) !== Boolean(expectedIndex.where) ||
        JSON.stringify(actualIndexColumns) !== JSON.stringify(expectedIndex.columns)
      ) {
        throw new Error(`legacy baseline index ${expectedIndex.name} has drifted`)
      }
    }

    const actualForeignKeys = new Set(actualForeignKeySignatures(sqlite, tableName))
    for (const expectedForeignKey of Object.values(table.foreignKeys ?? {})) {
      const signature = JSON.stringify({
        tableTo: expectedForeignKey.tableTo,
        columnsFrom: expectedForeignKey.columnsFrom,
        columnsTo: expectedForeignKey.columnsTo,
        onDelete: expectedForeignKey.onDelete.toLowerCase(),
        onUpdate: expectedForeignKey.onUpdate.toLowerCase(),
      })
      if (!actualForeignKeys.has(signature)) {
        throw new Error(
          `legacy baseline foreign key ${expectedForeignKey.name} has drifted`,
        )
      }
    }
  }
  return true
}

export function assertExactLedgerEntry(
  sqlite,
  entry,
  { allowLegacyBaselineHashMismatch = true, onWarning = console.warn } = {},
) {
  const matches = readMigrationLedger(sqlite).filter(
    ({ createdAt }) => Number(createdAt) === Number(entry.folderMillis),
  )
  if (matches.length === 0) {
    throw new Error(`migration ledger is missing ${entry.tag} (${entry.folderMillis})`)
  }
  if (matches.length > 1) {
    throw new Error(`migration ledger has duplicate timestamp ${entry.folderMillis}`)
  }

  const row = matches[0]
  if (row.hash !== entry.hash) {
    if (entry.tag === BASELINE_MIGRATION_TAG && allowLegacyBaselineHashMismatch) {
      if (!entry.allowedLegacyHashes?.includes(row.hash)) {
        throw new Error(
          `legacy baseline hash mismatch at timestamp ${entry.folderMillis}: got an unknown hash ${row.hash}`,
        )
      }
      assertBaselineShape(sqlite, entry.baselineSnapshot)
      onWarning(
        `[db] legacy baseline hash differs from the current LF-pinned SQL; verified the actual baseline shape instead`,
      )
      return { exact: false, legacyBaseline: true, row }
    }
    throw new Error(
      `migration ${entry.tag} hash mismatch at timestamp ${entry.folderMillis}: expected ${entry.hash}, got ${row.hash}`,
    )
  }
  if (entry.tag === BASELINE_MIGRATION_TAG) {
    assertBaselineShape(sqlite, entry.baselineSnapshot)
  }
  return { exact: true, legacyBaseline: false, row }
}

function assertPriorLedgerEntries(sqlite, manifestEntries, manifestIndex, entry) {
  const ledger = readMigrationLedger(sqlite)
  for (const prior of manifestEntries.slice(0, manifestIndex)) {
    if (
      !ledger.some(
        ({ createdAt }) => Number(createdAt) === Number(prior.folderMillis),
      )
    ) {
      throw new Error(
        `cannot apply ${entry.tag}; prior migration ${prior.tag} is missing from the ledger`,
      )
    }
  }
  return ledger
}

function assertMigrationIsNotBehindLedger(ledger, entry) {
  const newestTimestamp = ledger.reduce(
    (latest, row) => Math.max(latest, Number(row.createdAt)),
    -Infinity,
  )
  if (newestTimestamp > entry.folderMillis) {
    throw new Error(
      `cannot apply missing migration ${entry.tag} behind ledger timestamp ${newestTimestamp}`,
    )
  }
}

function applySingleMigration(
  sqlite,
  entry,
  {
    manifestEntries,
    manifestIndex,
    allowLegacyBaselineHashMismatch,
    onWarning,
  },
) {
  const run = sqlite.transaction(() => {
    auditMigrationLedger(sqlite, manifestEntries, {
      allowLegacyBaselineHashMismatch,
      onWarning,
    })
    const ledger = assertPriorLedgerEntries(
      sqlite,
      manifestEntries,
      manifestIndex,
      entry,
    )
    const existing = ledger.filter(
      ({ createdAt }) => Number(createdAt) === Number(entry.folderMillis),
    )
    if (existing.length > 0) {
      assertExactLedgerEntry(sqlite, entry, {
        allowLegacyBaselineHashMismatch,
        onWarning,
      })
      return false
    }
    assertMigrationIsNotBehindLedger(ledger, entry)

    for (const statement of entry.sql) {
      if (statement.trim()) sqlite.exec(statement)
    }
    if (entry.tag === BASELINE_MIGRATION_TAG) {
      assertBaselineShape(sqlite, entry.baselineSnapshot)
    }
    sqlite
      .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
      .run(entry.hash, entry.folderMillis)
    return true
  })
  return run.immediate()
}

function validateManifestEntries(entries) {
  const timestamps = new Set()
  const tags = new Set()
  let previousTimestamp = -Infinity
  for (const entry of entries) {
    const timestamp = Number(entry.folderMillis)
    if (timestamps.has(timestamp)) {
      throw new Error(`migration manifest has duplicate timestamp ${timestamp}`)
    }
    if (tags.has(entry.tag)) throw new Error(`migration manifest has duplicate tag ${entry.tag}`)
    if (timestamp <= previousTimestamp) {
      throw new Error('migration manifest must be ordered by increasing timestamp')
    }
    timestamps.add(timestamp)
    tags.add(entry.tag)
    previousTimestamp = timestamp
  }
}

function auditMigrationLedger(
  sqlite,
  manifestEntries,
  { allowLegacyBaselineHashMismatch, onWarning },
) {
  validateManifestEntries(manifestEntries)
  const byTimestamp = new Map(
    manifestEntries.map((entry) => [Number(entry.folderMillis), entry]),
  )
  const ledger = readMigrationLedger(sqlite)
  const seenTimestamps = new Set()
  for (const row of ledger) {
    const timestamp = Number(row.createdAt)
    if (seenTimestamps.has(timestamp)) {
      throw new Error(`migration ledger has duplicate timestamp ${timestamp}`)
    }
    seenTimestamps.add(timestamp)
    const entry = byTimestamp.get(timestamp)
    if (!entry) {
      throw new Error(`migration ledger contains unknown timestamp ${timestamp}`)
    }
    assertExactLedgerEntry(sqlite, entry, {
      allowLegacyBaselineHashMismatch,
      onWarning,
    })
  }
  return ledger
}

export function applyMigrationEntries(
  sqlite,
  entries,
  {
    allowLegacyBaselineHashMismatch = true,
    onWarning = console.warn,
    manifestEntries = entries,
  } = {},
) {
  assertSqliteConnection(sqlite)
  ensureMigrationLedger(sqlite)
  auditMigrationLedger(sqlite, manifestEntries, {
    allowLegacyBaselineHashMismatch,
    onWarning,
  })

  for (const entry of entries) {
    const manifestIndex = manifestEntries.findIndex(
      (candidate) =>
        candidate.tag === entry.tag &&
        Number(candidate.folderMillis) === Number(entry.folderMillis),
    )
    if (manifestIndex < 0) {
      throw new Error(`migration ${entry.tag} is not present in the supplied manifest`)
    }
    assertPriorLedgerEntries(sqlite, manifestEntries, manifestIndex, entry)

    const existing = readMigrationLedger(sqlite).filter(
      ({ createdAt }) => Number(createdAt) === Number(entry.folderMillis),
    )
    if (existing.length > 0) {
      assertExactLedgerEntry(sqlite, entry, {
        allowLegacyBaselineHashMismatch,
        onWarning,
      })
      continue
    }

    assertMigrationIsNotBehindLedger(readMigrationLedger(sqlite), entry)

    applySingleMigration(sqlite, entry, {
      manifestEntries,
      manifestIndex,
      allowLegacyBaselineHashMismatch,
      onWarning,
    })
    assertExactLedgerEntry(sqlite, entry, {
      allowLegacyBaselineHashMismatch: false,
      onWarning,
    })
  }
  return auditMigrationLedger(sqlite, manifestEntries, {
    allowLegacyBaselineHashMismatch,
    onWarning,
  })
}

export function readLibraryMigrationState(sqlite) {
  assertSqliteConnection(sqlite)
  if (!tableExists(sqlite, 'library_migration_state')) {
    return { phase: 'absent', updatedAt: null }
  }
  const row = sqlite
    .prepare(
      'SELECT phase, updated_at AS updatedAt FROM library_migration_state WHERE id = 1',
    )
    .get()
  if (!row) return { phase: 'absent', updatedAt: null }
  return { phase: row.phase, updatedAt: Number(row.updatedAt) }
}

export function expandLibraryDatabase(
  sqlite,
  { migrationsFolder = DEFAULT_MIGRATIONS_FOLDER } = {},
) {
  const entries = loadMigrationManifest(migrationsFolder)
  const expand = findMigration(entries, EXPAND_MIGRATION_TAG)
  const expandIndex = entries.indexOf(expand)
  applyMigrationEntries(sqlite, entries.slice(0, expandIndex + 1), {
    manifestEntries: entries,
  })
  const state = readLibraryMigrationState(sqlite)
  if (state.phase === 'absent') {
    throw new Error('expand migration did not create library_migration_state')
  }
  return state
}

export function prepareDatabaseForRuntime(
  sqlite,
  {
    migrationsFolder = DEFAULT_MIGRATIONS_FOLDER,
    onWarning = console.warn,
  } = {},
) {
  const entries = loadMigrationManifest(migrationsFolder)
  const expand = findMigration(entries, EXPAND_MIGRATION_TAG)
  const expandIndex = entries.indexOf(expand)

  applyMigrationEntries(sqlite, entries.slice(0, expandIndex + 1), {
    manifestEntries: entries,
    onWarning,
  })
  const state = readLibraryMigrationState(sqlite)
  if (state.phase !== 'contracted') {
    throw new Error(
      `Database library migration phase is "${state.phase}"; runtime requires "contracted". ` +
        'Run "node scripts/migrate-library.js backfill" and then "node scripts/migrate-library.js contract" with an implementation that provides Tasks 2 and 3.',
    )
  }

  const contract = findMigration(entries, CONTRACT_BASELINE_TAG)
  const contractIndex = entries.indexOf(contract)
  if (contractIndex !== expandIndex + 1) {
    throw new Error(
      'contract baseline migration must immediately follow the expand migration',
    )
  }
  assertExactLedgerEntry(sqlite, contract, {
    allowLegacyBaselineHashMismatch: false,
    onWarning,
  })

  applyMigrationEntries(sqlite, entries.slice(contractIndex + 1), {
    allowLegacyBaselineHashMismatch: true,
    manifestEntries: entries,
    onWarning,
  })
  return { state, ledger: readMigrationLedger(sqlite) }
}
