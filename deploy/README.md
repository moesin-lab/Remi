# Platform deployment

For two isolated environments on one development computer, use the
[local stable/dev guide](../docs/deploy/local-profiles.md). It runs separate
API/Web/PostgreSQL projects. A stable profile can opt into the repository-
external host updater; dev never shares that updater or its state.

The API records lifecycle operations. A host-owned `remi-platform-updater`
service executes them through one deployment driver. The API container never
receives the Docker socket and cannot invoke `systemctl`.

The pieces have deliberately narrow responsibilities:

| Piece | Responsibility | Recovery boundary |
|---|---|---|
| platform operation/release API | Persist request, safe cancellation flag, progress, release metadata and updater heartbeat | Survives API restarts in PostgreSQL; it does not execute host commands |
| `remi-platform-updater` | Claim/resume the active operation, coordinate drain and invoke one host driver | Must be supervised outside Remi API and daemon |
| daemon | Acknowledge drain, stop new task claims and durably queue task reports | Never stops or replaces the control plane |
| `systemd_release` | Verify archive, atomically switch source symlink, restart systemd units | Restores code symlink only; use only with backward-compatible DB migrations or an external matching DB restore plan |
| `docker_compose` | Pull immutable image digests and replace owned containers | Restores image/env selection only; it is not a database rollback |
| `local_profile` | Fetch fixed commit, validate source/schema, create verified data/config backup, switch and health-check | Automatic recovery preserves current data and restores application images/configuration; manual disaster recovery can restore a complete snapshot |

`currentRelease`, `latestRelease`, `services` and `updaterStatus` are heartbeat
projections, not release discovery performed by the API. An installation with
no supervised updater (the historical local-profile default), no independent
updater token, or no release feed therefore correctly shows an offline updater,
null releases and an empty service list even while API/Web containers run.

## Usage accounting startup cutover

API startup automatically migrates the required legacy task usage scalars after
the global schema migration lock has been released. Both `api` and `api-runtime`
wait for this gate before starting jobs or opening the HTTP listener, including
`/readyz`. Container updates require no manual migration command. The CLI yields
between batches; embedded `startMultiremiServer` retains its synchronous API and
waits for the same gate.

The default batch size is 500 tasks (maximum 5000), controlled by
`MULTIREMI_USAGE_MIGRATION_BATCH_SIZE`. Each task commits independently. A durable
keyset cursor and per-task source checkpoints resume interrupted startup without
repeating the completed prefix. `MULTIREMI_USAGE_MIGRATION_TIMEOUT_MS` defaults
to 300000 ms and must be positive; the deadline is checked between database
operations/batches, so an in-flight database operation can extend elapsed time.
Migration errors or deadline expiry fail startup, and the next container attempt
resumes the committed work. Logs include counts, never legacy JSON or credentials.
Compose/systemd updater readiness uses a 360000 ms wall-clock deadline, controlled
by `MULTIREMI_PLATFORM_HEALTH_TIMEOUT_MS` in the **host updater environment**.
Requests allow at most 5000 ms and probes sleep at most 2500 ms; both are capped
by the remaining deadline. API, Web and configured extra readiness URLs are
checked in parallel. Persistent failures after the container switch still trigger
local rollback.

Compose has its own startup window. For each enabled core service `api` or
`api-runtime`, keep these three times aligned (all comparisons use milliseconds):

```text
required = MULTIREMI_USAGE_MIGRATION_TIMEOUT_MS + 60000 startup margin
healthcheck.start_period >= required
MULTIREMI_PLATFORM_HEALTH_TIMEOUT_MS >= healthcheck.start_period
MULTIREMI_PLATFORM_HEALTH_TIMEOUT_MS >= required
defaults: 300000 + 60000 <= 360000 (360s) <= 360000
```

Both deployment templates use `start_period: 360s`, with the existing 10 s
interval, 5 s probe timeout and 12 retries. During that start period Docker does
not count failed probes toward unhealthy status; `web`'s
`depends_on: api: condition: service_healthy` waits for API readiness. The
additional retry window after the start period is not part of the migration
budget. These templates do not require Docker's newer `start_interval` option.

Every Compose `update` first renders `docker compose config --format json` and
checks the effective migration budget, including values merged from the API
`env_file`. The updater rejects all inconsistent budgets before changing the
image env file, pulling images or switching containers, and does not roll back
that rejected attempt. Absent/disabled Docker healthchecks skip the start-period
comparisons, but the updater deadline must still cover `required`. Only API
services present in both the updater core list and the rendered config are
checked. `rollback`, `restart` and `check_updates` skip the startup-budget
validation; `rollback` and `restart` still run the general safety preflight.

**Upgrade the host Compose file first, then install and restart the new host
updater, then update API/Web.** Host Compose files are not replaced by a platform
release. Add the start period to both API healthchecks in the host copy of
`compose.application.yml` or `compose.platform.yml` first. An older updater can
use this configuration. Reversing this order causes the new updater to reject
updates against the old file; this is a safe failure that leaves containers and
image env files untouched. Updating only the API image also does not replace an
older updater's fixed 24-probe readiness window; setting the new timeout variable
on that older implementation does not extend it.

For a large dataset, prepare the scalar migration with the **new API image** and
the installation's normal database environment before requesting the update:

```bash
bun run scripts/migrate-usage-accounting.ts --execute
```

This preparation commits task checkpoints but does not establish startup
readiness; the new API still rechecks changed sources on startup. On host 209,
preparing the remaining 5,090 tasks took 77 s on 2026-10-07. If increasing
`MULTIREMI_USAGE_MIGRATION_TIMEOUT_MS`, increase both API healthcheck start periods
and `MULTIREMI_PLATFORM_HEALTH_TIMEOUT_MS` in the host `updater.env` together.

On an isolated restored copy with 11320 task rows,
Bun 1.3.14/PostgreSQL 17.11 measured schema setup at 8.343 s and scalar migration
at 138.350 s (2026-10-06), exceeding the old roughly 60 s connection-refused
window. This separate clone measurement is not production throughput.

The `Platform Compose startup` GitHub Actions workflow runs
`scripts/check-compose-startup.ts` with real Docker: both API roles delay
`/readyz` for 150 s, using the application's template healthcheck unchanged.
The update-style `up -d --no-deps api web api-runtime` must succeed after more
than 120 s; a fresh control project with only `start_period` removed must fail
with `is unhealthy`. It runs only for deployment Docker files, updater code or
that script, and can also be dispatched manually.

PostgreSQL uses a dedicated usage migration advisory mutex for schema/checkpoints
and each bounded batch. It does not hold the global schema lock while migrating
data. SQLite uses immediate per-task writer transactions. The final readiness
check and marker share one transaction; PostgreSQL briefly locks task/run tables
against writes during that final check. Empty databases pass this gate too.
Subsequent ready startups check the marker and query pending task IDs inside the
database. They detect source changes from old writers or an image rollback
without loading old JSON payloads into the process. Null or default `[]`
deprecated fields for new v2-only tasks do not create empty legacy runs.
An empty first-attempt queued task with no dispatch/start/terminal evidence is
audited without a phantom execution run, so its later complete v2 usage remains
complete. Actual retries create new task IDs. A matching direct parent chain
with a complete, Runtime-bound live v2 parent run keeps prior consumption on the
parent; restart does not manufacture an old execution on its child. An attempt
ordinal without that attribution evidence still retains unknown coverage,
without inventing any additional tokens.

An optional `scripts/migrate-usage-accounting.ts --execute` preparation retains
the original audit and all observed source versions, but does not write the
startup cutover marker. The first new startup detects JSON/time changes made by
old servers after preparation, replaces only its provisional legacy aggregate,
and preserves modern live runs and evidence-verified recovered facts. Totals with
ambiguous semantics remain reported evidence, without invented actual/context
tokens. Startup never scans archives or raw telemetry; normal reports read only
the canonical ledger. See the [usage contract](../docs/usage-accounting.md).

Keep the updater's drain-protected switch: stop the old API writers before
allowing the new processes to finish cutover. Running an old image against the
database after the startup marker has been established can still write JSON
without updating the ledger. A new startup detects such changes. If the task
already has counted native facts under any run, including ordinary authenticated
v2 and recovered historical runs, it commits a source-conflict audit,
revokes readiness and fails without advancing the processed source or changing
those facts. The deprecated ingestion entry likewise rejects changed aggregates
as nonretryable `invalid_report`; identical processed snapshots remain idempotent.
An audit can describe a rejected observation and is never acceptance proof,
even beside an existing legacy run. A pre-checkpoint preparation or ingress
snapshot may establish a checkpoint only if its normalized nonempty legacy
units exactly match persisted unit identities and facts (excluding revisions
and task lifecycle occurrence times).
Empty execution shells and context-only history do not block proven legacy
consumption. Resolving an overlap requires reviewed evidence, not an automatic
sum, maximum, or replacement.

Production schema preparation may precede the switch. Evidence recovery must
wait until old writers have stopped, old reports have drained and new code has
completed its startup cutover. Generate and review a fresh source cohort and
plan after that fence. A clone rehearsal or merged source does not establish
that deployment or production recovery has happened.

Validation: `tests/unit/multiremi/usage-startup-migration.test.ts` covers fresh and
existing databases, checkpoints/restart, source changes, modern/recovered facts,
failed readiness, unchanged ready startup, and two processes sharing an isolated
SQLite file. `tests/unit/multiremi/usage-startup-postgres.test.ts` creates and
deletes an isolated database through `MULTIREMI_TEST_POSTGRES_URL` and exercises
fresh/restart/prepared cutover and two real UI/runtime startup processes. The
PostgreSQL and SQLite startup tests were run with Bun 1.3.14 against disposable
databases. Updater deadline tests cover readiness beyond 60 s/300 s, finite
failure deadlines, request time, extra runtime readiness and rollback. The clone
benchmark completed all 11320 checkpoints in 23 batches; the separate-process
earlier marker-only warm migration check took 0.984 ms and executed zero batches
(Store schema setup still took 8.309 s). That measurement predates the required
pending-source check and is not a timing claim for the current warm gate. The
benchmark started no jobs, HTTP listener or providers.

## Release pipeline

Prepare every release, including nightly releases, with Bun 1.3.14:

```bash
git fetch origin --tags
bun run release:prepare --version <next-unused-version>
```

This resolves the latest stable ACP bridges, Claude SDK/CC and Codex from the
public npm registry, installs them in a disposable home, verifies executable
versions and ACP initialization, then updates `package.json` and the tracked
runtime snapshot. `--dry-run` performs the same checks without editing files.
Review and commit both files as the release change. Preparation failure leaves
both files unchanged. The command does not create commits, tags or releases.

Push a formal SemVer tag only after the tag commit's `Release build check` run
on `main` succeeds. The tag-triggered `Release` workflow publishes the daemon
CLI GitHub Release first, then calls the reusable `Platform release` workflow
to publish the API/Web images and attach the platform manifest and systemd
archive to the same release.

Select a new, unused SemVer version only for an explicitly requested release;
the package version, tag, and GitHub Release must agree. See [repository release
rules](../AGENTS.md).

CI rejects version bumps without a matching prepared runtime snapshot. The tag
workflow checks that snapshot and successful full CI on the exact main commit
before publishing the CLI; it does not resolve dependencies again after tagging.
See [daemon runtime upgrades](../docs/daemon-runtime-upgrades.md) for installation.
That guide also contains the checksum-pinned macOS arm64 recovery path for the
legacy 0.2.68 updater and documents the deliberately separate self-hosted CLI
release mirror configuration.

`Platform release` keeps a manual dispatch entry for recovery. Images carry
both the version tag and a `sha-<commit>` tag. A retry reuses an existing image
only when both tags resolve to the same digest; a conflicting or incomplete
tag pair fails closed.

## Host updater

1. Install the repository at a stable updater path, outside the releases it switches.
2. Create `/etc/multiremi/platform-updater.env` from the systemd example with
   mode `0600`. Use a token distinct from `MULTIREMI_TOKEN`.
3. Install and enable `deploy/systemd/remi-platform-updater.service`.
4. Add the same `MULTIREMI_PLATFORM_UPDATER_TOKEN` to the API secret env file.

For Windows, macOS and Linux, the default `docker_compose` driver uses Docker
Compose v2 with Linux containers. Run `bun --env-file=<absolute-updater.env>
run apps/platform-updater/main.ts` using Bun 1.3.14. Use a user-owned directory
for `MULTIREMI_PLATFORM_STATE_DIR` (default `~/.remi/platform-updater`), absolute
Compose/env paths, and `MULTIREMI_PLATFORM_COMPOSE_PROJECT` when the stack was
started with `-p`. Keep one updater and one state directory per deployment;
the local PID lock prevents duplicate pollers sharing that directory. A Windows
Task Scheduler job or macOS launchd job can supervise this same command.

The updater switches **API and Web**, preserving database containers,
volumes, daemons and the SSH control plane. The full Linux SSH Mesh example
mounts `/etc/ssh`; use an API/Web Compose stack without that Linux-only sidecar
on Windows/macOS. Released API/Web images target `linux/amd64` and `linux/arm64`.
The updater tests run in the release-check matrix on Windows, macOS and Linux;
adding that matrix does not itself constitute a completed CI run.
Split application services such as `api-runtime` remain configurable through
`MULTIREMI_PLATFORM_CORE_SERVICES`. Protected names (`ssh-mesh-control-plane`,
`daemon`, `postgres`, `openviking`) are excluded even from an explicit list.

Open Web **Settings → System → Version & services** (`?tab=platform`) with the
local workspace owner/admin account. It exposes update checks, blocking reasons,
update/restart/rollback, cancellation before switching, and the HTTPS release
feed address. The saved address overrides `MULTIREMI_PLATFORM_RELEASE_FEED_URL`;
resetting it to `null` uses the host default. Changing it clears prior discovery
and preflight results. An unreachable feed does not stop the updater heartbeat.
Settings, check results and operations are stored on the API, not in the browser.

Before first use, save the actual installed release manifest as
`<stateDir>/current-release.json` for Compose, or `.platform-release.json` inside
the current systemd release. Both current and target need a `dataSchema`
fingerprint from `node scripts/platform-data-schema.mjs <release-source-root>`.
The release workflow publishes this value. The updater compares both metadata
and actual API migration source plus its data-transform/storage helpers (listed
in `packages/platform-updater/src/data-schema-inputs.json`). Changes to migration
dependencies must update that list too. Unknown or changed fingerprints block automatic
updates and rollback: perform and verify that migration in a maintenance window
before registering the new current release. Do not copy a target fingerprint
onto an older release to bypass the check.

### Required backups

Set `MULTIREMI_PLATFORM_BACKUP_CONFIG` to an absolute, host-owned JSON file
following [`platform-backup.example.json`](platform-backup.example.json).
It specifies a consistent database dump command, a restore verification command,
all persistent state/configuration paths, and a backup directory outside them.
Commands are argument arrays; they are never accepted from Web or a release feed.
For PostgreSQL, [`verify-platform-backup.ts`](../scripts/verify-platform-backup.ts)
restores the dump to a uniquely named temporary database, verifies the restore
completed, then drops only that database. Its account needs create/drop-database
permission; missing permission blocks the update. It never restores the live DB.

Windows Docker named volumes can be included through `archives`: each entry has
a unique `name`, `dumpCommand` and `verifyCommand`. For example run an existing
pinned utility image with `--rm --network none --read-only --mount
type=volume,src=<api-home>,dst=/backup,readonly --entrypoint tar <image> -C /backup
-cf - .`; validate its stdin archive with `docker run --rm -i --network none
--entrypoint tar <image> -tf -`. Include every persistent API volume and secret
file; the updater cannot infer application-specific external storage. Bind mounts
use absolute `dataPaths`. Symlinks require explicitly configured resolved paths.

Backups stream binary data to restrictive files, validate database/volume
archives, copy persistent files, fsync and recheck SHA-256/size, and only then
write `complete.json`. A failed backup never reaches service switching. A backup
is retained for manual disaster recovery; the updater never restores an old
database automatically and never deletes deployment data volumes.

On startup, committed recovery journals are handled before any control-API
request, so a failed API image cannot prevent recovery of the old program.
Prepared journals do not restart services; verified journals only replay results.

The transitional `systemd_release` driver builds a verified release archive in
a new directory, atomically switches the `current` symlink, restarts API/Web,
and restores the old symlink if health checks fail.

### Windows stable local-profile host

The `local_profile` driver is the Windows-first self-update path. It reuses the
same persisted API operation and drain protocol, but stages a fixed Git commit
and the checksum-pinned release source before touching the running profile.
The updater executable, task wrapper, secrets, operation journals and profile
data all live outside the source checkout and the API containers.

1. From the exact reviewed updater commit, build the standalone executable with
   `bun run platform-updater:compile:windows`. Release CI must attest or retain
   that executable; do not compile unreviewed source on the production host.
2. Keep a dedicated host checkout at `MULTIREMI_LOCAL_PROFILE_REPOSITORY`.
   Updating fetches Git objects but never checks out over the running updater.
3. Copy [`windows/platform-updater.env.example`](windows/platform-updater.env.example)
   outside Git, replace every placeholder, and use an updater token distinct
   from the API administrator token.
4. In an elevated PowerShell, install the executable and configuration with
   `deploy/windows/install-platform-updater.ps1 -UpdaterExecutable <path> -Config <path>`.
   The installer copies them below ProgramData, restricts the ACL to the current
   user and SYSTEM, and registers a highest-privilege logon scheduled task with
   one-minute restart-on-failure. Docker Desktop must run in that same user
   session; the task is deliberately not attached to the Remi daemon or API.
5. Put the same `MULTIREMI_PLATFORM_UPDATER_TOKEN` in stable `api.env`, restart
   stable once using the existing manual runbook, then verify `platform status`
   reports driver `local_profile`, a current release, services and a fresh
   heartbeat before enabling updates.

The source release manifest is accepted only with SemVer, a full 40-hex commit,
an HTTPS URL without credentials, query or fragment, and a SHA-256. Host staging checks
free space and host/Docker architecture, downloads and hashes the CI-produced
archive, fetches that exact commit from `origin`, builds candidate images, then
restores the live configuration. Preflight checks capacity, current images and
the running API's migration fingerprint. Older profile metadata derives its
fingerprint from the recorded immutable commit; unavailable source blocks updates.
Staging compares the current and fetched target migration sources against the
manifest's `dataSchema`. Switching begins only after drain succeeds and is rechecked.

The browser/CLI creates the operation inside the API container; the host polls
the published API port with the API and independent updater credentials. It
builds and switches **both API and Web** from the same immutable commit. No
Docker socket or host command channel is exposed to the browser or API container.

Each switch writes an atomic journal under
`<profiles-root>/stable/host-operations/<operation-id>/`. The global host lock
prevents concurrent mutation. A v2 backup completion manifest hashes the
PostgreSQL dump, API-home archive and matching configuration and records the
recovery command. If the executor dies after writers stop, its next scheduled
start runs recovery before heartbeat. Automatic updates require identical data
schemas; recovery and Web/CLI rollback restore application code/configuration
while retaining the current PostgreSQL and API-home data. Rollback still takes
a fresh rescue backup, verifies the target schema and checks both images/health.
The host stays fenced if recovery fails. The separate manual host rollback
commands retain full snapshot restoration for disaster recovery; omit
`--preserve-data true` only when intentionally restoring that historical data.
Legacy operation journals keep their original snapshot recovery semantics.

The host retains request envelopes and terminal receipts outside the database
under `host-operation-receipts/`. Before any new claim it replays receipts through
the updater-only `/api/platform-updater/operations/reconcile` endpoint. Restoring
a DB cannot silently erase the operation audit or replay a previously completed
update. For old APIs without that endpoint, the preserved control-plane rows can
be acknowledged through the existing report protocol; missing or conflicting
outcomes keep the fence closed.

During switching, an external `host-control/write-fence.json` and a host-pinned
Bun preload block business mutations even when restoring an older API image.
WebSocket handshakes are also rejected: daemon heartbeats can claim commands
and update runtime state. HTTP reads/health and the authenticated updater
channel remain available.
Switch-phase maintenance cannot expire automatically; writes reopen only after
both containers (or recovery) are verified and the API acknowledges the durable
terminal receipt. Interrupted or incomplete recovery remains closed.

The host also retains the effective API/updater credentials in
`host-control/updater-auth.env`, loaded after the business snapshot's `api.env`.
Retries of the same operation reuse that capture so older credentials cannot
break acknowledgement after rollback. To rotate them deliberately, update the
host configuration and profile `api.env`, run
`node scripts/local-profile.mjs stable host-auth-refresh`, then recreate API and
restart the updater. Refresh is rejected while a host write fence is active.

The installer prefers an installed PowerShell 7 executable, falls back to
Windows PowerShell, and accepts `-PowerShellExecutable` for an explicit path.
The Windows runner holds a named mutex for its configuration path across logon
sessions, so a manual runner and scheduled-task retry cannot overlap. Staging
reuses fixed-commit images only when their OCI revision labels exactly match;
missing services are built, and conflicting existing tags are never overwritten.

Repeated API creates can carry `requestId`; repeated creates with the
same caller/key/payload return the same operation, and the host stages/activates
the resulting operation ID at most once.

macOS and Linux may reuse `local_profile` with launchd/systemd plus the same
environment contract, but only the Windows scheduled-task installer is shipped
here. Non-profile Linux deployments continue to use `systemd_release` or
`docker_compose`; their storage and migration rollback boundaries are not
interchangeable with local-profile backups.

## Docker Compose control plane

Keep `platform.env` and `api.env` outside Git with mode `0600`. Create `api.env`
from [`docker/api.env.example`](docker/api.env.example), replace every required
placeholder, and enable only the optional features the deployment uses. Never
commit the populated file. Set API and Web images to immutable GHCR digests from
`platform-release.json`, then run:

```bash
docker compose --env-file /etc/multiremi/platform.env \
  -f deploy/docker/compose.platform.yml up -d
```

Set the host updater driver to `docker_compose` and provide the compose file,
env file, and state directory. Existing PostgreSQL and OpenViking data must be
backed up and mounted into the configured volumes before the first cutover.

## Existing data-service migration

When PostgreSQL and OpenViking already run in Docker, use
`compose.application.yml` first. It owns only API/Web and joins the existing
data-service networks; it never creates, replaces, or deletes data containers.

1. Back up PostgreSQL, OpenViking, uploads, session archives, and SSH Mesh state.
2. Copy `deploy/docker/api.env.example` to an API env file outside Git, replace
   its required placeholders, set mode `0600`, and change the database hostname
   to the existing network alias (`postgres` by default). Do not copy secrets
   into the Compose env file. Create a separate control-plane env file whose database
   URL uses the host-published PostgreSQL address (`127.0.0.1` by default).
3. Create a persistent service home owned by the runtime user and bind it with
   `REMI_HOME_DIR`. Bind the existing uploads, session archives, and SSH Mesh
   directories beneath it with `REMI_UPLOAD_DIR`, `REMI_SESSION_ARCHIVE_ROOT`,
   and `REMI_SSH_MESH_ROOT`. Set `REMI_RUNTIME_UID` and `REMI_RUNTIME_GID` to
   their owner. SSH Mesh rejects a root-owned service home. Bind the host
   account's `.ssh` directory with `REMI_SSH_HOME_DIR` and set its login name in
   `REMI_SSH_USER`.
4. Start on the staging ports (`16120` and `13000`) with
   `REMI_BACKGROUND_JOBS=0` and `REMI_SSH_MESH_CONTROL_PLANE=0`. Verify API,
   Web, login, database-backed counts, OpenViking readiness, attachments, and
   WebSockets without running a second scheduler or SCM poller.
5. Stop the host API/Web, set `REMI_BACKGROUND_JOBS=1` and
   `REMI_SSH_MESH_CONTROL_PLANE=1`, start the app stack, verify SSH Mesh
   ownership, then switch the reverse proxy to the new ports. Keep the host
   units installed but stopped for rollback.

The API container never owns the SSH Mesh control-plane lease. Compose runs a
dedicated `ssh-mesh-control-plane` sidecar with host networking so it observes
the host sshd, network addresses, and host keys without starting a Runtime or
task worker. The sidecar mounts `/etc/ssh` read-only and writes only the managed
blocks in the configured host account's `.ssh` directory.

The updater may use this Compose file after cutover. Set
`MULTIREMI_PLATFORM_POSTGRES_CONTAINER` and
`MULTIREMI_PLATFORM_OPENVIKING_CONTAINER` so externally managed dependencies
still appear in the service status panel.

Message ingestion needs no service of its own. `lark-cli` is baked into the API
image at a pinned, checksum-verified version, and the API server runs it
directly, so there is no ingestion container, port, or endpoint registry to
configure. Enable it by logging in once inside the API container:

For a deployment using this repository's `compose.application.yml`, the command
needs the same explicit env and Compose file as everything else (see
[Split API roles](#split-api-roles) for the path definitions); for the
single-file `compose.platform.yml` layout from
[Docker Compose control plane](#docker-compose-control-plane), pass that file and
its own env file instead:

```bash
docker compose --env-file /etc/multiremi/application.env \
  -f /multiremi/platform/container/compose.application.yml exec api lark-cli login
```

The credential lands in the container's home directory, which is the
`REMI_HOME_DIR` bind mount, so it survives image upgrades and never enters
Compose, an env file, or Git. An installation upgrading from the retired
`feishu-sidecar` needs no action: the updater removes that leftover container
before it replaces the API container, and leaves its named data volumes alone.
See [`docs/feishu-message-ingestion.md`](../docs/feishu-message-ingestion.md)
for the connection model, the rollout runbook, and rollback.

## Session Archive v2

Session Archive content is a standard ZIP (`multiremi.session-archive.v2`). Each
member is deflated independently at level 6 and ends with a data descriptor, and
`index.json` — the last member — records every member's offsets, sizes and
sha256. Reading one task's trace therefore costs one `pread` of that member plus
one inflate, instead of unpacking the whole archive. Zip64 covers members above
4 GiB and archives above 65535 members.

Members are `manifest.json`, `traces/<task_id>.jsonl`, `sessions/<session_id>/…`
(provider-native history, minus the credential/config exclusion list) and the
trailing `index.json`. A trace member's entry also records `head` (the largest
event seq), `event_count` and `closed`, so a pointer write needs no extra
inflate. A trace file's first and last lines are structural — they carry no
`seq`; events start at seq 1, a repeated seq is corruption and the first
occurrence wins, and a final line without a newline is a crash-truncated append
that readers drop. `manifest.json` digests the content, so
`source_revision` is unchanged by the compression; the archive `sha256` stays
the digest of the whole blob. The GC barrier and the hard-delete barrier key on
those two values and did not change.

An archive belongs to one subject: an `issue`, a `chat` session, or a one-shot
`task`. Issue subjects keep the historical `issue_id`; chat and task subjects
have none, so the ack binding for those is the Runtime that owns the subject's
provider session.

An archive's trace pointers are only moved forward, and only within their
source: a pointer that already reads from a daemon archive is replaced only by
another daemon archive whose member's `head` is at least the old `head_seq`. A
daemon archive replaces a pointer that reads from a backfilled archive
(`metadata.kind = "trace_backfill"`) whatever the heads, and a backfilled
archive never replaces a daemon one, because old-table seqs and daemon trace
seqs are not comparable. A partial or stale archive still becomes `ready`, but
it never takes a pointer away from a longer trace of its source; the server log
names each pointer it kept. The pointer table records `head_seq`, `closed` and
the pointer's `source` alongside the byte range.

Uploads are served per subject: `/api/daemon/runtimes/:runtimeId/issues/:issueId/…`,
`…/chats/:sessionId/…` and `…/tasks/:taskId/…` speak the same protocol over that
subject's ownership rule (the Issue workspace row, `chat_sessions.session_runtime_id`
or `tasks.runtime_id`). A daemon uploads a Chat or one-shot Task archive to its own
route; a Runtime that does not own the subject is refused.

The server refuses new non-v2 uploads before any attempt is claimed and answers
`session_archive_format_unsupported`. The check reads the request the client
actually sends: an upgraded daemon names the v2 format in `metadata.format`, and
anything else is treated as the legacy container. Existing v1 rows and their files are left
untouched, so an installation upgrading from v1 keeps its bound archives
readable and its hard-delete barrier intact; only a v1 daemon that still has not
upgraded sees the rejection.

## Direct Session Archive uploads (MUL-144)

Session Archive content is a potentially large binary PUT. It must enter the
API directly instead of passing through the Web container's Next.js
`/api/:path*` compatibility rewrite. Keep that rewrite for normal API traffic
and installations that have not enabled the direct path; do not use it for
large archive bodies.

The API and daemon recognize these settings:

- `MULTIREMI_DAEMON_DIRECT_BASE_URL` (API): public API origin advertised in the
  archive init response, for example `https://remi.example.com`. It must be an
  `http(s)` origin with no credentials, path, query, or fragment. When unset,
  init keeps returning the legacy relative upload URL.
- `MULTIREMI_ARCHIVE_UPLOAD_BASE_URL` (daemon): operator-trusted API origin that
  overrides the advertised origin for archive content only. Use it as a
  temporary escape hatch or when the direct API uses a different hostname.
- `MULTIREMI_ARCHIVE_PROXY_MAX_BYTES` (daemon): maximum archive size allowed
  through a relative control-plane/Next.js fallback. The default is 8 MiB.
  Larger archives fail before PUT and persist an actionable `last_error` that
  names the direct-upload settings; smaller archives remain backward
  compatible.
- `MULTIREMI_ARCHIVE_DIRECT_PROBE_TTL_MS` (daemon): TTL for positive and
  negative direct-route HEAD attestations. The default is 5 minutes.
- `MULTIREMI_ARCHIVE_DIRECT_PROBE_TIMEOUT_MS` (daemon): maximum HEAD
  attestation duration. The default is 10 seconds; a failure or missing marker
  is treated as an unconfigured direct route.
- `MULTIREMI_ARCHIVE_UPLOAD_TIMEOUT_MS` (daemon): total timeout for one archive
  PUT. The default is 15 minutes, matching the Nginx sample. Increase it for
  exceptionally slow links rather than removing the bound.
- `MULTIREMI_ARCHIVE_FAILURE_REPORT_TIMEOUT_MS` (daemon): timeout for the
  best-effort `last_error` callback after a failed upload. The default is 10
  seconds.

An absolute URL advertised by the authenticated API is accepted without daemon
configuration only when its hostname matches `MULTIREMI_SERVER_URL`; a daemon
override explicitly trusts a different hostname. HTTPS control-plane URLs
cannot be downgraded by the server response. In all cases the daemon verifies
the exact archive pathname and attempt query, rejects credentials/fragments,
and refuses redirects before attaching its Bearer token. An absolute URL is
only a direct-route candidate: before PUT, the daemon sends an authenticated
HEAD request to the same content URL. Only a `204` response carrying
`X-Remi-Archive-Direct: 1` proves that Nginx selected the direct API location.
The direct Nginx location injects `X-Remi-Archive-Direct-Route: 1` into the
upstream request. The API emits the response marker only when that route proof
is present and the request `Host` authority (including a non-default port)
matches `MULTIREMI_DAEMON_DIRECT_BASE_URL`. The Next.js compatibility rewrite
does not inject the route proof, so it cannot attest itself even if it preserves
the public `Host`; response-header passthrough therefore cannot create a false
positive. Results are cached by target origin for the configured finite TTL.

The route proof is only as trustworthy as the edge that injects it. Nginx must
also clear a client-supplied `X-Remi-Archive-Direct-Route` on every other path,
otherwise a caller can send the header itself and reach the API through the
Next.js rewrite. The authority check does not cover this on its own: it compares
the request `Host` to `MULTIREMI_DAEMON_DIRECT_BASE_URL`, so it is a no-op
whenever the direct route shares the public host and port, which is the topology
the sample configuration describes. Add
`proxy_set_header X-Remi-Archive-Direct-Route "";` to the enclosing server block
so only the direct location supplies the proof.

The default 8 MiB fallback rejects larger archives unless a direct route is
attested. Operators may configure `MULTIREMI_ARCHIVE_PROXY_MAX_BYTES`, but a
larger limit does not establish the capacity of their proxy. Validate the actual
deployment route and upload behavior before changing it.

Use [`nginx/session-archive-direct.conf`](nginx/session-archive-direct.conf) in
the public server block. It disables request/response buffering, allows bodies
up to 1 GiB, gives a streaming upload 15 minutes, preserves the public `Host`,
and injects the direct-route proof consumed by the API. Replace its sample
`16120` upstream port with the host's effective `REMI_API_BIND_PORT`, and add the
server-level `proxy_set_header X-Remi-Archive-Direct-Route "";` documented in the
file header. Keep the API container bound to loopback; Nginx is the external
network path.

Audit the complete effective configuration with `nginx -T`. Ordinary prefix
location order does not decide this match. A broader regex declared earlier can
win, and a covering `^~` prefix such as `^~ /api/` prevents regex locations from
being evaluated at all. Place this regex before broader matching regexes and
remove or narrow any covering `^~` prefix. Inspect the target deployment's
effective configuration; a configuration checked on another host or release
does not establish the current route.

When enabling direct uploads on a deployment, perform these checks:

1. Read the deployment's Compose env and confirm the effective host API port;
   do not assume the sample port.
2. Inspect `nginx -T` for earlier matching regexes and covering `^~` prefixes,
   then add the direct location, run `nginx -t`, and reload Nginx. Its position
   relative to an ordinary Web catch-all is irrelevant.
3. Add `MULTIREMI_DAEMON_DIRECT_BASE_URL=https://<public-api-host>` to the
   API secret env file and redeploy through the normal release/updater flow.
4. Upgrade Runtime daemon CLIs through their normal release flow to obtain
   streaming uploads, URL validation, the proxy-size guard, and durable upload
   failure reporting. Platform deployment does not upgrade Runtime CLIs.
5. Initialize a disposable archive attempt and send an authenticated HEAD to
   its exact `upload_url`. Confirm a `204` response with
   `X-Remi-Archive-Direct: 1`; a missing marker means the route is not active.
   Keep daemon tokens out of shell history and logs.
6. Retry failed archives, then verify API access logs receive the content PUTs,
   Web/Next.js logs do not, and each archive becomes `ready` with its declared
   size and SHA-256. Check Web process memory/event-loop health during the run.

`remi session archive retry <issue> <archive-id>` also accepts an exhausted failed archive. It
resets the attempt count, error, backoff timestamp, and exhaustion timestamp,
returning the row to `pending` with `retry_state=eligible`. Run it once per
failed archive only after the direct route and API setting pass the HEAD check;
the daemon will claim and upload the recovered attempt on its next archive run.

Do not expose the API container port directly to the network and do not place
daemon tokens in Nginx configuration or logs.

## Split API roles

A deployment can run the browser surface and the daemon surface in two API
containers instead of one. The daemon surface carries 94% of the request volume
and is a separate process so its load cannot queue behind the browser surface.
`compose.application.yml` and `compose.platform.yml` ship the second service as
`api-runtime`, behind the `split` profile, so **the default stack is unchanged**:
without `--profile split` those files declare exactly the services they always
did, and with `REMI_API_ROLE` unset the `api` container answers both surfaces
with health payloads that are byte-for-byte what they are today.

The switch is an operator action, not a release action. The Compose file, the
Nginx configuration, and the updater binary are host files: the daily release
only replaces images, so merging the templates does not move a running
installation. It happens in **two stages**:

- **Stage A (route the traffic)** moves the daemon surface to `api-runtime` via
  Nginx. The `api` container keeps its default role, so nothing about the
  browser process changes yet.
- **Stage B (add the guard)** turns `api` into role `ui` so a misrouted daemon
  request is answered with `421 misdirected` instead of being served. This is an
  insurance policy, not the source of the performance win: the win comes from
  the routing in stage A.

Both stages are outside the release path and only touch the Compose file, the
Compose env file, Nginx, the updater env file, and the `api-runtime` container.
These topology edits do not directly write business data. Starting either API
role still runs the required [usage cutover](#usage-accounting-startup-cutover),
which can write migration checkpoints and the canonical usage ledger.

### Paths and the Compose prefix

Every `docker compose` command in this section names the env file and the
Compose file explicitly. Nothing relies on Compose's implicit `.env` discovery,
and every command below can be pasted as written once this block has been run in
the shell:

```bash
COMPOSE_DIR=/multiremi/platform/container
COMPOSE_ENV="$COMPOSE_DIR/application.env"
COMPOSE_FILE="$COMPOSE_DIR/compose.application.yml"
NGINX_MAIN=/etc/nginx/nginx.conf
NGINX_SITE=/etc/nginx/sites-enabled/remi
NGINX_ARCHIVE=/etc/nginx/snippets/session-archive-direct.conf
```

so the canonical invocation is

```text
docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" <args>
```

and a command that addresses `api-runtime` adds `--profile split` immediately
after `docker compose`. `$COMPOSE_ENV` is the file the host updater is
configured with (`MULTIREMI_PLATFORM_COMPOSE_ENV_FILE`) and `$COMPOSE_FILE` is
its `MULTIREMI_PLATFORM_COMPOSE_FILE`.

`$NGINX_ARCHIVE` is the include that carries the archive-upload `location`. It is
a separate file on this host; if the path differs, find it with
`nginx -T | grep -n session-archives`. If your layout instead keeps every
`location` inside the site file, then `$NGINX_SITE` is the only Nginx file to
back up and restore, and the two mentions of `$NGINX_ARCHIVE` below collapse
into it.

### Where each variable lives

`REMI_API_ROLE` and `REMI_API_PEER_URL` are **Compose interpolation variables**.
They are read by `docker compose` itself to render `compose.application.yml`, so
they belong in the Compose env file (`$COMPOSE_ENV`, next to `REMI_API_IMAGE`) or
in the calling environment, **not** in the API `env_file`:

- The API `env_file` (for example `/etc/multiremi/api.env`) is passed to the
  container as-is and holds secrets such as `MULTIREMI_TOKEN`. Values set there
  are read by the API process only if the service's `environment` does not
  define the same key.
- The `api` and `api-runtime` services **do** define `MULTIREMI_API_ROLE` and
  `MULTIREMI_PEER_URL` in their `environment` block, and service-level
  `environment` wins over `env_file`. Writing `REMI_API_ROLE=ui` (the Compose
  variable, without the `MULTIREMI_` prefix) into the API `env_file` therefore
  has no effect at all: the container still receives the value Compose
  interpolated.

Confirm the rendered result before moving on. This prints what the containers
will actually get:

```bash
docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" --profile split \
  config | grep -A2 MULTIREMI_API_ROLE
```

`MULTIREMI_PEER_SECRET`, by contrast, **is** read by the API process and goes in
the API `env_file`; it defaults to `MULTIREMI_TOKEN` when unset.

### What the updater rewrites, and what it does not

The updater rewrites `$COMPOSE_ENV` on every update and rollback:
`writeImageEnv()` reads the file, replaces `REMI_API_IMAGE` and `REMI_WEB_IMAGE`,
and atomically renames the result back over it
(`packages/platform-updater/src/compose-driver.ts:197-213`). It does **not** write
the Compose file, which it only passes to `docker compose` as `-f`
(ibid., line 284), and it never touches Nginx. Two consequences shape the
rollback below:

- **Never restore a whole backup of `$COMPOSE_ENV`.** That backup can predate
  later releases, and restoring it would roll `REMI_API_IMAGE` and
  `REMI_WEB_IMAGE` back with it. Delete the two stage-A lines instead, which is
  what the Full return step below does.
- **The Compose file may be restored from its backup**, because nothing else
  writes it. It is restored in Full return rather than in the stage A rollback,
  for the ordering reason given under "Full return".

### Prerequisites

- First align the host API healthcheck start periods and updater timeout with
  the [usage startup budget](#usage-accounting-startup-cutover). Prepare the
  host Compose healthchecks before replacing the updater binary; keep this
  prepared configuration when taking the rollback backup below.
- **Only operate inside the authorized window, and only when the updater is
  idle.** B1 authorizes 09:30-11:30 and 15:00-17:00 on the switch day. The
  updater is a separate long-running process that can claim a release at any
  time, so this runbook does not run at all while one is queued or in flight:
  the steps below edit the same Compose env file the updater rewrites
  (`writeImageEnv`, see "What the updater rewrites"), and an update landing in
  the middle of a manual edit can interleave with it. The pre-check is
  `remi platform operation list`: its GET `/api/multiremi/platform/operations`
  calls `PlatformOperationsRepo.list()`, a pure SELECT, without the maintenance
  getter. The pre-check must not trigger any business or platform state writes.
  Authentication bookkeeping for an already authenticated request (the access
  token's `multiremi_access_tokens.last_used_at`) is excluded from that rule,
  consistent with the group's read-only timing probes on 209.

  **The `local` workspace must already exist before this pre-check.** The auth
  chain `loadCurrentWorkspaceRole` -> `loadCurrentWorkspaceMember` ->
  `ensureLocalWorkspace()` first SELECTs it, but a missing row would INSERT a
  workspace and UPDATE the user; those are business writes, not authentication
  bookkeeping. On 209, all MUL-* issues belong to `local` (`issuePrefix: MUL`),
  the API forbids deleting `local`, and existing authenticated browser/daemon
  traffic has already initialized it. The B1 pre-check therefore cannot be the
  first request creating it; the no-business-write guarantee below depends on
  this initialized-workspace precondition.

  ```bash
  set -o pipefail
  remi platform operation list --output json --limit 100 | python3 -c "
  import json,sys
  from datetime import datetime,timedelta,timezone
  terminal = {'succeeded', 'failed', 'cancelled', 'rolled_back'}
  non_terminal = {'queued', 'preparing', 'pulling', 'draining', 'backing_up', 'switching', 'restarting', 'verifying', 'rolling_back'}
  operations = json.load(sys.stdin)['operations']
  if not isinstance(operations, list):
      sys.exit('STOP: invalid operations response')
  active = [op for op in operations if op['status'] not in terminal]
  for op in active:
      print(f\"activeOperation: {op['id']} {op['kind']} {op['status']}\")
  if active:
      sys.exit(1)
  def completed_at(op):
      value = op.get('finishedAt')
      if value is None:
          value = op.get('updatedAt')
      try:
          stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
          if stamp.tzinfo is None:
              raise ValueError('timestamp needs a timezone')
          return stamp.astimezone(timezone.utc)
      except (AttributeError, TypeError, ValueError):
          sys.exit('STOP: invalid finishedAt/updatedAt')
  def utc_label(stamp):
      return stamp.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
  if operations:
      last = max(completed_at(op) for op in operations)
      wait_until = last + timedelta(minutes=11)
      if datetime.now(timezone.utc) < wait_until:
          print(f\"STOP: last operation finished at {utc_label(last)}; wait until {utc_label(wait_until)}\")
          sys.exit(1)
  print('activeOperation: none')
  "
  # expected, every time before and during the switch:
  #   activeOperation: none
  #   exit code 0; any nonzero exit code means do not start
  ```

  `terminal` mirrors `TERMINAL_STATUSES` in
  `packages/server/src/store/repos/platform-operations-repo.ts`.
  `non_terminal` is its complement in `MultiremiPlatformOperationStatus`
  (`packages/contracts/src/types.ts`), including `rolling_back`: these are the
  `active_slot = 1` operations the updater may be handling. Any status outside
  `terminal` means stop and wait, including an unknown future status. The list
  uses the server's maximum limit of 100 recent operations. Invalid JSON, a
  failed CLI request, or any nonzero exit code also means do not start.

  `create()` claims `active_slot = 1`, and the unique index
  `idx_multiremi_platform_operations_active` prevents another operation until
  `report()` or queued cancellation releases it; terminal states are irreversible.
  Thus at most one operation is non-terminal, and it must be the newest operation
  because all earlier ones finished before its creation.
  `list()` orders by `created_at DESC`, so the first page includes that operation
  even when more than 100 terminal records exist.

  Also wait 11 minutes after the latest completion in the returned operations:
  use `finishedAt`, falling back to `updatedAt` only when it is null, and compare
  in UTC. Terminal `report()` and queued `requestCancel()` both write
  `finished_at` and `updated_at`; the fallback covers older or incomplete rows.
  A missing or unparseable completion timestamp means STOP. An empty history
  has no completion to wait for. The 11 minutes cover the maximum drain TTL of
  600 seconds (`PLATFORM_DRAIN_MAX_TTL_MS` in `platform-maintenance-repo.ts`),
  the default 10-second daemon heartbeat, and margin. This avoids a residual
  lease pausing task claims during stage A observation after a failed release,
  without reading or mutating maintenance state.

  Do not read maintenance for this pre-check. Drain belongs to an active
  operation; with none active, a residual expired drain is recovered by the
  daemon's next heartbeat under the lease rule
  (`packages/server/src/api/routers/daemon.ts:433-435`). That write is the
  platform's own activity, not a side effect triggered by this pre-check. With
  no active operation, no additional drain check is needed. If drain state must
  be inspected, first ship a genuinely side-effect-free SELECT-only peek (a
  server change and release), or obtain separate authorization from He Huajie
  for maintenance writes. Also avoid 04:00 (the release build) and 07:00 (the
  daily image swap): the window above already excludes both.
- A release whose API image understands `MULTIREMI_API_ROLE`, `MULTIREMI_PEER_URL`
  and `MULTIREMI_PEER_SECRET` is already deployed, and `api_minute_summary` in
  the API logs carries a `pid`, so the two processes are distinguishable.
- Data-driven write paths are covered by the two-process integration test suite
  (MUL-463 stage 1: browser `comment:created` delivery 20/20, daemon
  `daemon:task_available` wake-up, claim is not duplicated). This runbook does
  **not** re-test them with writes on production.
- Back up every file the two stages change, so each rollback is a copy rather
  than an edit. `<date>` is today:

  ```bash
  mkdir -p "$COMPOSE_DIR/backups/<date>"
  cp "$NGINX_SITE"    "$COMPOSE_DIR/backups/<date>/nginx-site.conf.orig"
  cp "$NGINX_ARCHIVE" "$COMPOSE_DIR/backups/<date>/nginx-session-archive-direct.conf.orig"
  cp "$NGINX_MAIN"    "$COMPOSE_DIR/backups/<date>/nginx.conf.orig"
  cp "$COMPOSE_FILE"  "$COMPOSE_DIR/backups/<date>/compose.application.yml.orig"
  cp "$COMPOSE_ENV"   "$COMPOSE_DIR/backups/<date>/application.env.orig"
  cp /etc/multiremi/platform-updater.env \
     "$COMPOSE_DIR/backups/<date>/platform-updater.env.orig"
  ```

  Stage A changes `$COMPOSE_FILE`, `$COMPOSE_ENV`, `$NGINX_MAIN` (only if the
  `upstream` include goes there), `$NGINX_SITE`, `$NGINX_ARCHIVE`, and the
  updater env. Stage B changes `$COMPOSE_ENV` again. Which rollback restores
  which file is tabulated under "Rollback".

### Stage A: route the traffic

Re-run the `remi platform operation list` check from the prerequisites immediately before
starting, and again before each of the steps that touches a container or the
Compose files (steps 2, 3, 4, 5 and 7).

1. **Updater binary first.** This is the one step that cannot be undone by a
   reload. Build `apps/platform-updater/main.ts` from the release tag on a build
   host (Bun 1.3.14), replace `bin/multiremi-platform-updater` on the host, keep
   the previous file as `bin/pre-<tag>.<rand>/`, and restart
   `remi-platform-updater`. Leave `MULTIREMI_PLATFORM_CORE_SERVICES` unset at
   this point: unset is today's behaviour, including the pull list.
2. **Compose.** Merge the `api-runtime` service and the two `api` env lines into
   the host Compose file, keeping host-specific differences such as ports. In
   `$COMPOSE_ENV` add `REMI_API_RUNTIME_BIND_PORT=16121` and
   `REMI_API_PEER_URL=http://api-runtime:6120`; **leave `REMI_API_ROLE` unset**,
   so `api` keeps its default role. Check the rendering:

   ```bash
   docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" --profile split \
     config --services
   # must list: api, api-runtime, ssh-mesh-control-plane, web
   ```
3. **Start the runtime container.**

   ```bash
   docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" --profile split \
     up -d --no-deps api-runtime
   curl -s 127.0.0.1:16121/readyz
   ```

   Wait for healthy, confirm the response reports `role: "runtime"`, and confirm
   its logs show background jobs disabled and no migration errors.
4. **Let `api` reach its peer.**

   ```bash
   docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" \
     up -d --no-deps api
   curl -s 127.0.0.1:6120/internal/peer/health
   curl -s 127.0.0.1:16121/internal/peer/health
   ```

   This recreates `api` once (the same short outage as a normal release). Both
   calls answer on the loopback ports; neither endpoint is reachable from the
   public server, which step 5 pins down.
5. **Nginx.** Two files, two contexts, plus the archive include:
   - [`nginx/api-runtime-split-upstream.conf`](nginx/api-runtime-split-upstream.conf)
     defines `upstream multica_api_runtime`. It belongs in the **`http`**
     context, because `upstream` is only valid there. Include it from the
     `http` block of `$NGINX_MAIN`, or copy the `upstream` line into it.
   - [`nginx/api-runtime-split-locations.conf`](nginx/api-runtime-split-locations.conf)
     contains only `location` blocks. Include it in **each public `server`
     block** (the :80 and the :443 one), next to the archive include. Both
     blocks need it: the two listen on the same host, and an include in only one
     of them would leave the other public path different. The file also carries
     `location /internal/ { return 404; }` so the peer endpoints
     (`/internal/peer/events`, `/internal/peer/health`) can never be reached
     from the public server. Those are container-to-container calls; today's
     rewrite and catch-all already leave them unreachable, and the explicit rule
     keeps that true through later routing changes.
   - Point the archive-upload `location` in `$NGINX_ARCHIVE` at
     `multica_api_runtime` as well, so large archive bodies keep going straight
     to the runtime process.

   Putting the `upstream` line inside a `server` block is the mistake this split
   exists to prevent: `nginx -t` fails with
   `"upstream" directive is not allowed here`. Both files explain why the daemon
   location must be an ordinary prefix and must keep its trailing slash. Then:

   ```bash
   nginx -t && systemctl reload nginx
   ```

   Daemon WebSockets that are already established stay on `api`; that is
   expected during the transition.
6. **Observe for 30 minutes, read-only.** No writes are needed, and none should
   be made on production for this step:
   - both processes' `/readyz` answer, and `api-runtime` reports
     `role: "runtime"`;
   - in `api_minute_summary`, both sides' `peer` counters (`sent`, `dropped`,
     `failed`) — `dropped` and `failed` must stay 0 — and the daemon routes
     appear under `api-runtime`'s `pid`;
   - under existing traffic, daemon heartbeats and claims keep succeeding, and
     the `api` container's `/api/daemon/*` counters fall towards zero (residual
     counts are WebSockets established before the reload, which age out).
7. **Updater list.** Set
   `MULTIREMI_PLATFORM_CORE_SERVICES=api,web,api-runtime`,
   `MULTIREMI_PLATFORM_EXTRA_HEALTH_URLS=http://127.0.0.1:16121/readyz`, and
   `COMPOSE_PROFILES=split` in the updater env file. `COMPOSE_PROFILES=split` is
   explicit rather than conditional: it is what makes the updater's own `pull`
   and `up` see the profiled service on every Compose version, instead of
   relying on the version treating an explicitly named service as
   profile-enabling.

   Before restarting the updater, verify both lists. The updater core list is
   the three application services; Compose also contains the protected SSH
   control-plane sidecar, which the updater does not switch:

   ```bash
   set -a; . /etc/multiremi/platform-updater.env; set +a
   echo "$MULTIREMI_PLATFORM_CORE_SERVICES" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | sort
   # must print: api, api-runtime, web  (one per line)
   docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" --profile split \
     config --services | sort
   # must list: api, api-runtime, ssh-mesh-control-plane, web
   ```

   Then:

   ```bash
   systemctl --user restart remi-platform-updater
   ```

   Skipping this step leaves `api-runtime` untouched by the next release, so the
   two processes drift a release apart. The updater also logs a warning when the
   configured list is missing `api` or `web`.

### Stage B: add the guard

Re-run the `remi platform operation list` check from the prerequisites first; do not
start while an operation is queued or in flight.

Run this only after stage A has been stable for the agreed observation window
and the `api` container's `/api/daemon/*` counters have reached zero (daemons
reconnect within 1-30 s). Nothing about the performance win depends on this
step; it exists so a misrouted daemon request is rejected loudly instead of
being served by the wrong process.

1. Add `REMI_API_ROLE=ui` to `$COMPOSE_ENV`.
2. Recreate the container so it picks the value up (~30 s outage, the same as a
   release):

   ```bash
   docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" \
     up -d --no-deps api
   ```

3. Confirm `curl -s 127.0.0.1:6120/readyz` now reports `role: "ui"`, and that a
   daemon request to `api` returns `421 misdirected` with the `X-Remi-Api-Role`
   header (Nginx sends real daemon traffic to `api-runtime`, so this only shows
   up on a direct probe).

### Rollback

Re-run the `remi platform operation list` check from the prerequisites before each
stage B rollback, stage A rollback, and Full return below.

> **Precondition: rolling back the MUL-405 image requires a completed Full
> return, not just the two stage rollbacks.** Run the stage B rollback, the stage
> A rollback, and then Full return (all below); confirm the four single-process
> checks listed at the end of Full return; only then roll back the MUL-405 image.
>
> MUL-405 adds defensive unique indexes plus advisory locks for migrations and
> issue numbering. Reverting its code does **not** drop the indexes, and MUL-405's
> own rollback note is "revert this PR: the advisory lock and the defensive index
> have no side effects under a single process". The single-process premise is
> what makes that true. The older image computes issue numbers with `MAX+1` and no
> advisory lock, so two processes can allocate the same number, and there the
> retained unique index turns a race into a failed write instead of a guard.
> Reverting the image while `api-runtime` is still running, or while its peer
> configuration is still in `$COMPOSE_ENV`, is therefore not supported. Topology
> first, image second.

The order inside stage B is not interchangeable either: rolling the routing back
before the role would leave `api` as `ui`, answering `421` to the daemon traffic
Nginx just returned to it.

Each file the two stages change is restored by exactly one rollback, so no file
is left pointing at a process that is about to disappear:

| File | Changed by | Restored by |
|---|---|---|
| `$NGINX_SITE` | A step 5 (two `location` includes) | Stage A rollback |
| `$NGINX_ARCHIVE` | A step 5 (archive `proxy_pass`) | Stage A rollback |
| `$NGINX_MAIN` (only if the `upstream` include went there) | A step 5 | Stage A rollback |
| `$COMPOSE_FILE` | A step 2 (`api-runtime` service + two `api` env lines) | Full return |
| `$COMPOSE_ENV` | A step 2 (peer URL, runtime port), B step 1 (role) | Stage B rollback (role) and Full return (stage A lines, by deletion) |
| `/etc/multiremi/platform-updater.env` | A step 7 (list, health URL, profile) | Full return |

**Stage A rollback: 2-3 file restores + 2 commands, no container recreated.**
Restoring `$NGINX_SITE` alone is not enough: the archive include is a separate
file, and leaving it pointed at `api-runtime` keeps large archive uploads on a
process that Full return is about to stop.

```bash
cp "$COMPOSE_DIR/backups/<date>/nginx-site.conf.orig" "$NGINX_SITE"
cp "$COMPOSE_DIR/backups/<date>/nginx-session-archive-direct.conf.orig" "$NGINX_ARCHIVE"
cp "$COMPOSE_DIR/backups/<date>/nginx.conf.orig" "$NGINX_MAIN"   # only if A step 5 edited it
nginx -t
systemctl reload nginx
```

Then confirm both public server blocks serve the daemon surface and the archive
path from `api` again:

```bash
# 1. Gate on the exit code FIRST. If $NGINX_ARCHIVE was not restored, the
#    `multica_api_runtime` upstream no longer exists after $NGINX_MAIN goes back,
#    so `nginx -t` fails outright. Checking the count first would be misleading:
#    `nginx -T | grep -c` prints 0 (and exits 1) both when the config is clean and
#    when it is broken, so the number alone cannot tell the two apart.
if ! nginx -t; then echo 'NOT RESTORED: nginx config does not parse'; fi
# 2. Only after that, count the references in the fully expanded config:
nginx -T | grep -c multica_api_runtime || true   # 0 = no runtime references left

# 3. The two file-level checks, which name the offending file directly:
grep -n 'proxy_pass' "$NGINX_ARCHIVE"      # -> proxy_pass http://multica_api;
grep -n 'multica_api_runtime' "$NGINX_SITE" || echo 'site file clean'
```

The `api-runtime` container and the updater list stay as they are, which is
harmless: with daemon traffic back on `api`, the runtime container keeps its peer
channel open and simply reports no traffic. The Compose file is deliberately
**not** restored here — see Full return for why.

Measured in a local sandbox on nginx 1.22.1, with the snippets assembled as step
5 describes and the archive `location` in its own include file (the layout the
previous version of this runbook restored incompletely): the three restores plus
`nginx -t` plus reload take about 0.015 s, and both the daemon path and the
archive path are served by `api` again within 0.15 s across ten runs (0.03-0.14 s
of wall time, the spread being nginx's reload window).
Restoring only the site file, by contrast, leaves the archive path on
`api-runtime` while the daemon path is already back on `api` - which is exactly
the half-rolled-back state the per-file table above prevents. The one-minute
budget is therefore dominated by the operator, not by the reload. The full
host-level rehearsal and the formal timing are MUL-463 stage 2.

**Stage B rollback: 1 edit + 2 commands**, in this order.

```bash
# 1. Remove REMI_API_ROLE from $COMPOSE_ENV (back to unset).
# 2. Recreate `api` so it drops the guard (~30 s outage, like a release):
docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" \
  up -d --no-deps api
# 3. Health check, then optionally run the stage A rollback above:
curl -s 127.0.0.1:6120/readyz
```

**Full return to a single process: 2 edits + 5 commands**, on top of the two
rollbacks above, in exactly this order.

```bash
# 1. EDIT /etc/multiremi/platform-updater.env: remove `api-runtime` from
#    MULTIREMI_PLATFORM_CORE_SERVICES, remove MULTIREMI_PLATFORM_EXTRA_HEALTH_URLS,
#    and remove COMPOSE_PROFILES=split.

# 2. Restart the updater FIRST, so its service list no longer names api-runtime.
#    The updater polls continuously and re-creates whatever its list contains on
#    the next release; stopping the container before this step would let a
#    release that lands in the window bring api-runtime straight back.
systemctl --user restart remi-platform-updater

# 3. Stop and DELETE the container while the service is still declared in the
#    host Compose file, so `--profile split` can still address it. `rm -sf`, not
#    `stop` and not bare `rm -f`:
#      - `stop` alone leaves the container in state `exited`, and step 4 removes
#        its service definition, so nothing could ever delete it afterwards;
#      - bare `rm -f` only removes STOPPED containers (see `docker compose rm
#        --help`: `-f/--force` skips the confirmation prompt, `-s/--stop` is the
#        flag that stops a running container first). It would therefore fail on
#        this step, because the container is still running here - step 2 only
#        restarted the updater, it did not stop the runtime;
#      - `rm -sf` stops it if required and then removes it, in one command, with
#        no prompt. That also covers a release that started between the checks.
docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" --profile split \
  rm -sf api-runtime
# If a previous attempt already deleted it, Compose reports no such container;
# verify the end state with the checks below rather than by this exit code.

# 4. Restore the host Compose file, which drops the api-runtime service. Safe
#    now: the updater no longer names it, and the container is gone.
cp "$COMPOSE_DIR/backups/<date>/compose.application.yml.orig" "$COMPOSE_FILE"

# 5. EDIT $COMPOSE_ENV: delete the stage A lines
#    REMI_API_PEER_URL=http://api-runtime:6120 and REMI_API_RUNTIME_BIND_PORT=16121.
#    Delete them by line; do NOT restore the whole backup, which would also roll
#    REMI_API_IMAGE / REMI_WEB_IMAGE back (see "What the updater rewrites").

# 6. Recreate `api` without the peer URL (~30 s outage, like a release):
docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" \
  up -d --no-deps api
```

Confirm the four single-process checks before rolling back the MUL-405 image (or
declaring the return complete). `COMPOSE_PROJECT` is the Compose project name for
this installation: it is `multiremi-platform-app`, from the `name:` key at the
top of `compose.application.yml`. Per the [official project-name precedence](https://docs.docker.com/compose/how-tos/project-name/),
only `-p` or `COMPOSE_PROJECT_NAME` overrides top-level `name:`; the directory
name has lower priority. This runbook passes no `-p` and never sets
`COMPOSE_PROJECT_NAME`, so the `name:` key wins. Confirm no inherited
`COMPOSE_PROJECT_NAME` is set before starting.

```bash
COMPOSE_PROJECT=multiremi-platform-app

# 1. No api-runtime container is left, running or stopped. Scope the query to
#    this Compose project: the service label alone would also match another
#    project on the same host.
docker ps -a --filter label=com.docker.compose.project="$COMPOSE_PROJECT" \
  --filter label=com.docker.compose.service=api-runtime --format '{{.ID}}'
# expected: no output (empty). Any ID here means step 3 did not delete it.
docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" ps -a
# expected: api, ssh-mesh-control-plane, web - no api-runtime row.

# 2. `api` answers on its own, with the default /readyz body (no `role` field):
curl -s 127.0.0.1:6120/readyz

# 3. The `api` container's peer state is OFF. Both "key absent" and "key present
#    but empty" are valid off states; a non-empty value is a failure.
#    - key absent: Full return, because the restored pre-switch Compose file has
#      no MULTIREMI_PEER_URL line at all;
#    - empty value: the intermediate state where only the env lines were deleted
#      but the split Compose file is still in place.
docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
  "$(docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" ps -q api)" \
  | awk -F= '/^MULTIREMI_PEER_URL=/ {print "peer: " ($2 == "" ? "empty" : "SET=" $2); found=1} END {if (!found) print "peer: unset"}'
# expected: exactly one of
#   peer: unset        (key absent - Full return)
#   peer: empty        (key present, empty value - partial revert)
# Anything else is a failure: `peer: SET=<url>` means the peer channel is still
# pointed at a container that should no longer exist.

# 4. Both public server blocks route the daemon surface and the archive path to
#    `api` (see the stage A rollback checks above, including the nginx -t
#    exit-code gate), and:
docker compose --env-file "$COMPOSE_ENV" -f "$COMPOSE_FILE" --profile split \
  config --services | grep -c api-runtime    # 0
```

To restore the previous updater binary instead (only if the updater itself
misbehaves), copy the file back from `bin/pre-<tag>.<rand>/` and restart
`remi-platform-updater`; that is 2 commands and no edit. These commands restore
topology, not database state; any API startup can still run the usage cutover.
Keep the [usage rollback boundary](#usage-accounting-startup-cutover) when choosing
an older image. The pre-check's authentication bookkeeping follows the exception
above.

### Rehearsal checklist (MUL-463 stage 2, non-209)

Rehearse the whole sequence on a non-production host before touching the real
installation, and record these alongside the timings:

- the `remi platform operation list` pre-check output taken before each transition,
  showing `activeOperation: none` and exit code 0 throughout the rehearsal
  window - this is the quiet-window evidence that a queued or in-flight release
  did not interleave with the manual edits;
- the wall-clock start and end of the window used, to show it fell inside
  09:30-11:30 or 15:00-17:00 and outside 04:00 and 07:00;
- the stage A rollback measurement (three restores + `nginx -t` + reload),
  against the one-minute budget;
- the Full return result, including the empty
  `docker ps --filter label=com.docker.compose.project=...` check.

Step 3 of Full return was replayed against a mock Docker Engine with the official
Compose v2.29.7 client: `docker compose --profile split rm -sf api-runtime` issued
`POST /containers/<id>/stop` and then `DELETE /containers/<id>?force=1`, and the
project-scoped query went from one container to empty. The previous `stop` alone
issued no `DELETE` at all and left the container visible, so this check could
never have passed before. `rm -f` without `-s` is not a substitute: Compose only
removes stopped containers, and this one is still running at that point.

Whether the window plus the pre-check is sufficient, or an operation-level mutex
is also needed, is decided from that evidence: the pre-check narrows the race to
"an operation starts between the check and the edit", which the window makes
unlikely but not impossible. If the rehearsal shows a release landing inside that
gap, the follow-up is a mutex (for example a lock file the updater honors), not
a longer window.

## Drain-protected updates (MUL-74)

Update, rollback and restart operations require preflight and drain the platform
before touching running services. `check_updates` only inspects readiness.

Sequence: the updater pulls/stages the release first, then calls
`POST /api/platform-updater/drain/begin` and polls `drain/renew` (which also
renews the lease and returns aggregated progress). Daemons learn about the
drain through their next heartbeat ack, stop claiming new tasks, keep running
tasks and heartbeats alive, and report the acknowledged drain generation plus
their active task count. Only when every online runtime acked the current
generation AND the server and Runtime report zero in-flight/local tasks does the
updater take a backup and prepare the switch. Positive local task counts from a
disconnected Runtime also block the gate. A timer renews the drain during backup;
the updater rechecks it immediately before the API commits the switch, which
also rejects a concurrent cancellation. Preparing/pull/backup failures leave
current services and their configuration untouched.

A durable host journal records the previous release/configuration and verified
backup before committing. After switching, readiness checks must pass before
the result is recorded and scheduling resumes. If verification fails, the driver
restores the old program release locally before reporting through the API. A
failed rollback keeps the operation active and scheduling paused. Restarting the
updater recovers the journal; a recorded successful result is reported again
without restarting services. A pre-commit journal never triggers a restart.

- The drain state lives in the database (`multiremi_platform_maintenance`),
  so an API restart mid-update does not lose it.
- The drain lease has a TTL (default 120 s, renewed every poll). If the
  updater crashes **before switch commit**, it expires and scheduling resumes.
  Once switching/restarting/verifying/rolling_back is committed, maintenance
  stays pinned until verification/recovery and a terminal report. This prevents
  new tasks entering a partially switched deployment. If recovery cannot complete,
  inspect the operation error, journal and backup, repair/verify API and Web, and
  then have the updater finish recovery; never force a release under live tasks.
- The task wait has no deadline by default: `MULTIREMI_PLATFORM_DRAIN_TIMEOUT_MS=0`
  (or unset) waits until existing tasks finish or the operator cancels. New
  tasks remain queued throughout the wait. This does not disable the 120 s
  pre-switch crash-recovery lease above. Human-blocked or stuck tasks still need operator
  attention; cancel the update to resume scheduling without interrupting them.
- Operators can opt into a finite wait with a positive
  `MULTIREMI_PLATFORM_DRAIN_TIMEOUT_MS`. If it expires, the switch is NOT
  executed, the operation fails, and scheduling resumes. There is no automatic
  force-update. An existing positive override is still honored after upgrading.
- Operators can cancel an update from the 版本与服务 page until the switch
  phase begins (`queued/preparing/pulling/draining/backing_up`).
- Old daemons that do not report a drain ack keep the gate closed: upgrade or
  retire them first, cancel the operation, or configure a finite wait.

Daemon-side report outbox: every task-scoped report (messages, prompt,
progress, session pin, usage, workspace, complete/fail) is written to a
durable per-daemon SQLite queue under `~/.multiremi/outbox/` and delivered in
per-task order with bounded exponential backoff. A brief API outage (for
example the update window itself) therefore never terminates a running agent
or strands a task in `running`; permanent auth errors (401/403/410) park the
queue in a `blocked` state with diagnostics instead of retrying forever.
Inspect it via the daemon's local `/health` endpoint (`outbox` block). Size
cap: `MULTIREMI_OUTBOX_MAX_BYTES` (default 256 MB) — oldest non-terminal
records are dropped over the cap; terminal complete/fail events are never
dropped.
