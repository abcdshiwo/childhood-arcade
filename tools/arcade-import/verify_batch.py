#!/usr/bin/env python3
"""Read-only verification for a prepared arcade import batch."""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from collections import Counter
from pathlib import Path
from typing import Any

from prepare_batch import (
    assert_production_contract,
    build_save_sample_evidence,
    canonical_json,
    load_contracts,
    render_report,
    require_hash,
    safe_relative,
    safe_zip_member,
    sha256_bytes,
    sha256_file,
    source_inventory,
    thumbnail_match_kind,
)


def resolve_batch_path(batch_root: Path, relative: str) -> Path:
    normalized = safe_relative(relative, "manifest asset path")
    root = batch_root.resolve()
    target = (root / Path(*normalized.split("/"))).resolve()
    if target != root and root not in target.parents:
        raise ValueError(f"manifest asset path escapes batch root: {relative}")
    if target.is_symlink() or not target.is_file():
        raise ValueError(f"manifest asset is missing or not a regular file: {relative}")
    return target


def verify_manifest_hash(manifest: dict[str, Any]) -> str:
    claimed = require_hash(manifest.get("manifestSha256"), "manifestSha256")
    body = dict(manifest)
    del body["manifestSha256"]
    actual = sha256_bytes(canonical_json(body).encode("utf-8"))
    if claimed != actual:
        raise ValueError(f"manifest hash mismatch: expected {claimed}, got {actual}")
    return actual


def verify_archive(batch_root: Path, record: dict[str, Any]) -> None:
    path = resolve_batch_path(batch_root, record["archivePath"])
    digest, size = sha256_file(path)
    if digest != record.get("archiveSha256") or size != record.get("archiveSize"):
        raise ValueError(f"archive content mismatch for {record.get('candidateId')}")
    expected = record.get("members", [])
    with zipfile.ZipFile(path) as archive:
        infos = [info for info in archive.infolist() if not info.is_dir()]
        if archive.comment:
            raise ValueError(f"archive comment is not empty: {record['archivePath']}")
        if [info.filename for info in infos] != [row["name"] for row in expected]:
            raise ValueError(f"archive member order/name mismatch: {record['archivePath']}")
        for info, row in zip(infos, expected, strict=True):
            if info.date_time != (1980, 1, 1, 0, 0, 0):
                raise ValueError(f"archive member timestamp drift: {record['archivePath']}!{info.filename}")
            data = archive.read(info)
            if len(data) != row["size"] or f"{info.CRC:08x}" != row["crc32"] or sha256_bytes(data) != row["sha256"]:
                raise ValueError(f"archive member content mismatch: {record['archivePath']}!{info.filename}")


def verify_source_member_evidence(
    source_root: Path,
    auxiliary_by_path: dict[str, dict[str, Any]],
    record: dict[str, Any],
    source_archives: dict[str, zipfile.ZipFile],
) -> None:
    for member in record.get("members", []):
        source_reference = member.get("sourcePath")
        if not isinstance(source_reference, str) or "!" not in source_reference:
            raise ValueError(f"source member evidence is missing for {record.get('candidateId')}")
        archive_relative, source_member_name = source_reference.split("!", 1)
        archive_relative = safe_relative(archive_relative, "source member archive path")
        source_member_name = safe_zip_member(source_member_name)
        source_evidence = auxiliary_by_path.get(archive_relative)
        if source_evidence is None or source_evidence.get("category") not in ("rom_archive", "bios_archive"):
            raise ValueError(f"source member evidence archive is not retained: {source_reference}")
        archive = source_archives.get(archive_relative)
        if archive is None:
            source_path = source_root / Path(*archive_relative.split("/"))
            archive = zipfile.ZipFile(source_path)
            source_archives[archive_relative] = archive
        try:
            info = archive.getinfo(source_member_name)
        except KeyError as error:
            raise ValueError(f"source member evidence is missing from archive: {source_reference}") from error
        if info.is_dir() or safe_zip_member(info.filename) != source_member_name:
            raise ValueError(f"source member evidence is not a regular ZIP member: {source_reference}")
        data = archive.read(info)
        expected_size = member.get("size")
        expected_crc = str(member.get("crc32") or "").lower().zfill(8)
        expected_sha = require_hash(member.get("sha256"), f"source member SHA-256 for {source_reference}")
        if (
            len(data) != expected_size
            or f"{info.CRC:08x}" != expected_crc
            or sha256_bytes(data) != expected_sha
        ):
            raise ValueError(f"source member evidence content mismatch: {source_reference}")


def expected_output_members(
    contract: dict[str, Any],
    contracts_by_core_set: dict[tuple[Any, Any], dict[str, Any]],
) -> list[list[Any]]:
    members = contract.get("members", [])
    if contract.get("archiveLayout") != "split":
        return members
    parent = contracts_by_core_set.get((contract.get("coreArtifactId"), contract.get("runtimeParentSetName")))
    if parent is None:
        raise ValueError(f"split candidate contract lacks its parent: {contract.get('id')}")
    parent_members = {
        (str(member[0]), int(member[1]), str(member[2]).lower().zfill(8))
        for member in parent.get("members", [])
    }
    return [
        member for member in members
        if (str(member[0]), int(member[1]), str(member[2]).lower().zfill(8)) not in parent_members
    ]


def assert_manifest_contract_binding(
    manifest: dict[str, Any],
    candidates: dict[str, Any],
    cores: dict[str, Any],
    expected_hashes: dict[str, str],
    contracts_dir: Path,
) -> None:
    expected_binding = {
        "sha256sumsSha256": sha256_file(contracts_dir / "SHA256SUMS.txt")[0],
        **{
            name.removesuffix(".json") + "Sha256": digest
            for name, digest in sorted(expected_hashes.items())
        },
    }
    if manifest.get("contracts") != expected_binding:
        raise ValueError("contract hash binding mismatch")
    if canonical_json(manifest.get("cores")) != canonical_json(sorted(cores.get("cores", []), key=lambda row: str(row.get("id")))):
        raise ValueError("core contract ledger mismatch")

    rows = candidates.get("rows", [])
    row_ids = [str(row.get("id")) for row in rows]
    if len(row_ids) != len(set(row_ids)):
        raise ValueError("frozen candidate contract contains duplicate IDs")
    row_by_id = {candidate_id: row for candidate_id, row in zip(row_ids, rows, strict=True)}

    def unique_candidate_index(values: Any, label: str) -> dict[str, dict[str, Any]]:
        if not isinstance(values, list):
            raise ValueError(f"{label} candidate ledger must be an array")
        ids = [str(row.get("candidateId")) for row in values]
        if len(ids) != len(set(ids)):
            raise ValueError(f"{label} candidate ledger contains duplicate IDs")
        return {candidate_id: row for candidate_id, row in zip(ids, values, strict=True)}

    archive_by_id = unique_candidate_index(manifest.get("archives", []), "archive")
    resolution_by_id = unique_candidate_index(manifest.get("candidateResolutions", []), "resolution")
    thumbnail_by_id = unique_candidate_index(manifest.get("thumbnails", []), "thumbnail")
    by_core_set = {(row.get("coreArtifactId"), row.get("setName")): row for row in rows}
    if set(archive_by_id) != set(row_by_id) or set(resolution_by_id) != set(row_by_id) or set(thumbnail_by_id) != set(row_by_id):
        raise ValueError("candidate contract coverage mismatch")

    for candidate_id, contract in row_by_id.items():
        resolution = resolution_by_id[candidate_id]
        for field in ("runtimeContractFingerprint", "rawContentContractSha256"):
            if resolution.get(field) != contract.get(field):
                raise ValueError(f"candidate contract mismatch for {candidate_id} at {field}")

        archive = archive_by_id[candidate_id]
        expected_archive = {
            "coreArtifactId": contract.get("coreArtifactId"),
            "setName": contract.get("setName"),
            "title": contract.get("title"),
            "platform": str(contract.get("platform") or "arcade").lower(),
            "relationKind": contract.get("relationKind"),
            "datParentSetName": contract.get("datParentSetName"),
            "familyRootSetName": contract.get("runtimeParentSetName") or contract.get("datParentSetName") or contract.get("setName"),
            "archiveLayout": contract.get("archiveLayout"),
            "archivePath": f"archives/{contract.get('coreArtifactId')}/{contract.get('setName')}.zip",
        }
        for field, expected in expected_archive.items():
            if archive.get(field) != expected:
                raise ValueError(f"candidate contract mismatch for {candidate_id} at {field}")
        expected_mounts = []
        if contract.get("archiveLayout") == "split":
            parent = by_core_set.get((contract.get("coreArtifactId"), contract.get("runtimeParentSetName")))
            if parent is None:
                raise ValueError(f"split candidate contract lacks its parent: {candidate_id}")
            expected_mounts.append({
                "role": "parent",
                "candidateId": str(parent.get("id")),
                "path": f"archives/{parent.get('coreArtifactId')}/{parent.get('setName')}.zip",
            })
        expected_mounts.append({"role": "primary", "candidateId": candidate_id, "path": expected_archive["archivePath"]})
        if archive.get("mounts") != expected_mounts:
            raise ValueError(f"candidate contract mismatch for {candidate_id} at mounts")
        if resolution.get("state") not in ("blocked", "unsupported"):
            expected_members = [
                (str(member[0]), int(member[1]), str(member[2]).lower().zfill(8))
                for member in expected_output_members(contract, by_core_set)
            ]
            actual_members = [
                (str(member.get("name")), int(member.get("size")), str(member.get("crc32")).lower().zfill(8))
                for member in archive.get("members", [])
            ]
            if actual_members != sorted(expected_members, key=lambda member: member[0]):
                raise ValueError(f"candidate contract mismatch for {candidate_id} at members")

        thumbnail = thumbnail_by_id[candidate_id]
        expected_source_set = str((contract.get("thumbnail") or {}).get("sourceSetName") or contract.get("setName") or "").casefold()
        if thumbnail.get("sourceSetName") != expected_source_set or thumbnail.get("matchKind") != thumbnail_match_kind(contract):
            raise ValueError(f"candidate contract mismatch for {candidate_id} at thumbnail")


def verify_batch(*, manifest_path: Path, contracts_dir: Path, batch_root: Path, cold_source: Path, source_root: Path) -> dict[str, Any]:
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError("manifest must be a regular non-symlink file")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest_sha = verify_manifest_hash(manifest)
    candidates, cores, sources, alias_folds, expected_hashes = load_contracts(contracts_dir)
    production_contract = assert_production_contract(candidates, sources)
    assert_manifest_contract_binding(manifest, candidates, cores, expected_hashes, contracts_dir)
    rows = candidates.get("rows", [])
    candidate_ids = {str(row.get("id")) for row in rows}
    resolutions = manifest.get("candidateResolutions", [])
    resolution_ids = [str(row.get("candidateId")) for row in resolutions]
    if len(resolution_ids) != len(set(resolution_ids)) or set(resolution_ids) != candidate_ids:
        raise ValueError("candidate resolution ledger has missing, duplicate, or extra IDs")
    if any(row.get("state") not in ("ready", "blocked", "unsupported", "unverified") for row in resolutions):
        raise ValueError("candidate resolution contains an invalid final state")

    actual_inventory = source_inventory(source_root)
    if manifest.get("auxiliaryEvidence") != actual_inventory:
        raise ValueError("source inventory differs from the complete extracted source tree")
    inventory_contract = {
        "sha256": sha256_bytes(canonical_json(actual_inventory).encode("utf-8")),
        "fileCount": len(actual_inventory),
        "totalBytes": sum(row["fileSize"] for row in actual_inventory),
    }
    if manifest.get("sourceInventory") != inventory_contract:
        raise ValueError("source inventory contract mismatch")

    auxiliary_by_path: dict[str, dict[str, Any]] = {}
    for row in manifest.get("auxiliaryEvidence", []):
        relative = safe_relative(row.get("path"), "auxiliary evidence path")
        if relative in auxiliary_by_path:
            raise ValueError(f"duplicate auxiliary evidence path: {relative}")
        require_hash(row.get("sha256"), f"auxiliary evidence SHA-256 for {relative}")
        if not isinstance(row.get("fileSize"), int) or row["fileSize"] < 0:
            raise ValueError(f"auxiliary evidence size is invalid for {relative}")
        auxiliary_by_path[relative] = row
    core_rows = {str(row.get("id")): row for row in cores.get("cores", [])}
    expected_save_samples = build_save_sample_evidence(
        source_root,
        actual_inventory,
        rows,
        core_rows,
    )
    if manifest.get("saveSampleEvidence") != expected_save_samples:
        raise ValueError("save sample evidence differs from deterministic archival evidence")

    cold_hash, cold_size = sha256_file(cold_source)
    if manifest.get("coldSource") != {"sha256": cold_hash, "fileSize": cold_size}:
        raise ValueError("cold-source hash or size mismatch")

    archive_ids = [str(row.get("candidateId")) for row in manifest.get("archives", [])]
    if len(archive_ids) != len(set(archive_ids)) or set(archive_ids) != candidate_ids:
        raise ValueError("archive ledger has missing, duplicate, or extra candidates")
    source_archives: dict[str, zipfile.ZipFile] = {}
    try:
        for row in manifest.get("archives", []):
            resolution = next(item for item in resolutions if item["candidateId"] == row["candidateId"])
            if resolution["state"] not in ("blocked", "unsupported"):
                verify_source_member_evidence(source_root, auxiliary_by_path, row, source_archives)
                verify_archive(batch_root, row)
            mounts = row.get("mounts", [])
            if row.get("archiveLayout") == "split":
                if [mount.get("role") for mount in mounts] != ["parent", "primary"]:
                    raise ValueError(f"split mount order must be parent then primary: {row.get('candidateId')}")
            elif [mount.get("role") for mount in mounts] != ["primary"]:
                raise ValueError(f"standalone candidate has an invalid mount plan: {row.get('candidateId')}")
    finally:
        for archive in source_archives.values():
            archive.close()

    thumbnails = manifest.get("thumbnails", [])
    thumbnail_ids = [str(row.get("candidateId")) for row in thumbnails]
    if len(thumbnail_ids) != len(set(thumbnail_ids)) or set(thumbnail_ids) != candidate_ids:
        raise ValueError("thumbnail ledger has missing, duplicate, or extra candidates")

    thumbnail_sources = manifest.get("thumbnailSources", [])
    if not isinstance(thumbnail_sources, list):
        raise ValueError("thumbnail source ledger must be an array")
    source_by_basename: dict[str, dict[str, Any]] = {}
    for row in thumbnail_sources:
        basename = row.get("basename")
        if not isinstance(basename, str) or not basename:
            raise ValueError("thumbnail source basename must be a non-empty string")
        basename_key = basename.casefold()
        if basename_key in source_by_basename:
            raise ValueError(f"duplicate thumbnail source basename: {basename}")
        source_path = safe_relative(row.get("sourcePath"), "thumbnail source path")
        source_sha = require_hash(row.get("sourceFileSha256"), f"thumbnail original source SHA-256 for {basename}")
        source_size = row.get("sourceFileSize")
        evidence = auxiliary_by_path.get(source_path)
        if evidence is None or evidence.get("sha256") != source_sha or evidence.get("fileSize") != source_size:
            raise ValueError(f"thumbnail source evidence mismatch for {basename}")
        digest = require_hash(row.get("sha256"), f"thumbnail source SHA-256 for {basename}")
        expected_asset = f"thumbnails/sha256/{digest[:2]}/{digest}.webp"
        if row.get("assetPath") != expected_asset:
            raise ValueError(f"thumbnail source asset path mismatch for {basename}")
        path = resolve_batch_path(batch_root, expected_asset)
        actual_digest, actual_size = sha256_file(path)
        if actual_digest != digest or actual_size != row.get("fileSize"):
            raise ValueError(f"thumbnail source content mismatch for {basename}")
        source_by_basename[basename_key] = row

    for row in thumbnails:
        source = source_by_basename.get(str(row.get("sourceSetName") or "").casefold())
        if source is None and row.get("sha256") is None:
            continue
        source_fields = (
            "sourcePath", "sourceFileSha256", "sourceFileSize",
            "assetPath", "sha256", "fileSize",
        )
        if source is None or any(row.get(field) != source.get(field) for field in source_fields):
            raise ValueError(f"thumbnail source object mismatch for {row.get('candidateId')}")

    summary = manifest.get("summary", {})
    computed = {
        "candidateRows": len(rows),
        "runtimeCoreScopedContracts": len({row.get("runtimeContractFingerprint") for row in rows}),
        "globalRawPayloadIdentities": len({row.get("rawContentContractSha256") for row in rows}),
        "archiveLayouts": dict(sorted(Counter(str(row.get("archiveLayout")) for row in rows).items())),
        "coreIds": sorted({str(row.get("coreArtifactId")) for row in rows}),
        "thumbnailMatchKinds": dict(sorted(Counter(row.get("matchKind") for row in thumbnails).items())),
        "thumbnailSourceBasenames": len(source_by_basename),
        "thumbnailUniqueObjects": len({row["sha256"] for row in source_by_basename.values()}),
        "sourceFiles": len(actual_inventory),
        "sourceBytes": sum(row["fileSize"] for row in actual_inventory),
        "sourceCategories": dict(sorted(Counter(row["category"] for row in actual_inventory).items())),
        "saveSampleFormats": dict(sorted(Counter(row["format"] for row in expected_save_samples).items())),
        "saveSampleMappings": dict(sorted(Counter(row["mappingState"] for row in expected_save_samples).items())),
    }
    for key, value in computed.items():
        if summary.get(key) != value:
            raise ValueError(f"manifest summary mismatch at {key}")

    for path in batch_root.rglob("*"):
        if path.is_file() and path.suffix.lower() in (".fs", ".nv"):
            raise ValueError(f"runtime NVRAM file is forbidden in batch output: {path}")

    report_path = resolve_batch_path(batch_root, "report.md")
    if report_path.read_text(encoding="utf-8") != render_report(manifest):
        raise ValueError("report.md does not match the verified manifest")

    if production_contract:
        if computed["runtimeCoreScopedContracts"] != 655 or computed["globalRawPayloadIdentities"] != 654:
            raise ValueError("production identity totals must be 656/655/654")
        if computed["archiveLayouts"] != {"split": 98, "standalone": 558}:
            raise ValueError("production archive-layout totals must be split=98 and standalone=558")
        expected_thumbnails = {"alias": 8, "exact": 455, "parent": 53, "source_reference": 140}
        if computed["thumbnailMatchKinds"] != expected_thumbnails:
            raise ValueError("production thumbnail totals must be 455+8+53+140")
        if computed["thumbnailSourceBasenames"] != 493 or computed["thumbnailUniqueObjects"] != 486:
            raise ValueError("production thumbnail source/object totals must be 493/486")
        if len(computed["coreIds"]) != 5:
            raise ValueError("production manifest must cover all five core contracts")
        if computed["sourceCategories"].get("rom_archive") != 241:
            raise ValueError("production source inventory must retain exactly 241 game ROM archives")
        if computed["sourceCategories"].get("save_sample") != 35:
            raise ValueError("production source inventory must retain exactly 35 save samples")
        if computed["saveSampleFormats"] != {"kawaks-srm-rle-v1": 26, "mame2003-plus-raw-eeprom-v1": 9}:
            raise ValueError("production save sample formats must be 26 Kawaks SRAM and 9 MAME EEPROM files")
        if len(expected_save_samples) != 35 or computed["saveSampleMappings"] != {"exact": 34, "unmapped": 1}:
            raise ValueError("production save sample mappings must be 34 exact and kof99nd unmapped")

    return {
        "ok": True,
        "kind": "w165-import-batch-verification-v1",
        "batchId": manifest.get("batchId"),
        "manifestSha256": manifest_sha,
        "candidateRows": len(rows),
        "blocked": sum(row.get("state") == "blocked" for row in resolutions),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--contracts-dir", required=True)
    parser.add_argument("--batch-root", required=True)
    parser.add_argument("--cold-source", required=True)
    parser.add_argument("--source-root", required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    try:
        args = parse_args(argv)
        result = verify_batch(
            manifest_path=Path(args.manifest).resolve(),
            contracts_dir=Path(args.contracts_dir).resolve(),
            batch_root=Path(args.batch_root).resolve(),
            cold_source=Path(args.cold_source).resolve(),
            source_root=Path(args.source_root).resolve(),
        )
        print(canonical_json(result))
        return 0
    except Exception as error:
        print(f"verify_batch: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
