# JUI-4 — Discord slash commands denied by the host

Local patch to `paperclip-plugin-discord` 0.11.0.

## Symptom

Every `/clip` subcommand answered with a host denial, for example:

```
Failed to fetch status: Plugin "<PLUGIN_ID>" is not
allowed to perform "agents.list": the worker referenced a missing, expired, or
unknown invocation scope
```

## Cause 1 — the gateway socket inherits a dead invocation (the blocker)

The host hands configuration to the plugin through `onConfigChanged`, and it
binds that call to a host-issued invocation id kept in an `AsyncLocalStorage`
(`@paperclipai/plugin-sdk/dist/worker-rpc-host.js`, `invocationContextStorage`).

Node keeps the async context a socket was **created** in and replays it on every
later read of that socket. The Discord gateway socket is opened by
`bootstrapRuntime`, which `onConfigChanged` awaits. So the socket was born
inside that invocation, and from then on every gateway event — every slash
command — ran carrying the invocation id of a config delivery that had already
finished.

The host looks that id up in `activeInvocations`
(`@paperclipai/server/dist/services/plugin-worker-manager.js`,
`contextForWorkerMessage`). It is long gone, so the host returns
`invalidInvocationScope: true` and the SDK gate refuses the call with the
message above. Nothing the plugin passed could help: the denial happens before
the company is even considered.

## Cause 2 — the company resolver falls back to the literal string "default"

`company-resolver.js` resolved the company by calling `ctx.companies.list`,
which is a wildcard read. The host only allows a wildcard from a call it
started itself, so from a slash command the read failed and the resolver
returned `"default"`. No company has that id. `/clip connect`, the command meant
to record the right company, used the same blocked wildcard, so it could not fix
it either.

## The patch

**`dist/worker.js`**

- Adds `runOutsideInvocationScope`. Its drain timer is created while the module
  is evaluated, before any invocation exists, so its callbacks always run with
  an empty async context.
- Opens the gateway through it, so the socket and every timer it spawns —
  including the gateway's own reconnects — start clean and carry no invocation
  id. The host then resolves such calls through its proactive path, which admits
  exactly the companies in `plugin_config` and nothing wider.
- Calls `setBoundCompanyId(companyId)` in `bootstrapRuntime`.

**`dist/company-resolver.js`**

- Adds `setBoundCompanyId` and prefers that company over the wildcard
  `ctx.companies.list`. The `/clip connect` instance state is still read first,
  so switching companies keeps working.

## Verification

A harness that wires the real shipped `createHostClientHandlers` gate to a
socket opened inside an invocation that then ends, and reads the invocation id
the gateway event carries:

```
[BEFORE patch: gateway opened inside onConfigChanged]
  invocation id seen on gateway event : inv-config
  agents.list                         : DENIED
  error : Plugin "..." is not allowed to perform "agents.list": the worker
          referenced a missing, expired, or unknown invocation scope

[AFTER patch: gateway opened via runOutsideInvocationScope]
  invocation id seen on gateway event : null
  agents.list                         : OK (1 agents)
```

The before case reproduces the reported error string exactly.

## Known remaining gap

`/clip companies` still issues a wildcard company list. From a gateway event
that call is allowed only while the host has no other invocation in flight, so
it can still fail intermittently. It is not on the path of any other command.
Upstream would need to drop the wildcard for it to be reliable.

## Files

- The change as diffs: `patches/worker.js.patch`,
  `patches/company-resolver.js.patch`
- Apply, or re-apply after a plugin upgrade: `install.sh`. It applies those
  diffs to your installed 0.11.0 files and checks the result against
  `checksums/patched.sha256`. It refuses to run on any version other than
  0.11.0 — re-cut the patch instead.
- Revert to upstream: `uninstall.sh`

`install.sh` saves whatever was in `dist/` before it first ran as
`<file>.pre-patch`, so `uninstall.sh` can go back to that exact state even if
it was not upstream.

## Reloading the plugin

The worker is spawned with an empty bootstrap config and only bootstraps from
`onConfigChanged`, so killing the worker process is **not** enough — it would
come back with no gateway at all. Reload through the lifecycle instead, which
replays the stored config:

```sh
curl -sX POST http://127.0.0.1:3100/api/plugins/<PLUGIN_ID>/disable
curl -sX POST http://127.0.0.1:3100/api/plugins/<PLUGIN_ID>/enable
```
