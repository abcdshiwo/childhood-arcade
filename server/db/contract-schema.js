import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { canonicalizeLibraryJson } from '../services/library-service.js'

const BASELINE_MIGRATION_TAG = '0000_baseline'
const EXPAND_MIGRATION_TAG = '0001_arcade_library_expand'
const CONTRACT_BASELINE_TAG = '0002_arcade_library_contract_baseline'
const CONTRACT_SCHEMA_HASH_PATTERN =
  /contract-schema-sha256:\s*([0-9a-f]{64})/i

export const DEFAULT_CONTRACT_SQL_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'contract-migrations',
  '0001_arcade_library_contract.sql',
)

export const MANAGED_CONTRACT_OBJECT_NAMES = new Set([
  'idx_favorites_rom',
  'idx_favorites_user',
  'idx_roms_active_build',
  'idx_roms_active_thumbnail',
  'idx_roms_parent',
  'rooms_code_unique',
  'roms_owner_platform_set_unique',
  'library_migration_state_phase_monotonic',
  'library_migration_state_no_reinsert',
  'library_migration_state_no_delete',
  'assets_identity_immutable',
  'rom_builds_runtime_parent_insert',
  'rom_builds_runtime_parent_update',
  'rom_builds_identity_immutable',
  'core_artifacts_identity_immutable',
  'rom_asset_refs_identity_immutable',
  'roms_contract_identity_immutable',
  'save_states_build_identity_insert',
  'save_states_build_identity_update',
])

function assertSqlite(sqlite) {
  if (!sqlite || typeof sqlite.prepare !== 'function') {
    throw new TypeError('a better-sqlite3 connection is required')
  }
}

function quotePragma(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function normalizedSchemaSql(sql) {
  return String(sql)
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\bIF\s+NOT\s+EXISTS\s+/gi, '')
    .replace(/;$/, '')
}

function canonicalSqlExpression(value, tableName = '') {
  const input = String(value)
  let output = ''
  let inString = false
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (inString) {
      output += character
      if (character === "'") {
        if (input[index + 1] === "'") {
          output += input[index + 1]
          index += 1
        } else {
          inString = false
        }
      }
      continue
    }
    if (character === "'") {
      inString = true
      output += character
      continue
    }
    if (character === '`' || character === '"' || /\s/.test(character)) {
      continue
    }
    output += character.toLowerCase()
  }
  return tableName
    ? output.replaceAll(`${String(tableName).toLowerCase()}.`, '')
    : output
}

function triggerDefinitionsFromSql(sql) {
  const definitions = new Map()
  const pattern =
    /CREATE TRIGGER\s+[`"]?([a-z][a-z0-9_]*)[`"]?[\s\S]*?\nEND;/gi
  for (const match of sql.matchAll(pattern)) {
    definitions.set(match[1], normalizedSchemaSql(match[0]))
  }
  return definitions
}

function indexDefinitionsFromSql(sql) {
  const definitions = new Map()
  const pattern =
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"]?([a-z][a-z0-9_]*)[`"]?[\s\S]*?;/gi
  for (const match of sql.matchAll(pattern)) {
    definitions.set(match[1], normalizedSchemaSql(match[0]))
  }
  return definitions
}

function rebuiltTableDefinitionsFromSql(sql) {
  const definitions = new Map()
  const pattern =
    /CREATE TABLE\s+[`"]?__contract_new_(roms|favorites|rooms|save_states)[`"]?\s*\([\s\S]*?\n\);/gi
  for (const match of sql.matchAll(pattern)) {
    definitions.set(
      match[1],
      match[0].replace(`__contract_new_${match[1]}`, match[1]),
    )
  }
  return definitions
}

function expectedManagedTriggers(contractSqlPath, migrationsFolder) {
  return new Map([
    ...triggerDefinitionsFromSql(
      readFileSync(resolve(migrationsFolder, `${EXPAND_MIGRATION_TAG}.sql`), 'utf8'),
    ),
    ...triggerDefinitionsFromSql(readFileSync(contractSqlPath, 'utf8')),
  ])
}

function expectedManagedIndexes(contractSqlPath, migrationsFolder) {
  return new Map([
    ...indexDefinitionsFromSql(
      readFileSync(resolve(migrationsFolder, `${BASELINE_MIGRATION_TAG}.sql`), 'utf8'),
    ),
    ...indexDefinitionsFromSql(
      readFileSync(resolve(migrationsFolder, `${EXPAND_MIGRATION_TAG}.sql`), 'utf8'),
    ),
    ...indexDefinitionsFromSql(readFileSync(contractSqlPath, 'utf8')),
  ])
}

export function computeContractSchemaSha256({
  contractSqlPath = DEFAULT_CONTRACT_SQL_PATH,
  migrationsFolder,
} = {}) {
  if (!migrationsFolder) throw new Error('migrationsFolder is required')
  const snapshot = JSON.parse(
    readFileSync(
      resolve(migrationsFolder, 'meta', '0002_snapshot.json'),
      'utf8',
    ),
  )
  const tables = Object.fromEntries(
    [...rebuiltTableDefinitionsFromSql(readFileSync(contractSqlPath, 'utf8'))].sort(
      ([left], [right]) => left.localeCompare(right, 'en'),
    ),
  )
  const triggers = Object.fromEntries(
    [...expectedManagedTriggers(contractSqlPath, migrationsFolder)].sort(
      ([left], [right]) => left.localeCompare(right, 'en'),
    ),
  )
  const indexes = Object.fromEntries(
    [...expectedManagedIndexes(contractSqlPath, migrationsFolder)].sort(
      ([left], [right]) => left.localeCompare(right, 'en'),
    ),
  )
  return createHash('sha256')
    .update(
      canonicalizeLibraryJson({ snapshot, tables, triggers, indexes }),
      'utf8',
    )
    .digest('hex')
}

function hasWholeOuterParentheses(value) {
  if (!value.startsWith('(') || !value.endsWith(')')) return false
  let depth = 0
  let quote = null
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote) index += 1
        else quote = null
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

function normalizeDefault(value) {
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
  const escaped = escapeRegExp(columnName)
  const identifier = `(?:\`${escaped}\`|"${escaped}"|\\[${escaped}\\]|${escaped})`
  return new RegExp(
    `(?:^|[,(]\\s*)${identifier}\\s+integer\\s+primary\\s+key\\s+autoincrement\\b`,
    'i',
  ).test(tableSql)
}

function expectedPrimaryKeyColumns(table) {
  const composite = Object.values(table.compositePrimaryKeys ?? {})[0]
  if (composite) return composite.columns
  return Object.values(table.columns)
    .filter((column) => column.primaryKey)
    .map((column) => column.name)
}

function foreignKeySignatures(sqlite, tableName) {
  const groups = new Map()
  for (const row of sqlite
    .prepare(`PRAGMA foreign_key_list(${quotePragma(tableName)})`)
    .all()) {
    const group = groups.get(row.id) ?? {
      tableTo: row.table,
      columnsFrom: [],
      columnsTo: [],
      onDelete: String(row.on_delete).toLowerCase(),
      onUpdate: String(row.on_update).toLowerCase(),
    }
    group.columnsFrom[row.seq] = row.from
    group.columnsTo[row.seq] = row.to
    groups.set(row.id, group)
  }
  return [...groups.values()].map((foreignKey) =>
    canonicalizeLibraryJson(foreignKey),
  )
}

function extractNamedChecks(tableSql, label) {
  const checks = new Map()
  const pattern =
    /CONSTRAINT\s+[`"]?([a-z][a-z0-9_]*)[`"]?\s+CHECK\s*\(/gi
  for (const match of tableSql.matchAll(pattern)) {
    const opening = match.index + match[0].lastIndexOf('(')
    let depth = 0
    let quote = null
    let closing = -1
    for (let index = opening; index < tableSql.length; index += 1) {
      const character = tableSql[index]
      if (quote) {
        if (character === quote) {
          if (tableSql[index + 1] === quote) index += 1
          else quote = null
        }
        continue
      }
      if (character === "'" || character === '"' || character === '`') {
        quote = character
        continue
      }
      if (character === '(') depth += 1
      if (character === ')' && --depth === 0) {
        closing = index
        break
      }
    }
    if (closing < 0) throw new Error(`${label} check ${match[1]} is malformed`)
    checks.set(match[1], tableSql.slice(opening + 1, closing))
  }
  return checks
}

function expectedIndexXinfo(indexSql) {
  const onMatch = indexSql.match(/\bON\s+[`"]?[a-z][a-z0-9_]*[`"]?\s*\(/i)
  if (!onMatch) throw new Error('managed index SQL is missing its ON clause')
  const opening = onMatch.index + onMatch[0].lastIndexOf('(')
  const closing = indexSql.indexOf(')', opening + 1)
  if (closing < 0) throw new Error('managed index column list is malformed')
  return indexSql
    .slice(opening + 1, closing)
    .split(',')
    .map((columnSql) => {
      const normalized = columnSql.replaceAll('`', '').replaceAll('"', '').trim()
      const name = normalized.match(/^(?:[a-z][a-z0-9_]*\.)?([a-z][a-z0-9_]*)/i)?.[1]
      if (!name) throw new Error(`unsupported managed index column: ${columnSql}`)
      return {
        name,
        collation:
          normalized.match(/\bCOLLATE\s+([a-z][a-z0-9_]*)/i)?.[1]?.toUpperCase() ??
          'BINARY',
        descending: /\bDESC\b/i.test(normalized) ? 1 : 0,
        key: 1,
      }
    })
}

function assertSnapshotShape(sqlite, snapshot, { exact, label }) {
  for (const [tableName, table] of Object.entries(snapshot.tables)) {
    const tableRow = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)
    if (!tableRow) throw new Error(`${label} is missing table ${tableName}`)
    const tableSql = tableRow.sql
    const columns = sqlite
      .prepare(`PRAGMA table_xinfo(${quotePragma(tableName)})`)
      .all()
    const actualByName = new Map(columns.map((column) => [column.name, column]))
    for (const expected of Object.values(table.columns)) {
      const actual = actualByName.get(expected.name)
      if (!actual) throw new Error(`${label} is missing ${tableName}.${expected.name}`)
      if (String(actual.type).toLowerCase() !== expected.type.toLowerCase()) {
        throw new Error(`${label} column ${tableName}.${expected.name} type has drifted`)
      }
      if (Boolean(actual.notnull) !== Boolean(expected.notNull)) {
        throw new Error(`${label} column ${tableName}.${expected.name} nullability has drifted`)
      }
      if (normalizeDefault(actual.dflt_value) !== normalizeDefault(expected.default)) {
        throw new Error(`${label} column ${tableName}.${expected.name} default has drifted`)
      }
      if (expected.autoincrement && !columnHasAutoincrement(tableSql, expected.name)) {
        throw new Error(`${label} column ${tableName}.${expected.name} lost AUTOINCREMENT`)
      }
    }
    if (exact && columns.length !== Object.keys(table.columns).length) {
      throw new Error(`${label} table ${tableName} columns have drifted`)
    }

    const actualPrimaryKey = columns
      .filter(({ pk }) => Number(pk) > 0)
      .sort((left, right) => left.pk - right.pk)
      .map(({ name }) => name)
    if (
      canonicalizeLibraryJson(actualPrimaryKey) !==
      canonicalizeLibraryJson(expectedPrimaryKeyColumns(table))
    ) {
      throw new Error(`${label} table ${tableName} primary key has drifted`)
    }

    const actualIndexes = new Map(
      sqlite
        .prepare(`PRAGMA index_list(${quotePragma(tableName)})`)
        .all()
        .map((index) => [index.name, index]),
    )
    for (const expected of Object.values(table.indexes ?? {})) {
      const actual = actualIndexes.get(expected.name)
      const columns = actual
        ? sqlite
            .prepare(`PRAGMA index_info(${quotePragma(expected.name)})`)
            .all()
            .sort((left, right) => left.seqno - right.seqno)
            .map(({ name }) => name)
        : []
      if (
        !actual ||
        Boolean(actual.unique) !== expected.isUnique ||
        Boolean(actual.partial) !== Boolean(expected.where) ||
        canonicalizeLibraryJson(columns) !== canonicalizeLibraryJson(expected.columns)
      ) {
        throw new Error(`${label} index ${expected.name} has drifted`)
      }
      if (expected.where) {
        const indexSql = sqlite
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
          .get(expected.name)?.sql
        const where = indexSql?.match(/\bWHERE\b([\s\S]+)$/i)?.[1]
        if (
          !where ||
          canonicalSqlExpression(where, tableName) !==
            canonicalSqlExpression(expected.where, tableName)
        ) {
          throw new Error(`${label} index ${expected.name} predicate has drifted`)
        }
      }
    }

    const actualForeignKeys = foreignKeySignatures(sqlite, tableName)
    const expectedForeignKeys = Object.values(table.foreignKeys ?? {}).map((fk) =>
      canonicalizeLibraryJson({
        tableTo: fk.tableTo,
        columnsFrom: fk.columnsFrom,
        columnsTo: fk.columnsTo,
        onDelete: fk.onDelete.toLowerCase(),
        onUpdate: fk.onUpdate.toLowerCase(),
      }),
    )
    for (const expected of expectedForeignKeys) {
      if (!actualForeignKeys.includes(expected)) {
        throw new Error(`${label} table ${tableName} foreign key has drifted`)
      }
    }
    if (exact && actualForeignKeys.length !== expectedForeignKeys.length) {
      throw new Error(`${label} table ${tableName} foreign keys have drifted`)
    }

    const checks = extractNamedChecks(tableSql, label)
    const expectedChecks = Object.values(table.checkConstraints ?? {})
    for (const expected of expectedChecks) {
      const actual = checks.get(expected.name)
      if (
        actual === undefined ||
        canonicalSqlExpression(actual, tableName) !==
          canonicalSqlExpression(expected.value, tableName)
      ) {
        throw new Error(`${label} check ${expected.name} has drifted`)
      }
    }
    if (
      exact &&
      ((tableSql.match(/\bCHECK\s*\(/gi) ?? []).length !== expectedChecks.length ||
        checks.size !== expectedChecks.length)
    ) {
      throw new Error(`${label} table ${tableName} checks have drifted`)
    }

    const expectedUnique = Object.values(table.uniqueConstraints ?? {})
      .map(({ columns }) => canonicalizeLibraryJson(columns))
      .sort()
    const actualUnique = [...actualIndexes.values()]
      .filter(({ origin }) => origin === 'u')
      .map(({ name }) =>
        canonicalizeLibraryJson(
          sqlite
            .prepare(`PRAGMA index_info(${quotePragma(name)})`)
            .all()
            .sort((left, right) => left.seqno - right.seqno)
            .map(({ name: columnName }) => columnName),
        ),
      )
      .sort()
    if (
      (exact &&
        canonicalizeLibraryJson(actualUnique) !== canonicalizeLibraryJson(expectedUnique)) ||
      (!exact && expectedUnique.some((value) => !actualUnique.includes(value)))
    ) {
      throw new Error(`${label} table ${tableName} unique constraints have drifted`)
    }
    if (/\b(?:WITHOUT\s+ROWID|STRICT)\b/i.test(tableSql)) {
      throw new Error(`${label} table ${tableName} options have drifted`)
    }
  }
}

function assertManagedObjects(sqlite, { contractSqlPath, migrationsFolder }) {
  for (const [indexName, expectedSql] of expectedManagedIndexes(
    contractSqlPath,
    migrationsFolder,
  )) {
    const actualSql = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(indexName)?.sql
    if (!actualSql || normalizedSchemaSql(actualSql) !== expectedSql) {
      throw new Error(`contracted index ${indexName} has drifted`)
    }
    const actualXinfo = sqlite
      .prepare(`PRAGMA index_xinfo(${quotePragma(indexName)})`)
      .all()
      .filter(({ key }) => Number(key) === 1)
      .sort((left, right) => left.seqno - right.seqno)
      .map(({ name, coll, desc, key }) => ({
        name,
        collation: String(coll).toUpperCase(),
        descending: Number(desc),
        key: Number(key),
      }))
    if (
      canonicalizeLibraryJson(actualXinfo) !==
      canonicalizeLibraryJson(expectedIndexXinfo(expectedSql))
    ) {
      throw new Error(`contracted index ${indexName} xinfo has drifted`)
    }
  }

  const actualTriggers = new Map(
    sqlite
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'")
      .all()
      .map(({ name, sql }) => [name, normalizedSchemaSql(sql)]),
  )
  for (const [name, expectedSql] of expectedManagedTriggers(
    contractSqlPath,
    migrationsFolder,
  )) {
    if (actualTriggers.get(name) !== expectedSql) {
      throw new Error(`contracted trigger ${name} has drifted`)
    }
  }

  if (
    sqlite
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name LIKE '__contract_new_%' LIMIT 1",
      )
      .get()
  ) {
    throw new Error('contracted schema contains a temporary table')
  }
}

function assertSchemaBinding({ contractSqlPath, migrationsFolder }) {
  const marker = readFileSync(
    resolve(migrationsFolder, `${CONTRACT_BASELINE_TAG}.sql`),
    'utf8',
  )
  const expected = marker.match(CONTRACT_SCHEMA_HASH_PATTERN)?.[1]?.toLowerCase()
  const actual = computeContractSchemaSha256({
    contractSqlPath,
    migrationsFolder,
  })
  if (!expected || expected !== actual) {
    throw new Error('contracted schema marker hash has drifted')
  }
  return actual
}

function assertContractSchema(
  sqlite,
  {
    migrationsFolder,
    contractSqlPath = DEFAULT_CONTRACT_SQL_PATH,
    exact,
    label,
  },
) {
  assertSqlite(sqlite)
  const snapshot = JSON.parse(
    readFileSync(
      resolve(migrationsFolder, 'meta', '0002_snapshot.json'),
      'utf8',
    ),
  )
  assertSnapshotShape(sqlite, snapshot, { exact, label })
  const schemaSha256 = assertSchemaBinding({ contractSqlPath, migrationsFolder })
  assertManagedObjects(sqlite, { contractSqlPath, migrationsFolder })

  const expectedTables = rebuiltTableDefinitionsFromSql(
    readFileSync(contractSqlPath, 'utf8'),
  )
  for (const [tableName, expectedSql] of expectedTables) {
    const actualSql = sqlite
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName)?.sql
    if (!actualSql) throw new Error(`${label} is missing table ${tableName}`)
    if (
      exact &&
      canonicalSqlExpression(normalizedSchemaSql(actualSql)) !==
        canonicalSqlExpression(normalizedSchemaSql(expectedSql))
    ) {
      throw new Error(`${label} table ${tableName} SQL has drifted`)
    }
    if (!exact && tableName === 'roms') {
      for (const collation of ['set_name_normalized', 'dat_parent_set_name', 'family_root_set_name']) {
        const actualPattern = new RegExp(
          `(?:\`${collation}\`|"${collation}"|${collation})\\s+text\\s+collate\\s+nocase\\b`,
          'i',
        )
        if (!actualPattern.test(actualSql)) {
          throw new Error(`${label} column ${tableName}.${collation} collation has drifted`)
        }
      }
    }
  }
  return { schemaSha256 }
}

export function assertPreContractSchema(sqlite, { migrationsFolder } = {}) {
  if (!migrationsFolder) throw new Error('migrationsFolder is required')
  const snapshot = JSON.parse(
    readFileSync(
      resolve(migrationsFolder, 'meta', '0001_snapshot.json'),
      'utf8',
    ),
  )
  assertSnapshotShape(sqlite, snapshot, {
    exact: true,
    label: 'pre-contract schema',
  })
  return true
}

export function assertContractedSchema(
  sqlite,
  { migrationsFolder, contractSqlPath = DEFAULT_CONTRACT_SQL_PATH } = {},
) {
  if (!migrationsFolder) throw new Error('migrationsFolder is required')
  return assertContractSchema(sqlite, {
    migrationsFolder,
    contractSqlPath,
    exact: true,
    label: 'contracted schema',
  })
}

export function assertContractOwnershipSchema(
  sqlite,
  { migrationsFolder, contractSqlPath = DEFAULT_CONTRACT_SQL_PATH } = {},
) {
  if (!migrationsFolder) throw new Error('migrationsFolder is required')
  return assertContractSchema(sqlite, {
    migrationsFolder,
    contractSqlPath,
    exact: false,
    label: 'runtime contract ownership schema',
  })
}
