import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

// Status enum (soft-delete pattern copied from retroassembly)
export const STATUS = Object.freeze({
  deleted: 0,
  normal: 1,
})

const ts = () => integer({ mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
const tsNullable = () => integer({ mode: 'timestamp' })

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').$onUpdateFn(() => new Date()),
})

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('user'),
  status: integer('status').notNull().default(STATUS.normal),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at').$onUpdateFn(() => new Date()),
})

export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  lastActivityAt: ts('last_activity_at').$onUpdateFn(() => new Date()),
  createdAt: ts('created_at'),
}, (t) => [
  index('idx_sessions_user').on(t.userId),
  index('idx_sessions_expires').on(t.expiresAt),
])

export const rooms = sqliteTable('rooms', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(),
  hostUserId: integer('host_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  romId: integer('rom_id').notNull().references(() => roms.id, { onDelete: 'cascade' }),
  romBuildId: integer('rom_build_id').notNull(),
  name: text('name').notNull(),
  isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(true),
  allowPlay: integer('allow_play', { mode: 'boolean' }).notNull().default(true),
  passwordHash: text('password_hash'),
  status: integer('status').notNull().default(STATUS.normal),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at').$onUpdateFn(() => new Date()),
  closedAt: tsNullable('closed_at'),
}, (t) => [
  foreignKey({
    name: 'rooms_build_ownership_fk',
    columns: [t.romBuildId, t.romId],
    foreignColumns: [romBuilds.id, romBuilds.romId],
  }).onDelete('restrict'),
])

export const roms = sqliteTable('roms', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  platform: text('platform').notNull(),
  fileName: text('file_name').notNull(),
  filePath: text('file_path').notNull(),
  fileSize: integer('file_size').notNull(),
  isPublic: integer('is_public', { mode: 'boolean' }).notNull().default(false),
  // Optional parent ROM — for arcade clone/variant sets where the child depends
  // on shared data from the parent (e.g. kof97pls is a split clone of kof97).
  // Children are hidden from the main Gallery list and shown as a version
  // picker on the parent's detail. `null` = this ROM is a top-level game.
  parentRomId: integer('parent_rom_id').references(() => roms.id, { onDelete: 'restrict' }),
  setNameNormalized: text('set_name_normalized').notNull(),
  variantKind: text('variant_kind'),
  datParentSetName: text('dat_parent_set_name'),
  familyRootSetName: text('family_root_set_name'),
  versionLabel: text('version_label'),
  activeBuildId: integer('active_build_id'),
  activeThumbnailRefId: integer('active_thumbnail_ref_id'),
  status: integer('status').notNull().default(STATUS.normal),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at').$onUpdateFn(() => new Date()),
}, (t) => [
  uniqueIndex('roms_owner_platform_set_unique').on(
    t.userId,
    t.platform,
    t.setNameNormalized,
  ),
  index('idx_roms_parent').on(t.parentRomId),
  index('idx_roms_active_build').on(t.activeBuildId),
  index('idx_roms_active_thumbnail').on(t.activeThumbnailRefId),
  foreignKey({
    name: 'roms_active_build_ownership_fk',
    columns: [t.activeBuildId, t.id],
    foreignColumns: [romBuilds.id, romBuilds.romId],
  }).onDelete('restrict'),
  foreignKey({
    name: 'roms_active_thumbnail_ownership_fk',
    columns: [t.activeThumbnailRefId, t.id],
    foreignColumns: [romAssetRefs.id, romAssetRefs.romId],
  }).onDelete('restrict'),
  check(
    'roms_set_name_normalized_check',
    sql`length(${t.setNameNormalized}) > 0 AND ${t.setNameNormalized} COLLATE BINARY = lower(${t.setNameNormalized})`,
  ),
  check(
    'roms_variant_kind_check',
    sql`${t.variantKind} IS NULL OR ${t.variantKind} IN ('official', 'hack', 'bootleg')`,
  ),
])

export const favorites = sqliteTable('favorites', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  romId: integer('rom_id').notNull().references(() => roms.id, { onDelete: 'cascade' }),
  createdAt: ts('created_at'),
}, (t) => [
  primaryKey({ columns: [t.userId, t.romId] }),
  index('idx_favorites_user').on(t.userId),
  index('idx_favorites_rom').on(t.romId),
])

export const saveStates = sqliteTable('save_states', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  romId: integer('rom_id').notNull().references(() => roms.id, { onDelete: 'cascade' }),
  romBuildId: integer('rom_build_id').notNull(),
  buildFingerprint: text('build_fingerprint').notNull(),
  coreArtifactFingerprint: text('core_artifact_fingerprint').notNull(),
  contentManifestSha256: text('content_manifest_sha256').notNull(),
  slot: integer('slot').notNull().default(0),
  filePath: text('file_path').notNull(),
  fileSize: integer('file_size').notNull(),
  status: integer('status').notNull().default(STATUS.normal),
  updatedAt: ts('updated_at').$onUpdateFn(() => new Date()),
}, (t) => [
  foreignKey({
    name: 'save_states_build_ownership_fk',
    columns: [t.romBuildId, t.romId],
    foreignColumns: [romBuilds.id, romBuilds.romId],
  }).onDelete('restrict'),
])

export const assets = sqliteTable('assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind').notNull(),
  filePath: text('file_path').notNull(),
  mimeType: text('mime_type'),
  fileSize: integer('file_size').notNull(),
  sha256: text('sha256').notNull(),
  createdAt: ts('created_at'),
}, (t) => [
  uniqueIndex('assets_sha256_unique').on(t.sha256),
  uniqueIndex('assets_file_path_unique').on(t.filePath),
  index('idx_assets_kind').on(t.kind),
  check('assets_file_size_nonnegative', sql`${t.fileSize} >= 0`),
  check(
    'assets_sha256_format',
    sql`length(${t.sha256}) = 64 AND ${t.sha256} NOT GLOB '*[^0-9a-f]*'`,
  ),
])

export const coreArtifacts = sqliteTable('core_artifacts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  coreName: text('core_name').notNull(),
  displayVersion: text('display_version').notNull(),
  sourceCommit: text('source_commit'),
  jsAssetId: integer('js_asset_id').notNull().references(() => assets.id, { onDelete: 'restrict' }),
  jsSha256: text('js_sha256').notNull(),
  wasmAssetId: integer('wasm_asset_id').notNull().references(() => assets.id, { onDelete: 'restrict' }),
  wasmSha256: text('wasm_sha256').notNull(),
  datAssetId: integer('dat_asset_id').references(() => assets.id, { onDelete: 'restrict' }),
  datSha256: text('dat_sha256'),
  biosAssetId: integer('bios_asset_id').references(() => assets.id, { onDelete: 'restrict' }),
  biosManifestSha256: text('bios_manifest_sha256'),
  artifactFingerprint: text('artifact_fingerprint').notNull(),
  provenanceJson: text('provenance_json'),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).notNull().default(false),
  createdAt: ts('created_at'),
}, (t) => [
  uniqueIndex('core_artifacts_fingerprint_unique').on(t.artifactFingerprint),
  index('idx_core_artifacts_name').on(t.coreName),
])

export const importBatches = sqliteTable('import_batches', {
  id: text('id').primaryKey(),
  ownerUserId: integer('owner_user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  coldSourceSha256: text('cold_source_sha256').notNull(),
  manifestSha256: text('manifest_sha256').notNull(),
  plannedCount: integer('planned_count').notNull().default(0),
  actualCount: integer('actual_count').notNull().default(0),
  totalBytes: integer('total_bytes').notNull().default(0),
  status: text('status').notNull().default('staged'),
  createdAt: ts('created_at'),
  updatedAt: ts('updated_at').$onUpdateFn(() => new Date()),
  publishedAt: tsNullable('published_at'),
  rolledBackAt: tsNullable('rolled_back_at'),
}, (t) => [
  index('idx_import_batches_owner').on(t.ownerUserId),
  index('idx_import_batches_status').on(t.status),
  check(
    'import_batches_status_check',
    sql`${t.status} IN ('staged', 'validating', 'committed_private', 'publishing', 'published', 'rolling_back', 'rolled_back', 'rollback_failed', 'failed')`,
  ),
  check(
    'import_batches_counts_nonnegative',
    sql`${t.plannedCount} >= 0 AND ${t.actualCount} >= 0 AND ${t.totalBytes} >= 0`,
  ),
])

export const romBuilds = sqliteTable('rom_builds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  romId: integer('rom_id').notNull().references(() => roms.id, { onDelete: 'restrict' }),
  coreArtifactId: integer('core_artifact_id').notNull().references(() => coreArtifacts.id, { onDelete: 'restrict' }),
  archiveAssetId: integer('archive_asset_id').references(() => assets.id, { onDelete: 'restrict' }),
  archiveSha256: text('archive_sha256'),
  contentManifestSha256: text('content_manifest_sha256').notNull(),
  buildFingerprint: text('build_fingerprint').notNull(),
  staticStatus: text('static_status').notNull(),
  staticFailureCode: text('static_failure_code'),
  staticFailureDetailsJson: text('static_failure_details_json'),
  archiveLayout: text('archive_layout').notNull(),
  runtimeParentBuildId: integer('runtime_parent_build_id').references(() => romBuilds.id, { onDelete: 'restrict' }),
  createdAt: ts('created_at'),
}, (t) => [
  uniqueIndex('rom_builds_fingerprint_unique').on(t.buildFingerprint),
  uniqueIndex('rom_builds_id_rom_unique').on(t.id, t.romId),
  index('idx_rom_builds_rom').on(t.romId),
  index('idx_rom_builds_core').on(t.coreArtifactId),
  index('idx_rom_builds_parent').on(t.runtimeParentBuildId),
  check(
    'rom_builds_static_status_check',
    sql`${t.staticStatus} IN ('complete', 'blocked', 'unsupported')`,
  ),
  check(
    'rom_builds_archive_layout_check',
    sql`(${t.archiveLayout} = 'standalone' AND ${t.runtimeParentBuildId} IS NULL) OR (${t.archiveLayout} = 'split' AND ${t.runtimeParentBuildId} IS NOT NULL)`,
  ),
  check(
    'rom_builds_complete_archive_check',
    sql`${t.staticStatus} <> 'complete' OR (${t.archiveAssetId} IS NOT NULL AND ${t.archiveSha256} IS NOT NULL)`,
  ),
])

export const buildValidationRuns = sqliteTable('build_validation_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  romBuildId: integer('rom_build_id').notNull().references(() => romBuilds.id, { onDelete: 'restrict' }),
  browserSha256: text('browser_sha256').notNull(),
  harnessVersion: text('harness_version').notNull(),
  coreArtifactFingerprint: text('core_artifact_fingerprint').notNull(),
  biosManifestSha256: text('bios_manifest_sha256'),
  result: text('result').notNull(),
  failureCode: text('failure_code'),
  logAssetId: integer('log_asset_id').references(() => assets.id, { onDelete: 'restrict' }),
  frameAssetId: integer('frame_asset_id').references(() => assets.id, { onDelete: 'restrict' }),
  acceptance: text('acceptance').notNull().default('pending'),
  acceptedAt: tsNullable('accepted_at'),
  acceptedBy: integer('accepted_by').references(() => users.id, { onDelete: 'set null' }),
  policyVersion: text('policy_version'),
  createdAt: ts('created_at'),
}, (t) => [
  index('idx_build_validation_runs_build').on(t.romBuildId),
  uniqueIndex('build_validation_runs_one_accepted_per_build')
    .on(t.romBuildId)
    .where(sql`${t.acceptance} = 'accepted'`),
  check(
    'build_validation_runs_result_check',
    sql`${t.result} IN ('passed', 'failed', 'inconclusive')`,
  ),
  check(
    'build_validation_runs_acceptance_check',
    sql`${t.acceptance} IN ('pending', 'accepted', 'rejected')`,
  ),
  check(
    'build_validation_runs_inconclusive_not_accepted',
    sql`NOT (${t.result} = 'inconclusive' AND ${t.acceptance} = 'accepted')`,
  ),
  check(
    'build_validation_runs_acceptance_metadata',
    sql`${t.acceptance} <> 'accepted' OR (${t.acceptedAt} IS NOT NULL AND ${t.policyVersion} IS NOT NULL)`,
  ),
])

export const batchBuildRefs = sqliteTable('batch_build_refs', {
  importBatchId: text('import_batch_id').notNull().references(() => importBatches.id, { onDelete: 'restrict' }),
  romBuildId: integer('rom_build_id').notNull().references(() => romBuilds.id, { onDelete: 'restrict' }),
  createdAt: ts('created_at'),
}, (t) => [
  primaryKey({ columns: [t.importBatchId, t.romBuildId] }),
  index('idx_batch_build_refs_build').on(t.romBuildId),
])

export const buildSourceMembers = sqliteTable('build_source_members', {
  importBatchId: text('import_batch_id').notNull().references(() => importBatches.id, { onDelete: 'restrict' }),
  romBuildId: integer('rom_build_id').notNull().references(() => romBuilds.id, { onDelete: 'restrict' }),
  sourceArchivePath: text('source_archive_path').notNull(),
  memberName: text('member_name').notNull(),
  memberRole: text('member_role').notNull(),
  memberOrder: integer('member_order').notNull(),
  memberSize: integer('member_size').notNull(),
  crc32: text('crc32').notNull(),
  sha256: text('sha256').notNull(),
  createdAt: ts('created_at'),
}, (t) => [
  primaryKey({
    columns: [t.importBatchId, t.romBuildId, t.sourceArchivePath, t.memberName],
  }),
  index('idx_build_source_members_build').on(t.romBuildId),
  check(
    'build_source_members_values_nonnegative',
    sql`${t.memberOrder} >= 0 AND ${t.memberSize} >= 0`,
  ),
])

export const romAssetRefs = sqliteTable('rom_asset_refs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  romId: integer('rom_id').notNull().references(() => roms.id, { onDelete: 'restrict' }),
  assetId: integer('asset_id').notNull().references(() => assets.id, { onDelete: 'restrict' }),
  matchKind: text('match_kind').notNull(),
  sourceSetName: text('source_set_name'),
  sourceFileSha256: text('source_file_sha256'),
  importBatchId: text('import_batch_id').references(() => importBatches.id, { onDelete: 'restrict' }),
  createdAt: ts('created_at'),
}, (t) => [
  uniqueIndex('rom_asset_refs_id_rom_unique').on(t.id, t.romId),
  index('idx_rom_asset_refs_rom').on(t.romId),
  index('idx_rom_asset_refs_asset').on(t.assetId),
  check(
    'rom_asset_refs_match_kind_check',
    sql`${t.matchKind} IN ('exact', 'alias', 'parent', 'source_reference', 'placeholder')`,
  ),
])

export const importOperations = sqliteTable('import_operations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  importBatchId: text('import_batch_id').notNull().references(() => importBatches.id, { onDelete: 'restrict' }),
  sequence: integer('sequence').notNull(),
  operationKind: text('operation_kind').notNull(),
  entityType: text('entity_type').notNull(),
  entityKey: text('entity_key').notNull(),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  revertedAt: tsNullable('reverted_at'),
  createdAt: ts('created_at'),
}, (t) => [
  uniqueIndex('import_operations_batch_sequence_unique').on(t.importBatchId, t.sequence),
  index('idx_import_operations_batch').on(t.importBatchId),
])

export const libraryMigrationState = sqliteTable('library_migration_state', {
  id: integer('id').primaryKey().default(1),
  phase: text('phase').notNull(),
  updatedAt: ts('updated_at').$onUpdateFn(() => new Date()),
}, (t) => [
  check('library_migration_state_singleton', sql`${t.id} = 1`),
  check(
    'library_migration_state_phase_check',
    sql`${t.phase} IN ('expanded', 'backfilled', 'contracted')`,
  ),
])
