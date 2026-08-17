# Isolated Arcade Smoke Harness

This directory contains the offline validation contract for immutable arcade
builds. It uses the Playwright-bundled Headless Shell revision `1208` and
verifies the executable SHA-256 before launching it. It never launches system
Chrome/Edge, starts a local HTTP ROM server, enables service workers, or allows
an unapproved network request.

All generated profiles, result JSON, screenshots, and failure evidence belong
outside the Git worktree. The staged-file guard rejects the conventional
`tools/arcade-smoke/{profiles,results,evidence,screenshots,downloads}` paths.

## 1 KiB canary

Run the canary before any ROM validation:

```powershell
$out = 'E:\arcade-evidence\smoke\canary'
node tools/arcade-smoke/run-smoke.mjs --output-root $out
```

The canary is a 1024-byte HTML document with no ROM, core, BIOS, or external
URL. A passing result must contain empty `downloads`, `downloadFiles`, and
`listenerPortsOpened` arrays. Each attempt is written with exclusive create
(`wx`), so an existing result is never replaced.

## Runtime case manifest

`run-smoke.mjs` accepts a JSON manifest through `--case-manifest`. The manifest
is an array or `{ "cases": [] }` object. A real case should be produced from
an accepted build and contain local, already-hashed bytes:

```json
{
  "caseId": "fbneo-kof97",
  "candidateId": "fbneo:kof97",
  "logicalRomKey": "w165:fbneo:kof97",
  "buildFingerprint": "<64 hex chars>",
  "coreArtifactFingerprint": "<64 hex chars>",
  "runtime": {
    "coreName": "fbneo",
    "coreJs": { "filePath": "E:/evidence/core.js" },
    "coreWasm": { "filePath": "E:/evidence/core.wasm" },
    "archives": [
      { "fileName": "kof97.zip", "role": "primary", "filePath": "E:/evidence/kof97.zip" }
    ],
    "bios": [
      { "fileName": "neogeo.zip", "filePath": "E:/evidence/neogeo.zip" }
    ]
  }
}
```

`buildRuntimeCase()` converts this description into a virtual-origin HTML
page. Split builds list the parent archive before the primary archive. The
route policy then serves only those explicit paths and aborts every other
request. Runtime cases must provide authoritative build and core identities;
local asset hash mismatches are rejected. `requireCanvas` is enabled for
runtime cases and the harness rejects blank frames or a RetroArch status that
is not active content. Evidence paths are relative to the output root and
point to the actual persistent profile directory.

Retries are append-only. The default is two attempts for `timeout` and
`runtime-error` or a temporarily unavailable content status; isolation
violations, content mismatches, blank frames, and download creation are never
retried. Increase the bound explicitly with `--max-attempts N` only when the
evidence policy permits it.

## Publish derivation

After all raw result files are retained, derive a separate publish view. This
does not modify the 656-row candidate ledger:

```powershell
node tools/arcade-smoke/derive-publish-manifest.mjs `
  --candidate-manifest E:\arcade-evidence\w165\manifest.json `
  --validation-runs E:\arcade-evidence\smoke\runs.json `
  --output E:\arcade-evidence\w165\publish-manifest.json
```

Only an accepted `passed` run can select a build. The production CLI requires
the frozen 656-row W165 ledger and a validation attempt for every buildable
candidate. Accepted runs must match the candidate runtime/content contracts,
archive layout and hash, parent archive, and computed core/build fingerprints.
Conflicting accepted build fingerprints for one logical ROM are rejected
instead of silently replacing a release. The raw attempts remain private
evidence.

## Production legacy capture

The capture tool is a read-only plan by default. It describes an online SQLite
backup followed by explicit `scp -O -J` copies; it does not recursively copy a
data root and it never overwrites an existing evidence file. Review the plan,
then use an explicit apply mode from an operator-controlled shell:

```powershell
node tools/arcade-smoke/capture-production-legacy.mjs `
  --host 160.236.110.53 --port 59222 --user root `
  --jump-host 43.159.2.240 --jump-port 59222 --jump-user root `
  --remote-db /srv/childhood-arcade/shared/data/app.db `
  --remote-data-root /srv/childhood-arcade/shared/data `
  --output-root E:\arcade-evidence\production-capture
```

Pass exact `remoteFiles` and `expectedFiles` entries in a request object when
staging ROM/core/BIOS bytes. Every transferred file must have a size and
SHA-256 and is checked before it can be used in a case manifest. Remote paths
are literal files only: globbing, whitespace, traversal, and shell
metacharacters are rejected. Apply mode removes the temporary remote SQLite
snapshot in a cleanup step. This tool is intentionally separate from
deployment and does not change Nginx, systemd, GitHub, or the production
database.
