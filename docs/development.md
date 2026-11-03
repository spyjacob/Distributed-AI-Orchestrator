# Development and operations

[Back to the quick start](../README.md)

## Run and test

To run the current checkout directly:

```sh
npm ci
npm run serve
```

After editing server or UI code, restart the server to load it.

Run the tests with:

```sh
npm test
```

The tests start real servers with temporary data and simulated AI and Tailscale
services. They cover distributed sessions, network recovery, and restarts.
They don't need API keys and don't test browser clicks. Push runs them too, so
they stay in the repository.

Main files:

- `server/boot.js` — what launchers start: chooses published code or a test build.
- `server/index.js` — HTTP server and API routes.
- `server/public/` — browser UI for desktop and phone.
- `src/core/` — agents, models, projects, Git, and machine connections.
- `test/e2e/` — end-to-end tests.
- `scripts/` — launchers and setup.

## What goes in this repository

This repository is public and ships only the app: code, tests and these docs.
Reports, audits, reviews, handoffs, prompts and other working notes stay out of
Git. Keep them in `.do-notes/`, which is ignored, along with the usual names for
such files. Sessions that edit The DO are told the same thing.

## Changing The DO: test builds and versions

A DO tab's changes run on its computer as soon as a turn completes them
(`src/core/test-build.js`). The published checkout stays clean and untouched.

1. The tab's files are recorded as a snapshot commit in `<data>/test-build.json`.
2. A test build is the checkout's HEAD plus every recorded snapshot, oldest first,
   merged in a worktree at `.git/harness-builds/<id>`. A tab that conflicts stays out
   and is told why. The build is what the next Push would produce.
3. Changes under `server/public/`, `docs/`, `test/` and Markdown swap in with no
   restart; open pages reload themselves unless someone is in the middle of something,
   and then offer a **Reload** button. Anything else must pass a trial start on a scratch
   port and data folder, then The DO restarts itself once nothing is running.
4. `server/boot.js` starts the build after any restart. If it crashes or does not serve
   within a minute, boot.js drops its tabs from the record, restarts on published code,
   and the tabs say what failed.

A Push or Discard takes a tab off the record. Other computers only see a report, in the
sheet behind the header's version and in `GET /api/harness/versions`: `version.testing` and
the state `Testing 3 unpushed files`. Nothing unpushed reaches another computer.

Limits:

- A computer runs one set of code: every finished DO tab, merged.
- Test builds run against your real sessions and data.
- Dependency changes (`package-lock.json`) cannot load until a Push and a restart.
- `server/boot.js` and `scripts/` run from the checkout, so they change only after a Push.

Only a primary checkout (where `.git` is a folder) runs test builds. Servers started from a
tab worktree or a copy behave as published code, and `npm test` sets
`ORCHESTRATOR_TEST_BUILDS=off`.

**Getting back by hand.** Tap the version in the header, or open `/test-build`, a page that
needs nothing from `app.js`. If a test build's interface fails to load, every page links there
after eight seconds. As a last resort with The DO stopped, delete `test-build.json` from the
data directory. The changes stay in their tabs either way. Discard saves a copy under
`refs/harness/discarded/`.

**Reading what happened.** `GET /api/diagnostics?action=events` records `test-build.applied`
(`swapped` or `restart`), `test-build.rejected`, `test-build.failed`, `test-build.discard` and
`test-build.stop`, joined to the browser's `serving-label`, `test-build` and `ui-reload` traces.
`GET /api/harness/test-build` shows the current record, conflicts and last problem.

**Trying a flow.** `test/e2e/test-build.test.mjs` drives all of this against a real checkout,
remote and restarts, including the failure paths.

**Versions.** `VERSION` holds the release number; the header shows it, with the commit in its
tooltip. Each Push of The DO adds 0.01 right before publishing, so tabs never conflict over
it and a rejected push leaves no number behind. A tab asks for a larger step by committing
`minor` (v1.03 to v1.1) or `major` (v1.03 to v2.0) in `.harness-next-version`, which the
Push uses up.

## Diagnostics

Settings → **Usage history · diagnostics** selects a computer and shows history
size, file count, available disk, effective budget, and dropped/write-failure
counts. Recording, retention, and the budget are local settings. Clear removes
that computer's usage history, not transcripts or project recovery archives.
“Recent history” downloads up to 1,000 events.

The default is 2 GiB (2048 MB) per computer / 14 days, configurable from 4–2048 MB / 1–90 days.
JSONL files rotate at 4 MB or one day. Retention removes expired segments;
the effective budget is capped at 5% of available space plus current trace
storage. Recording suspends below 2 GiB free. These are compact metadata logs,
not video: even 100,000 events at roughly 500 bytes is about 50 MB.
The browser buffers at most 100 events; the server admits at most 1,000 pending
writes. Overload drops telemetry rather than breaking work.

Files live in the server-owned `diagnostics/` directory under its data directory,
outside Git. Coding assistants read them through the local API, not the protected
files:

- `GET /api/diagnostics` — local storage/settings and serving revision.
- `GET /api/diagnostics?action=events` — latest 1,000 events; pass the returned
  `nextBefore` as URL-encoded `before` to page older retained events.
- `GET /api/diagnostics?action=all` — recent history from every reachable host;
  unavailable hosts are marked, never silently substituted.
- Add `host=<member-id>` to inspect an individual host.
- `POST /api/diagnostics` with `action: settings`, `enabled`, `maxMB`, `days`,
  or `action: clear` changes only the selected host.

History includes browser/page IDs, phone/tablet/computer category, viewport,
control identifiers, screen states, connectivity, request/turn timing, HTTP
outcomes, cluster transitions, and observed peer revisions. Correlation IDs
link clicks and ensuing requests across proxies. Ingest timestamps and browser
timestamps are separate; clocks may differ. No text, input values, request
bodies, query strings, credentials, or screenshots are recorded. Events are
best-effort and older history is intentionally evicted. Turn completion records
describe server execution, not delivery to the browser.

Phone history stays on its serving host. Nothing is replicated or uploaded;
the combined endpoint fetches histories on demand. Harness experience reviews are
instructed to read these APIs and distinguish evidence from inference.

Coding sessions are instructed to include tracing for future debugging: what the
user did, what the app showed, and what happened behind the scenes. Logs are for
the coding assistant to read, not extra UI for the user. They should be bounded,
redacted, kept out of Git, and documented so the next session can find them.
Existing apps need tracing added.

## Joining and recovering projects

Joining a network imports the joining computer's project registry and tabs as
one operation, preserving their original owner. Both computers must run
compatible versions. The pre-join history remains archived even if importing
is interrupted.

If projects disappeared after pairing or a replication conflict, open **Projects
& sessions (☰) → recover projects** after updating and restarting every paired computer.
Recovery searches each computer's pre-join/conflict archives and local session
records. Select a project to restore its registry entry and missing tabs; current
records win. Previously deleted projects may appear, so recovery is explicit.
This restores metadata, not deleted files. A project inferred only from a tab
has no recovered launch command; its original computer and folder are still
needed. Unreachable computers and unreadable archives are reported in the sheet.

Join/recovery traces are server-owned at `cluster/project-recovery-trace.json`
under the Harness data directory, outside Git. They retain the last 200 events,
with timestamps, serving revision, host, correlation ID, durations, counts and
outcomes; they omit tokens and transcript content. Read them through
`POST /api/cluster/recovery` with `{"host":"<host-id>","action":"traces"}` rather
than accessing protected data files. Browser `recovery.visible` events identify
loading, results, empty, success and error states; a server commit alone does not
prove screen delivery. Reproduce by creating a local project, joining another host
and checking its project/tab entries; the distributed E2E workflow also restores a
missing project from archives and exercises a failed recovery request.

Project status probes don't attribute a local port or process to another host's
app. The replicated metadata supplies the initial project list even when a
runtime-status refresh fails. Offline ownership is visible, and saved remote chats
stay selectable.

## Sending, queueing, pausing and stopping

Messages have client IDs and are saved before acknowledgement. Duplicate
submissions resolve to their existing acceptance on the session owner. Sending
shows a provisional conversation entry immediately, kept until the matching saved
event arrives; a rejected request restores its draft. Saved events are deduplicated,
and stale HTTP queue replies cannot overwrite newer SSE queue state. Native event
saves drain in order before a turn finishes.

Multiple queued follow-ups run in submission order and appear directly above the composer.
The whole queue collapses; expanded entries scroll within a bounded panel. Edit saves changes on the
owning computer; cancel removes only that pending message. Refresh reconnects
to its server-held state. The queue lives in server memory: a forced shutdown
loses it, and Stop cancels it. If the message has already begun, edit/cancel
returns a conflict rather than modifying the running turn. Diagnostics record
pending-panel visibility and queue edits or cancellation without storing message
text.

Pause stops the running turn at once and holds the queue. Unlike the queue on
its own, a pause is saved on the session record (`session.pause`) together with
the held messages, so it survives a restart: the owning computer reads it back
on the first request for that session, parks the messages again and offers
Resume. An agent-mode pause also writes a resume checkpoint to
`<working folder>/.harness-resume/<session id>.md` — the request, the steps that
ran (and the one the pause cut off), the assistant's latest words, the working
tree and the queued messages. The folder ignores itself, so Push never commits
it. Resume sends a message telling the agent to read that file first and is
recorded as a resume (`event.resume`), so a second pause still names the
original request. A missing checkpoint is rebuilt from the transcript at Resume;
if it cannot be written, Resume carries its text inline. Chat-mode sessions
have no file tools and resume from the transcript alone. Diagnostics record
`turn.paused` (whether the checkpoint and pause were saved), `turn.finished`
with outcome `paused`, `turn.pause-restored` after a restart, and
`turn.resumed` with how the checkpoint was delivered (`file`, `inline` or
`transcript`). A tab cannot move to another computer while paused.

Stop cancels queued messages the way interrupting Claude Code does: the response
returns them (`returned`), the browser that stopped puts their text back in its
message box, and the transcript gets a `Not sent: …` note (`event.unsent`) after
the turn's stop note, so the text survives on every device. Diagnostics record
`turn.stop-requested` (whether a turn was running, paused or idle, and how many
messages were returned) and the browser's `stop` visible state.

Acceptance timing is traced. `turn.started` carries `durationMs` from the send
request to acceptance, and any admission phase that takes 200 ms or more is
recorded as `turn.admission` with `phase` (`network`, `load`, `assets`,
`workspace`, `placement-save`, `config`, `accept-save`). Replica saves wait only
for computers that answered recently, so a sleeping peer doesn't slow every message.

## How a turn ends

How a turn ended is structured on its note: `outcome` is `error`, `interrupted`
or `stopped`, and `reason` names a specific fix (`auth` for a missing or expired
Claude Code login, `model`, `length`). The browser draws a failure below the
reply — never inside the collapsed progress fold — with the sign-in command for
`auth` and Retry (which sends the same text again as a new message; nothing is
replayed automatically) on the latest turn. Session summaries carry the latest
`outcome`, and `/api/state` lists sessions waiting on a question or permission
(`waiting`, for turns running on the serving computer), so the start screen and
session lists show "last turn failed" or "needs your answer" instead of guessing.
The Claude CLI's own `<synthetic>` status lines (e.g. "Not logged in · Please
run /login") are treated as the error they describe, not as the model's reply.

## Push and Merge latest

Push opens the current project chat and records a separate “Push changes” entry,
check/publish progress, and a concise completion or failure reply. The receipt
and commit link remain in the transcript after refreshing. No model request is
needed to report publication; server progress is streamed to connected viewers.

DO's own repository is public, so a tab on it sets a repository-level Git identity
(`Distributed Orchestrator <orchestrator@localhost>`) unless that repository already has
one. Published commits therefore never carry the address in someone's global Git settings.

The chat shows progress as one checklist: a “Push in progress” title, then each
step, ticked when the next one starts. The server saves one `publication: 'pushing'`
note per step and the browser builds the list from those, so older chats read the
same way. The browser traces what it shows as `visible` with screen `push`, outcome
`in-progress`, `published`, `merged`, `failed`, `uncertain`, `follow-up-failed`,
`repairing` or `no-result`, and `count` steps, beside the server's `push.started`
and `push.finished`. Reproduce with a slow `.harness-integration.json` command;
pushing with no checks configured exercises the failure path.

Push and Merge latest first use Git without a model. Merge latest is available in
an isolated tab’s Push panel and brings in the target branch and fetched remote
without publishing or updating the shared checkout. Push repeats those merges
and runs checks before publication. Conflicts or failing configured checks can
use the tab’s configured AI for at most two five-minute repair attempts per
operation. Repairs stay in the tab and must preserve parent history, leave a
clean branch, and pass checks. Check-failure repairs that change package.json,
.harness-integration.json, test/, or tests/ require review instead of publishing.
Network/authentication failures and missing check configuration are reported;
no AI retries credentials or force-pushes. Stop cancels the operation. Repair
progress appears in the current chat and integration.repair diagnostics (without
message content). The server validates results; model claims alone are not proof.

## Claude sessions

The `claude-cli` source runs through the Agent SDK with its Claude Code
system-prompt preset and user/project/local settings sources. It keeps the
configured model, effort, explicit maxTurns and permissionMode. By default it asks
for permission when needed; a configured `bypassPermissions` is an explicit
override. No API key is needed: authentication stays on the execution host.
Custom `bin` paths are passed to the SDK as the executable override. Without
one, sessions run the installed `claude` found on the session PATH (which adds
`~/.local/bin`; `claude.exe` on Windows), the same binary source discovery and
login checks use. Only when none is installed does the SDK's bundled copy run.
`turn.native-context` records which ran as `cli`: `installed`, `bundled` or
`configured`.

`AskUserQuestion` and permission callbacks wait for an authenticated response
through `/api/sessions/:id/interaction`. SSE hello includes the outstanding
request, so reconnecting or viewing from another host does not lose it. Responses
are bound to a request ID, accepted once, and rejected if stale. Stop cancels the
request. Concurrent native requests are presented in order. Waiting for a user
is excluded from stall alarms. Requests are not durable jobs: a host process crash
ends the turn rather than silently granting a pending permission.

The SDK stores its native history locally; DO stores a native session ID and a
transcript fingerprint. Unchanged history resumes only on the same owner, model
alias and working directory. Edited history uses canonical transcript replay.
Push and merge entries (`operation: 'push'`) are DO's own records, so they are
left out of the fingerprint; the resumed prompt starts with a labelled note of
the ones since Claude's last reply. A resumed turn over 120,000 characters of
history still gets the searchable transcript file, worded as a backup for details
compaction dropped.

On a cluster every computer's session list comes from the coordinator, which only
holds its own pending questions. A turn on another computer therefore records
`waitingFor` (`question` or `permission`) in its replicated session while it
waits; it is cleared when answered, when the turn ends and when an orphaned turn
is recovered, and only counts while `turnHost` is set.

A message's model and effort live on its user event as `modelReport`, and the
transcript draws them from nowhere else. Providers fill it in through
`onModelReport`, only from what the provider itself said:

| Provider | Model | Effort |
| --- | --- | --- |
| Claude Code | `message.model` of each main-thread API response, `system/init` before the first one | `get_settings` `applied.effort` (`system/init` `effort` where a host sends it) |
| Codex | `turn_context.model` in its rollout file | `turn_context.effort` in its rollout file |
| Anthropic API, chat completions | response `model` | not echoed, so not reported |
| OpenAI Responses | response `model` | response `reasoning.effort` |

`requestedEffort` and `requestedModel` are DO's settings, kept only to flag a
difference. `turn.model-report` traces each report with its outcome (`reported`,
`effort-differs` or `effort-unreported`), and the browser records what it showed
as the `model-report` visible state. To reproduce: send a message in a Claude or
Codex session, then compare the two traces with the message header.

`turn.started` records provider and requested effort; `interaction.waiting` and
`interaction.finished` share a request correlation ID. The browser records
`provider-request` visible states without questions, command contents or answers.
To reproduce: start a Claude turn requiring a question or permission, reconnect
from another viewer, answer/decline, then repeat and press Stop. Check both the
visible request and the host's interaction outcome. Never infer task completion
from a successful model response alone.

## API model sessions

API turns have no fixed step limit. Provider response limits, explicitly configured
limits, context windows and cancellable tool timeouts still apply. Requested
reasoning is never silently retried as `none`. Provider failures and response
truncation are recorded as errors, not successful task completion.

## Browser behavior

Each browser window remembers its own selected chat across refreshes. Opening a
chat updates the URL’s session parameter and window-local session storage; other
windows cannot change that selection. Host failover carries the current window’s
chat and execution node. Failed opens leave the previous selection intact and
record a transcript `open-failed` event in the existing diagnostics history.
Reproduce by opening different chats in two windows, then refreshing each.

Version display uses host-local cached observations and background peer checks.
Offline peers do not delay the local version response. Stale peer observations
are labelled unverified and cannot verify restart completion. Automatic restart
coordination still performs fresh checks. Opening a conversation renders its
transcript before refreshing the owning computer’s model inventory.

Startup retries state loading and reopening the window's saved chat every three
seconds after a temporary coordinator/network failure. It shows a reconnecting
banner instead of opening Machines settings. These retries only read state; they
never replay Send, Queue or other mutations, and preserve an already open chat.
Diagnostics emit `startup` visible states `waiting`, `ready`, and `error` in the
existing host-local history. Reproduce by opening DO during an election: the
saved chat should reopen once the coordinator is available, without a reload.

The service worker only removes `orchestrator-shell-*` caches left by older
versions. It intercepts no requests and there is no offline shell: server no-store
responses and browser network errors are authoritative.

App layout previews emit `visible` events with screen `preview-phone` or
`preview-desktop` and outcomes `loading`, `resized`, `frame-loaded`, `timeout`,
or `error`. Frame load only confirms navigation, not successful rendering of a
cross-origin app. Reproduce from a running project's layout links, switch sizes,
then open a stopped project's preview to exercise the error path. Events use the
same bounded diagnostics storage and APIs described above.

## Licence

MIT.
