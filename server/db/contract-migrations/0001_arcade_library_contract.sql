-- Destructive arcade-library contract migration.
-- This file is executed only by server/db/contract-runner.js after a verified
-- online backup, phase/ref checks, PRAGMA foreign_keys=OFF, and BEGIN IMMEDIATE.

CREATE TABLE `__contract_new_roms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`title` text NOT NULL,
	`platform` text NOT NULL,
	`file_name` text NOT NULL,
	`file_path` text NOT NULL,
	`file_size` integer NOT NULL,
	`is_public` integer DEFAULT false NOT NULL,
	`parent_rom_id` integer,
	`set_name_normalized` text COLLATE NOCASE NOT NULL,
	`variant_kind` text,
	`dat_parent_set_name` text COLLATE NOCASE,
	`family_root_set_name` text COLLATE NOCASE,
	`version_label` text,
	`active_build_id` integer,
	`active_thumbnail_ref_id` integer,
	`status` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_rom_id`) REFERENCES `roms`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`active_build_id`, `id`) REFERENCES `rom_builds`(`id`, `rom_id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`active_thumbnail_ref_id`, `id`) REFERENCES `rom_asset_refs`(`id`, `rom_id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `roms_set_name_normalized_check` CHECK(length(`set_name_normalized`) > 0 AND `set_name_normalized` COLLATE BINARY = lower(`set_name_normalized`)),
	CONSTRAINT `roms_variant_kind_check` CHECK(`variant_kind` IS NULL OR `variant_kind` IN ('official', 'hack', 'bootleg'))
);

CREATE TABLE `__contract_new_favorites` (
	`user_id` integer NOT NULL,
	`rom_id` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY (`user_id`, `rom_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rom_id`) REFERENCES `roms`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `__contract_new_rooms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`code` text NOT NULL,
	`host_user_id` integer NOT NULL,
	`rom_id` integer NOT NULL,
	`rom_build_id` integer NOT NULL,
	`name` text NOT NULL,
	`is_public` integer DEFAULT true NOT NULL,
	`allow_play` integer DEFAULT true NOT NULL,
	`password_hash` text,
	`status` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`host_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rom_id`) REFERENCES `roms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rom_build_id`, `rom_id`) REFERENCES `rom_builds`(`id`, `rom_id`) ON UPDATE no action ON DELETE restrict
);

CREATE TABLE `__contract_new_save_states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`rom_id` integer NOT NULL,
	`rom_build_id` integer NOT NULL,
	`build_fingerprint` text NOT NULL,
	`core_artifact_fingerprint` text NOT NULL,
	`content_manifest_sha256` text NOT NULL,
	`slot` integer DEFAULT 0 NOT NULL,
	`file_path` text NOT NULL,
	`file_size` integer NOT NULL,
	`status` integer DEFAULT 1 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rom_id`) REFERENCES `roms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rom_build_id`, `rom_id`) REFERENCES `rom_builds`(`id`, `rom_id`) ON UPDATE no action ON DELETE restrict
);

INSERT INTO `__contract_new_roms` (
	`id`, `user_id`, `title`, `platform`, `file_name`, `file_path`,
	`file_size`, `is_public`, `parent_rom_id`, `set_name_normalized`,
	`variant_kind`, `dat_parent_set_name`, `family_root_set_name`,
	`version_label`, `active_build_id`, `active_thumbnail_ref_id`,
	`status`, `created_at`, `updated_at`
)
SELECT
	`id`, `user_id`, `title`, `platform`, `file_name`, `file_path`,
	`file_size`, `is_public`, `parent_rom_id`, `set_name_normalized`,
	`variant_kind`, `dat_parent_set_name`, `family_root_set_name`,
	`version_label`, `active_build_id`, `active_thumbnail_ref_id`,
	`status`, `created_at`, `updated_at`
FROM `roms`;

INSERT INTO `__contract_new_favorites` (`user_id`, `rom_id`, `created_at`)
SELECT `user_id`, `rom_id`, `created_at` FROM `favorites`;

INSERT INTO `__contract_new_rooms` (
	`id`, `code`, `host_user_id`, `rom_id`, `rom_build_id`, `name`,
	`is_public`, `allow_play`, `password_hash`, `status`, `created_at`,
	`updated_at`, `closed_at`
)
SELECT
	`id`, `code`, `host_user_id`, `rom_id`, `rom_build_id`, `name`,
	`is_public`, `allow_play`, `password_hash`, `status`, `created_at`,
	`updated_at`, `closed_at`
FROM `rooms`;

INSERT INTO `__contract_new_save_states` (
	`id`, `user_id`, `rom_id`, `rom_build_id`, `build_fingerprint`,
	`core_artifact_fingerprint`, `content_manifest_sha256`, `slot`,
	`file_path`, `file_size`, `status`, `updated_at`
)
SELECT
	`id`, `user_id`, `rom_id`, `rom_build_id`, `build_fingerprint`,
	`core_artifact_fingerprint`, `content_manifest_sha256`, `slot`,
	`file_path`, `file_size`, `status`, `updated_at`
FROM `save_states`;

-- contract-stage: after_copy

DROP TABLE `favorites`;
DROP TABLE `rooms`;
DROP TABLE `save_states`;
DROP TABLE `roms`;

ALTER TABLE `__contract_new_roms` RENAME TO `roms`;
ALTER TABLE `__contract_new_favorites` RENAME TO `favorites`;
ALTER TABLE `__contract_new_rooms` RENAME TO `rooms`;
ALTER TABLE `__contract_new_save_states` RENAME TO `save_states`;

-- contract-stage: after_drop_rename

CREATE UNIQUE INDEX `roms_owner_platform_set_unique`
	ON `roms` (`user_id`, `platform`, `set_name_normalized` COLLATE NOCASE);
CREATE INDEX `idx_roms_parent` ON `roms` (`parent_rom_id`);
CREATE INDEX `idx_roms_active_build` ON `roms` (`active_build_id`);
CREATE INDEX `idx_roms_active_thumbnail` ON `roms` (`active_thumbnail_ref_id`);
CREATE INDEX `idx_favorites_user` ON `favorites` (`user_id`);
CREATE INDEX `idx_favorites_rom` ON `favorites` (`rom_id`);
CREATE UNIQUE INDEX `rooms_code_unique` ON `rooms` (`code`);

CREATE TRIGGER `assets_identity_immutable`
BEFORE UPDATE OF
	`id`, `kind`, `file_path`, `mime_type`, `file_size`, `sha256`, `created_at`
ON `assets`
BEGIN
	SELECT RAISE(ABORT, 'asset identity is immutable');
END;

CREATE TRIGGER `rom_builds_runtime_parent_insert`
BEFORE INSERT ON `rom_builds`
WHEN NOT (
	(NEW.`archive_layout` = 'standalone' AND NEW.`runtime_parent_build_id` IS NULL)
	OR (
		NEW.`archive_layout` = 'split'
		AND NEW.`runtime_parent_build_id` IS NOT NULL
		AND EXISTS (
			SELECT 1
			FROM `rom_builds` AS parent_build
			JOIN `roms` AS child_rom ON child_rom.`id` = NEW.`rom_id`
			JOIN `roms` AS parent_rom ON parent_rom.`id` = parent_build.`rom_id`
			WHERE parent_build.`id` = NEW.`runtime_parent_build_id`
				AND parent_build.`archive_layout` = 'standalone'
				AND parent_build.`runtime_parent_build_id` IS NULL
				AND parent_build.`static_status` = 'complete'
				AND parent_build.`core_artifact_id` = NEW.`core_artifact_id`
				AND child_rom.`dat_parent_set_name` IS NOT NULL
				AND child_rom.`dat_parent_set_name` = parent_rom.`set_name_normalized` COLLATE NOCASE
		)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'runtime parent must be a complete standalone direct parent using the same core artifact');
END;

CREATE TRIGGER `rom_builds_runtime_parent_update`
BEFORE UPDATE OF `rom_id`, `core_artifact_id`, `static_status`, `archive_layout`, `runtime_parent_build_id`
ON `rom_builds`
WHEN NOT (
	(NEW.`archive_layout` = 'standalone' AND NEW.`runtime_parent_build_id` IS NULL)
	OR (
		NEW.`archive_layout` = 'split'
		AND NEW.`runtime_parent_build_id` IS NOT NULL
		AND EXISTS (
			SELECT 1
			FROM `rom_builds` AS parent_build
			JOIN `roms` AS child_rom ON child_rom.`id` = NEW.`rom_id`
			JOIN `roms` AS parent_rom ON parent_rom.`id` = parent_build.`rom_id`
			WHERE parent_build.`id` = NEW.`runtime_parent_build_id`
				AND parent_build.`archive_layout` = 'standalone'
				AND parent_build.`runtime_parent_build_id` IS NULL
				AND parent_build.`static_status` = 'complete'
				AND parent_build.`core_artifact_id` = NEW.`core_artifact_id`
				AND child_rom.`dat_parent_set_name` IS NOT NULL
				AND child_rom.`dat_parent_set_name` = parent_rom.`set_name_normalized` COLLATE NOCASE
		)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'runtime parent must remain a complete standalone direct parent using the same core artifact');
END;

CREATE TRIGGER `rom_builds_identity_immutable`
BEFORE UPDATE OF
	`rom_id`, `core_artifact_id`, `archive_asset_id`, `archive_sha256`,
	`content_manifest_sha256`, `build_fingerprint`, `static_status`,
	`static_failure_code`, `static_failure_details_json`, `archive_layout`,
	`runtime_parent_build_id`, `created_at`
ON `rom_builds`
BEGIN
	SELECT RAISE(ABORT, 'rom build identity is immutable');
END;

CREATE TRIGGER `core_artifacts_identity_immutable`
BEFORE UPDATE OF
	`core_name`, `display_version`, `source_commit`, `js_asset_id`, `js_sha256`,
	`wasm_asset_id`, `wasm_sha256`, `dat_asset_id`, `dat_sha256`,
	`bios_asset_id`, `bios_manifest_sha256`, `artifact_fingerprint`,
	`provenance_json`, `created_at`
ON `core_artifacts`
BEGIN
	SELECT RAISE(ABORT, 'core artifact identity is immutable');
END;

CREATE TRIGGER `rom_asset_refs_identity_immutable`
BEFORE UPDATE OF
	`rom_id`, `asset_id`, `match_kind`, `source_set_name`,
	`source_file_sha256`, `import_batch_id`, `created_at`
ON `rom_asset_refs`
BEGIN
	SELECT RAISE(ABORT, 'ROM asset reference identity is immutable');
END;

CREATE TRIGGER `roms_contract_identity_immutable`
BEFORE UPDATE OF
	`user_id`, `platform`, `parent_rom_id`, `set_name_normalized`,
	`variant_kind`, `dat_parent_set_name`, `family_root_set_name`
ON `roms`
BEGIN
	SELECT RAISE(ABORT, 'ROM contract identity is immutable');
END;

CREATE TRIGGER `save_states_build_identity_insert`
BEFORE INSERT ON `save_states`
WHEN NOT EXISTS (
	SELECT 1
	FROM `rom_builds` AS build
	JOIN `core_artifacts` AS core ON core.`id` = build.`core_artifact_id`
	WHERE build.`id` = NEW.`rom_build_id`
		AND build.`rom_id` = NEW.`rom_id`
		AND build.`build_fingerprint` = NEW.`build_fingerprint`
		AND build.`content_manifest_sha256` = NEW.`content_manifest_sha256`
		AND core.`artifact_fingerprint` = NEW.`core_artifact_fingerprint`
)
BEGIN
	SELECT RAISE(ABORT, 'save state build identity does not match its immutable build');
END;

CREATE TRIGGER `save_states_build_identity_update`
BEFORE UPDATE OF
	`rom_id`, `rom_build_id`, `build_fingerprint`,
	`core_artifact_fingerprint`, `content_manifest_sha256`
ON `save_states`
WHEN NOT EXISTS (
	SELECT 1
	FROM `rom_builds` AS build
	JOIN `core_artifacts` AS core ON core.`id` = build.`core_artifact_id`
	WHERE build.`id` = NEW.`rom_build_id`
		AND build.`rom_id` = NEW.`rom_id`
		AND build.`build_fingerprint` = NEW.`build_fingerprint`
		AND build.`content_manifest_sha256` = NEW.`content_manifest_sha256`
		AND core.`artifact_fingerprint` = NEW.`core_artifact_fingerprint`
)
BEGIN
	SELECT RAISE(ABORT, 'save state build identity does not match its immutable build');
END;
