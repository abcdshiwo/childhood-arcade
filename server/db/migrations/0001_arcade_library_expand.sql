CREATE TABLE `assets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`file_path` text NOT NULL,
	`mime_type` text,
	`file_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "assets_file_size_nonnegative" CHECK("assets"."file_size" >= 0),
	CONSTRAINT "assets_sha256_format" CHECK(length("assets"."sha256") = 64 AND "assets"."sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assets_sha256_unique` ON `assets` (`sha256`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_file_path_unique` ON `assets` (`file_path`);--> statement-breakpoint
CREATE INDEX `idx_assets_kind` ON `assets` (`kind`);--> statement-breakpoint
CREATE TABLE `batch_build_refs` (
	`import_batch_id` text NOT NULL,
	`rom_build_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`import_batch_id`, `rom_build_id`),
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`rom_build_id`) REFERENCES `rom_builds`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `idx_batch_build_refs_build` ON `batch_build_refs` (`rom_build_id`);--> statement-breakpoint
CREATE TABLE `build_source_members` (
	`import_batch_id` text NOT NULL,
	`rom_build_id` integer NOT NULL,
	`source_archive_path` text NOT NULL,
	`member_name` text NOT NULL,
	`member_role` text NOT NULL,
	`member_order` integer NOT NULL,
	`member_size` integer NOT NULL,
	`crc32` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`import_batch_id`, `rom_build_id`, `source_archive_path`, `member_name`),
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`rom_build_id`) REFERENCES `rom_builds`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "build_source_members_values_nonnegative" CHECK("build_source_members"."member_order" >= 0 AND "build_source_members"."member_size" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_build_source_members_build` ON `build_source_members` (`rom_build_id`);--> statement-breakpoint
CREATE TABLE `build_validation_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rom_build_id` integer NOT NULL,
	`browser_sha256` text NOT NULL,
	`harness_version` text NOT NULL,
	`core_artifact_fingerprint` text NOT NULL,
	`bios_manifest_sha256` text,
	`result` text NOT NULL,
	`failure_code` text,
	`log_asset_id` integer,
	`frame_asset_id` integer,
	`acceptance` text DEFAULT 'pending' NOT NULL,
	`accepted_at` integer,
	`accepted_by` integer,
	`policy_version` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`rom_build_id`) REFERENCES `rom_builds`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`log_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`frame_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`accepted_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "build_validation_runs_result_check" CHECK("build_validation_runs"."result" IN ('passed', 'failed', 'inconclusive')),
	CONSTRAINT "build_validation_runs_acceptance_check" CHECK("build_validation_runs"."acceptance" IN ('pending', 'accepted', 'rejected')),
	CONSTRAINT "build_validation_runs_inconclusive_not_accepted" CHECK(NOT ("build_validation_runs"."result" = 'inconclusive' AND "build_validation_runs"."acceptance" = 'accepted')),
	CONSTRAINT "build_validation_runs_acceptance_metadata" CHECK("build_validation_runs"."acceptance" <> 'accepted' OR ("build_validation_runs"."accepted_at" IS NOT NULL AND "build_validation_runs"."policy_version" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `idx_build_validation_runs_build` ON `build_validation_runs` (`rom_build_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `build_validation_runs_one_accepted_per_build` ON `build_validation_runs` (`rom_build_id`) WHERE "build_validation_runs"."acceptance" = 'accepted';--> statement-breakpoint
CREATE TABLE `core_artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`core_name` text NOT NULL,
	`display_version` text NOT NULL,
	`source_commit` text,
	`js_asset_id` integer NOT NULL,
	`js_sha256` text NOT NULL,
	`wasm_asset_id` integer NOT NULL,
	`wasm_sha256` text NOT NULL,
	`dat_asset_id` integer,
	`dat_sha256` text,
	`bios_asset_id` integer,
	`bios_manifest_sha256` text,
	`artifact_fingerprint` text NOT NULL,
	`provenance_json` text,
	`is_enabled` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`js_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`wasm_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`dat_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`bios_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `core_artifacts_fingerprint_unique` ON `core_artifacts` (`artifact_fingerprint`);--> statement-breakpoint
CREATE INDEX `idx_core_artifacts_name` ON `core_artifacts` (`core_name`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` integer NOT NULL,
	`cold_source_sha256` text NOT NULL,
	`manifest_sha256` text NOT NULL,
	`planned_count` integer DEFAULT 0 NOT NULL,
	`actual_count` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`published_at` integer,
	`rolled_back_at` integer,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "import_batches_status_check" CHECK("import_batches"."status" IN ('staged', 'validating', 'committed_private', 'publishing', 'published', 'rolling_back', 'rolled_back', 'rollback_failed', 'failed')),
	CONSTRAINT "import_batches_counts_nonnegative" CHECK("import_batches"."planned_count" >= 0 AND "import_batches"."actual_count" >= 0 AND "import_batches"."total_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_import_batches_owner` ON `import_batches` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `idx_import_batches_status` ON `import_batches` (`status`);--> statement-breakpoint
CREATE TABLE `import_operations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`import_batch_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`operation_kind` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_key` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`reverted_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_operations_batch_sequence_unique` ON `import_operations` (`import_batch_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_import_operations_batch` ON `import_operations` (`import_batch_id`);--> statement-breakpoint
CREATE TABLE `library_migration_state` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`phase` text NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	CONSTRAINT "library_migration_state_singleton" CHECK("library_migration_state"."id" = 1),
	CONSTRAINT "library_migration_state_phase_check" CHECK("library_migration_state"."phase" IN ('expanded', 'backfilled', 'contracted'))
);
--> statement-breakpoint
CREATE TABLE `rom_asset_refs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rom_id` integer NOT NULL,
	`asset_id` integer NOT NULL,
	`match_kind` text NOT NULL,
	`source_set_name` text,
	`source_file_sha256` text,
	`import_batch_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`rom_id`) REFERENCES `roms`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "rom_asset_refs_match_kind_check" CHECK("rom_asset_refs"."match_kind" IN ('exact', 'alias', 'parent', 'source_reference', 'placeholder'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rom_asset_refs_id_rom_unique` ON `rom_asset_refs` (`id`,`rom_id`);--> statement-breakpoint
CREATE INDEX `idx_rom_asset_refs_rom` ON `rom_asset_refs` (`rom_id`);--> statement-breakpoint
CREATE INDEX `idx_rom_asset_refs_asset` ON `rom_asset_refs` (`asset_id`);--> statement-breakpoint
CREATE TABLE `rom_builds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rom_id` integer NOT NULL,
	`core_artifact_id` integer NOT NULL,
	`archive_asset_id` integer,
	`archive_sha256` text,
	`content_manifest_sha256` text NOT NULL,
	`build_fingerprint` text NOT NULL,
	`static_status` text NOT NULL,
	`static_failure_code` text,
	`static_failure_details_json` text,
	`archive_layout` text NOT NULL,
	`runtime_parent_build_id` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`rom_id`) REFERENCES `roms`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`core_artifact_id`) REFERENCES `core_artifacts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`archive_asset_id`) REFERENCES `assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`runtime_parent_build_id`) REFERENCES `rom_builds`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "rom_builds_static_status_check" CHECK("rom_builds"."static_status" IN ('complete', 'blocked', 'unsupported')),
	CONSTRAINT "rom_builds_archive_layout_check" CHECK(("rom_builds"."archive_layout" = 'standalone' AND "rom_builds"."runtime_parent_build_id" IS NULL) OR ("rom_builds"."archive_layout" = 'split' AND "rom_builds"."runtime_parent_build_id" IS NOT NULL)),
	CONSTRAINT "rom_builds_complete_archive_check" CHECK("rom_builds"."static_status" <> 'complete' OR ("rom_builds"."archive_asset_id" IS NOT NULL AND "rom_builds"."archive_sha256" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rom_builds_fingerprint_unique` ON `rom_builds` (`build_fingerprint`);--> statement-breakpoint
CREATE UNIQUE INDEX `rom_builds_id_rom_unique` ON `rom_builds` (`id`,`rom_id`);--> statement-breakpoint
CREATE INDEX `idx_rom_builds_rom` ON `rom_builds` (`rom_id`);--> statement-breakpoint
CREATE INDEX `idx_rom_builds_core` ON `rom_builds` (`core_artifact_id`);--> statement-breakpoint
CREATE INDEX `idx_rom_builds_parent` ON `rom_builds` (`runtime_parent_build_id`);--> statement-breakpoint
ALTER TABLE `roms` ADD `set_name_normalized` text;--> statement-breakpoint
ALTER TABLE `roms` ADD `variant_kind` text;--> statement-breakpoint
ALTER TABLE `roms` ADD `dat_parent_set_name` text;--> statement-breakpoint
ALTER TABLE `roms` ADD `family_root_set_name` text;--> statement-breakpoint
ALTER TABLE `roms` ADD `active_build_id` integer;--> statement-breakpoint
ALTER TABLE `roms` ADD `active_thumbnail_ref_id` integer;--> statement-breakpoint
CREATE INDEX `idx_roms_active_build` ON `roms` (`active_build_id`);--> statement-breakpoint
CREATE INDEX `idx_roms_active_thumbnail` ON `roms` (`active_thumbnail_ref_id`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `rom_build_id` integer;--> statement-breakpoint
ALTER TABLE `save_states` ADD `rom_build_id` integer;--> statement-breakpoint
ALTER TABLE `save_states` ADD `build_fingerprint` text;--> statement-breakpoint
ALTER TABLE `save_states` ADD `core_artifact_fingerprint` text;--> statement-breakpoint
ALTER TABLE `save_states` ADD `content_manifest_sha256` text;--> statement-breakpoint
INSERT INTO `library_migration_state` (`id`, `phase`) VALUES (1, 'expanded');--> statement-breakpoint
CREATE TRIGGER `library_migration_state_phase_monotonic`
BEFORE UPDATE OF `phase` ON `library_migration_state`
WHEN NOT (
	NEW.`phase` = OLD.`phase`
	OR (OLD.`phase` = 'expanded' AND NEW.`phase` = 'backfilled')
	OR (OLD.`phase` = 'backfilled' AND NEW.`phase` = 'contracted')
)
BEGIN
	SELECT RAISE(ABORT, 'library migration phase must advance exactly one step');
END;--> statement-breakpoint
CREATE TRIGGER `library_migration_state_no_reinsert`
BEFORE INSERT ON `library_migration_state`
BEGIN
	SELECT RAISE(ABORT, 'library migration state cannot be reinserted');
END;--> statement-breakpoint
CREATE TRIGGER `library_migration_state_no_delete`
BEFORE DELETE ON `library_migration_state`
BEGIN
	SELECT RAISE(ABORT, 'library migration state cannot be deleted');
END;
