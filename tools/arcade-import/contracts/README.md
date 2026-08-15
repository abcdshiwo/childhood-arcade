# Arcade import contracts

This directory is the compact, non-ROM contract ledger for the W165 arcade
import. It is hash-pinned by `SHA256SUMS.txt`; it is not signed. The hash file
anchors the four JSON manifests, and `cores.json` in turn pins every enabled
core artifact, exact DAT or source-derived runtime contract, source commit, and
validation status.

## Frozen invariants

- 656 selected driver rows: 277 FBNeo, 97 MAME2003-Plus, and 282 folded
  FBA2012 rows.
- 227 parent, 361 clone, 4 hack, and 64 bootleg relations.
- 463 direct-or-alias, 53 parent, and 140 source-reference thumbnail matches.
- Five enabled core contracts: FBNeo, MAME2003-Plus, FBA2012 CPS-1,
  FBA2012 CPS-2, and FBA2012 full.
- 655 runtime/core-scoped byte contracts, but 654 global raw payload
  identities.

The last two counts deliberately describe different identities. A
`rawContentContractSha256` is recomputed only from a driver's unique member
payload requirements: sort `(expected_size, expected_crc)` numerically,
serialize each record as `size:crc8lower`, join records with `;`, then hash the
ASCII bytes with SHA-256. No core, source, or DAT value is added to that hash.
Across all 656 rows this produces 654 global raw payload identities because
`sf2rb4`/`sf2m4` cross the FBNeo/MAME boundary with the same payload and
`ddtoda`/`ddtodar1` share one FBA payload.

A `runtimeContractFingerprint` is SHA-256 over the UTF-8 canonical JSON object
whose keys, in order, are `runtimeContractCoreId`, `contractSourceIds`, and
`rawContentContractSha256`. This keeps the audit and runtime compatibility
scope explicit: the cross-core pair remains distinct while the two FBA aliases
fold together, producing 655 runtime/core-scoped byte contracts without
altering the raw payload hash.

`contractSourceIds` is only the platform-family scope used by that fingerprint;
it is not evidence that every listed DAT contains the row. Exact selected-row
core/DAT/source provenance is the `coreArtifactId` join to `cores.json.contract`.
The machine-readable `fbaFullOnlyCoreAllocation` block records the eight rows
whose authoritative `supporting_cores` evidence contains only
`fbalpha2012_full_029`, so they cannot be mistaken for dedicated-core rows.

## Manifest roles

- `sources.json` pins the authoritative audit outputs and aggregate totals.
- `cores.json` pins artifact hashes, source commits, exact DAT or deterministic
  source-contract hashes, and whether runtime validation has occurred.
- `candidates.json` freezes every selected row, member contract, parent/archive
  dependency, normalized relation, alias/source evidence, and thumbnail match.
- `alias-folds.json` records the 22 byte-identical FBA-to-baseline aliases that
  were removed before selecting the 282 FBA rows.

The three FBA2012 core pairs are contract-enabled but remain
`static-unverified`; contract enablement does not claim browser runtime
acceptance. FBNeo and MAME rows likewise retain the validation status declared
in `cores.json`.

ROMs, saves, screenshots, generated images, rebuilt archives, batch output,
and validation evidence are intentionally absent. Import generation and all
working files must stay outside the worktree. The staged-file guard and
path-level ignores enforce that boundary while allowing only the six audited
FBA2012 JS/WASM artifacts and this compact metadata.
