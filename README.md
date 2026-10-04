# PaperClip-Discord-Plugin

A patch set for [`paperclip-plugin-discord`](https://github.com/mvanhorn/paperclip-plugin-discord)
**0.11.0** that fixes two things on a self-hosted [Paperclip](https://github.com/paperclipai/paperclip)
instance:

1. **Slash commands work.** Without the patch every `/clip` subcommand answers
   `the worker referenced a missing, expired, or unknown invocation scope`.
2. **Question and approval cards reach Discord.** Without the patch the plugin
   posts task created/completed pings only, so anything that needs a human
   answer never leaves the board.

This is **not a fork**. It is six files that replace or add to the published
package's compiled `dist/` output. You install the plugin from npm as normal,
then run `install.sh`.

> Built and verified against 0.11.0 on 2026-10-04. Check the upstream project
> first — if a later release ships these fixes natively, use that instead.

## Requirements

- A self-hosted Paperclip instance you administer, reachable at
  `http://127.0.0.1:3100` by default.
- Node.js (the version your Paperclip install already needs — 0.11.0's
  dependencies ask for Node 24.11 or newer).
- `paperclip-plugin-discord` at exactly **0.11.0**.
- A Discord application with a bot, already set up per the
  [upstream setup steps](https://github.com/mvanhorn/paperclip-plugin-discord#setup):
  bot token stored as a Paperclip **company secret**, the secret's UUID in
  `discordBotTokenRef`, plus `defaultGuildId` and `defaultChannelId`.
- `bash`, `curl`, `sha256sum`. Linux or macOS.

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

(`bash install.sh` rather than `./install.sh` so it works whether or not the
execute bit survived the clone. `chmod +x install.sh uninstall.sh` if you
prefer.)

`install.sh` finds your plugins directory on its own — it tries `PLUGINS_ROOT`,
then `$PAPERCLIP_HOME/plugins`, then `~/.paperclip/plugins`, then any
`node_modules/paperclip-plugin-discord` under `~/.paperclip`. Override it when
your install is somewhere else:

```sh
PLUGINS_ROOT=/path/to/.paperclip/plugins ./install.sh
```

Before it changes anything the script:

- refuses to run on any version except 0.11.0,
- verifies the clone against `CHECKSUMS.sha256`,
- saves each live file as `<file>.pre-patch`, once, so `uninstall.sh` can put
  back exactly what was there.

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

## Uninstall

```sh
bash uninstall.sh
```

Restores the `.pre-patch` copies, or the untouched upstream files if those are
gone, and removes the added `interaction-cards.js`. Restart the plugin after.

## What the patches change

| Problem | Fix |
| --- | --- |
| Every `/clip` subcommand is denied with `the worker referenced a missing, expired, or unknown invocation scope`. | The Discord gateway socket is opened outside the host invocation scope, so slash commands no longer carry a dead invocation id. Node replays the async context a socket was *created* in, and the socket was being created inside a config delivery that had already finished. |
| The company resolver silently falls back to the literal string `"default"`, which is not a real company id. | It prefers the company bound at bootstrap over the wildcard `ctx.companies.list`, which a gateway event is not allowed to make. |
| Question and approval cards never reach Discord. | Adds a scheduled job that lists pending cards on open tasks and posts each as an embed with buttons, plus handlers so a press answers the card on the board. Free-text answers open a modal. |
| Company-level approvals never update their Discord message after a decision. | The plugin subscribed to `approval.approved` and `approval.rejected`, neither of which exists. The real event is `approval.decided`. |
| The command picker lists every command twice. | No code change — this one is a config mistake on your Discord application. See [`docs/README-discord-duplicate-commands.md`](docs/README-discord-duplicate-commands.md). |

Full write-ups, including the reproduction and the verification output, are in
[`docs/`](docs/).

## Which files are patched

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

## Layout

| Path | What it is |
| --- | --- |
| `patched/` | The six working files. Drop-in replacements for `node_modules/paperclip-plugin-discord/dist/`. |
| `upstream-0.11.0/` | The same five files untouched, as published on npm, plus the package's MIT `LICENSE`. Byte-identical to the registry tarball. |
| `patches/` | The changes as unified diffs, for reading and review. |
| `docs/` | The three write-ups: cause, fix, and verification for each problem. |
| `install.sh`, `uninstall.sh` | Apply and remove the patch set. |
| `examples/plugins-package.json` | A plugins `package.json` pinned to exactly 0.11.0. |
| `CHECKSUMS.sha256` | Confirms a clone matches what was published. |

Verify a clone yourself:

```sh
sha256sum -c CHECKSUMS.sha256
```

## Known limits — read before you rely on this

- **An upgrade wipes it.** This edits files inside a local npm install. Any
  upgrade or reinstall of `paperclip-plugin-discord` overwrites the patch. Pin
  the version, and re-run `install.sh` after any reinstall.
- **It is built against 0.11.0's compiled output and must not be copied onto a
  newer build.** `install.sh` enforces this. On a newer version, re-cut the
  patch from `patches/` — or first check whether upstream now ships these fixes.
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

## Licence

`paperclip-plugin-discord` is MIT licensed. Its licence is kept verbatim at
`LICENSE` and `upstream-0.11.0/LICENSE`, and covers both the upstream code
included here and these modifications of it.
