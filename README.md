# PaperClip-Discord-Plugin

A patch set for [`paperclip-plugin-discord`](https://github.com/mvanhorn/paperclip-plugin-discord)
**0.11.0** that fixes two things on a self-hosted [Paperclip](https://github.com/paperclipai/paperclip)
instance:

1. **Slash commands work.** Without the patch every `/clip` subcommand answers
   `the worker referenced a missing, expired, or unknown invocation scope`.
2. **Question and approval cards reach Discord.** Without the patch the plugin
   posts task created/completed pings only, so anything that needs a human
   answer never leaves the board.

It also carries one separate fix to the **host**, `@paperclipai/server`, without
which no agent can call any of the plugin's MCP tools. That one lives in
[`host-patches/`](host-patches/) and has its own script — see
[Host patch](#host-patch--plugin-mcp-tools) below. It is independent of the
plugin patch set: neither needs the other.

This is **not a fork**, and it does not vendor upstream's code. It is five
diffs plus one new file. `install.sh` takes the 0.11.0 files you already have
from npm, applies the diffs, checks the result against a published sha256, and
only then writes into your install.

> Built and verified against 0.11.0 on 2026-10-04. The host patch was built and
> verified against `@paperclipai/server` 2026.1023.0 on 2026-10-25. Check the
> upstream projects first — if a later release ships these fixes natively, use
> that instead.

## Requirements

- A self-hosted Paperclip instance you administer, reachable at
  `http://127.0.0.1:3100` by default.
- Node.js (the version your Paperclip install already needs — 0.11.0's
  dependencies ask for Node 24.11 or newer), and `npm`.
- `paperclip-plugin-discord` at exactly **0.11.0**.
- A Discord application with a bot, already set up per the
  [upstream setup steps](https://github.com/mvanhorn/paperclip-plugin-discord#setup):
  bot token stored as a Paperclip **company secret**, the secret's UUID in
  `discordBotTokenRef`, plus `defaultGuildId` and `defaultChannelId`.
- `bash`, `patch`, `sha256sum`, `tar`, `curl`. Linux or macOS.

If the plugin is not working for you *before* the patch, fix that first. This
patch set assumes a plugin that is installed, configured, and enabled.

## Install

```sh
git clone https://github.com/JuiceDaNinja/PaperClip-Discord-Plugin.git
cd PaperClip-Discord-Plugin

# Plugin already installed at 0.11.0:
bash install.sh

# Or let the script install the upstream plugin for you first:
bash install.sh --bootstrap
```

`install.sh` finds your plugins directory on its own — it tries `PLUGINS_ROOT`,
then `$PAPERCLIP_HOME/plugins`, then `~/.paperclip/plugins`, then any
`node_modules/paperclip-plugin-discord` under `~/.paperclip`. Override it when
your install is somewhere else:

```sh
PLUGINS_ROOT=/path/to/.paperclip/plugins bash install.sh
```

### What it does, in order

1. Refuses to run on any version except 0.11.0.
2. Collects pristine 0.11.0 files — from the `.pre-patch` backup of an earlier
   run, or your current install, or a fresh `npm pack` download — and checks
   all five against `checksums/upstream-0.11.0.sha256`.
3. Applies `patches/*.patch` in a temporary directory and checks the six
   resulting files against `checksums/patched.sha256`.
4. Only then saves each live file as `<file>.pre-patch`, once, and copies the
   patched files in.

If any check fails it stops and leaves your install untouched.

## Restart the plugin — this step is not optional

**Killing the worker process does not work.** The worker starts with an empty
bootstrap config and only builds its runtime from `onConfigChanged`, so a killed
worker comes back with no Discord gateway at all. Reload through the plugin
lifecycle, which replays the stored config.

Easiest way: toggle the plugin **off and on in the Paperclip board**.

Or by API:

```sh
# find your plugin id
curl -s http://127.0.0.1:3100/api/plugins | grep -o '"id":"[^"]*"'

curl -sX POST http://127.0.0.1:3100/api/plugins/<PLUGIN_ID>/disable
curl -sX POST http://127.0.0.1:3100/api/plugins/<PLUGIN_ID>/enable
```

## Check it worked

- Run `/clip status` in Discord. It should answer with agents instead of the
  invocation-scope error.
- Create a task that asks a question. Within about a minute a card with buttons
  should appear in your approvals channel, and pressing a button should answer
  it on the board.

Both of those work whether or not you apply the host patch below — they go
Discord → plugin gateway → host REST and never cross the MCP bridge.

## Host patch — plugin MCP tools

**This patches Paperclip itself, not the plugin.** It is optional for the two
checks above and required for anything else.

Without it, every MCP tool the plugin publishes fails client-side schema
validation, so no agent can call `discord_signals`, `escalate_to_human`,
`handoff_to_agent`, `discuss_with_agent`, `register_watch` or
`register_custom_command`. `@paperclipai/server` emits
`structuredContent: resultRecord?.data ?? null`, but `ToolResult.data` is
optional in the plugin SDK contract, and MCP requires that field to be a JSON
object when it is present. The plugin is spec-compliant; the host is not. Any
plugin whose tools return only `content` hits this, not just this one.

```sh
bash host-patches/apply-structuredcontent-fix.sh            # patch
bash host-patches/apply-structuredcontent-fix.sh --dry-run  # report only
bash host-patches/apply-structuredcontent-fix.sh --revert   # put the original back
```

The script finds `@paperclipai/server` in your npx cache, verifies the file
against `checksums/host-upstream-2026.1023.0.sha256`, applies the diff, and
checks the result against `checksums/host-patched-2026.1023.0.sha256`. It is
idempotent and it refuses to force a patch that does not apply cleanly. If
`$HOME` is remapped, or the host lives somewhere else:

```sh
NPX_CACHE=/path/to/.npm/_npx  bash host-patches/apply-structuredcontent-fix.sh
SERVER_PKG=/path/to/node_modules/@paperclipai/server \
  bash host-patches/apply-structuredcontent-fix.sh
```

**Restart the host afterwards.** Node holds the old module in memory, so a
running server keeps serving `structuredContent: null` until it restarts. The
plugin worker is a child of the host process, so this recycles the Discord
gateway too — it reconnects on its own.

**Re-run it after every Paperclip CLI update.** The host runs from an npx cache
directory named after a hash of the CLI spec, so a version bump installs into a
*new* directory and the fix disappears with no error to tell you.

Full write-up:
[`docs/README-host-structuredcontent-null.md`](docs/README-host-structuredcontent-null.md).

## Uninstall

```sh
bash uninstall.sh
```

Restores the `.pre-patch` copies and removes the added `interaction-cards.js`.
If the backups are gone it reinstalls 0.11.0 from npm instead. Restart the
plugin after.

`uninstall.sh` only touches the plugin. To undo the host patch as well:

```sh
bash host-patches/apply-structuredcontent-fix.sh --revert
```

## What the patches change

| Problem | Fix |
| --- | --- |
| Every `/clip` subcommand is denied with `the worker referenced a missing, expired, or unknown invocation scope`. | The Discord gateway socket is opened outside the host invocation scope, so slash commands no longer carry a dead invocation id. Node replays the async context a socket was *created* in, and the socket was being created inside a config delivery that had already finished. |
| The company resolver silently falls back to the literal string `"default"`, which is not a real company id. | It prefers the company bound at bootstrap over the wildcard `ctx.companies.list`, which a gateway event is not allowed to make. |
| Question and approval cards never reach Discord. | Adds a scheduled job that lists pending cards on open tasks and posts each as an embed with buttons, plus handlers so a press answers the card on the board. Free-text answers open a modal. |
| Company-level approvals never update their Discord message after a decision. | The plugin subscribed to `approval.approved` and `approval.rejected`, neither of which exists. The real event is `approval.decided`. |
| The command picker lists every command twice. | No code change — this one is a config mistake on your Discord application. See [`docs/README-discord-duplicate-commands.md`](docs/README-discord-duplicate-commands.md). |
| **Host, not plugin:** every plugin MCP tool call is rejected by the client with `structuredContent: null`. | The host emitted the field unconditionally from an optional SDK field. Omit it unless the value is a plain object. Applied by `host-patches/apply-structuredcontent-fix.sh`, not by `install.sh`. |

Full write-ups, including the reproduction and the verification output, are in
[`docs/`](docs/).

## Which files change

Against upstream 0.11.0:

```
dist/worker.js             134 changed lines
dist/company-resolver.js    20 changed lines
dist/manifest.js            12 changed lines
dist/commands.js            11 changed lines
dist/constants.js            1 changed line
dist/interaction-cards.js   new file, 777 lines
```

Nothing else in the package is modified.

The host patch is separate, and against `@paperclipai/server` 2026.1023.0 it
touches one file:

```
dist/routes/tool-gateway.js   2 changed lines, 8 added
```

## Layout

| Path | What it is |
| --- | --- |
| `patches/` | The five changes as unified diffs. Readable, reviewable, and what `install.sh` actually applies. |
| `patched/interaction-cards.js` | The one new module. It has no upstream counterpart, so it ships whole. |
| `host-patches/` | The one patch to Paperclip itself, plus its own apply/revert script. `install.sh` does not touch it. |
| `checksums/` | sha256 for the upstream 0.11.0 files and for the six patched outputs, plus the `host-*` pair for the host file. |
| `docs/` | The write-ups: cause, fix, and verification for each problem. |
| `install.sh`, `uninstall.sh` | Apply and remove the patch set. |
| `examples/plugins-package.json` | A plugins `package.json` pinned to exactly 0.11.0. |

Upstream's compiled output is deliberately **not** copied into this repository.
`install.sh` gets it from npm, where it is published, and verifies its hashes —
so there is one source of truth for upstream's code, and it is not this repo.

## Known limits — read before you rely on this

- **An upgrade wipes it.** This edits files inside a local npm install. Any
  upgrade or reinstall of `paperclip-plugin-discord` overwrites the patch. Pin
  the version, and re-run `install.sh` after any reinstall.
- **The diffs are cut against 0.11.0's compiled output.** They will not apply to
  a different build, and `install.sh` refuses to try. On a newer version, re-cut
  them — or first check whether upstream now ships these fixes.
- **A Paperclip CLI update wipes the host patch too, and more quietly.** The
  host runs from an npx cache directory named after a hash of the CLI spec, so
  a version bump installs into a *new* directory. Nothing fails loudly; the
  plugin's MCP tools just stop working again. Re-run
  `host-patches/apply-structuredcontent-fix.sh` after every update.
- **`/clip companies` is still unreliable.** It issues a wildcard company list,
  which from a gateway event only succeeds while the host has no other
  invocation in flight. No other command depends on it. Fixing it needs an
  upstream change.
- **Paperclip has a first-party Discord chat channel** that handles questions
  and confirmations natively and survives upgrades. It needs the same bot
  token, application id and guild id. If your instance supports it, prefer it.
  If you run both, turn the plugin's interaction-card setting off or you will
  get two cards per question.
- **Not affiliated with the upstream plugin or with Paperclip.** No warranty.
  Patching a package inside `node_modules` is a workaround, not a supported
  deployment. Back up before you run it.

## Contributing

If you confirm these fixes against a different Paperclip or plugin version,
open an issue saying which versions and what happened — that is the most useful
thing anyone can add here. The ideal outcome is that these land upstream and
this repository stops being needed.

## License & Attribution

This project is based on
[paperclip-plugin-discord](https://github.com/mvanhorn/paperclip-plugin-discord)
by Matt Van Horn.

The original project is licensed under the MIT License.

Copyright (c) 2026 Matt Van Horn

The original MIT license is preserved in the `LICENSE` file.

Modifications and patches made by this project are also distributed
under the MIT License.
