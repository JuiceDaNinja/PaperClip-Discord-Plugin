# JUI-4 — duplicate `/clip` and `/acp` commands in the Discord picker

## Symptom

The Discord command picker listed every command twice, e.g. two `/clip status`
entries.

## Cause

Discord scopes application commands two ways:

- **guild** — `PUT /applications/{app}/guilds/{guild}/commands`
- **global** — `PUT /applications/{app}/commands`

The two scopes are independent namespaces. When the same command name exists in
both, Discord shows **both entries** in the picker. It does not deduplicate.

`paperclip-plugin-discord` registers **guild-scoped only**
(`dist/discord-api.js` → `registerSlashCommands`, called from
`dist/worker.js:916` with `defaultGuildId`). A global copy of `/clip` and `/acp`
had been added by hand during this issue, as a workaround for the fact that
kicking a bot from a server deletes that bot's guild commands. That workaround
is what produced the duplicates.

## Fix

Cleared the global scope and left the guild scope alone, so the plugin remains
the single owner of the command set:

```sh
curl -X PUT -H "Authorization: Bot $TOKEN" -H "Content-Type: application/json" \
  -d '[]' https://discord.com/api/v10/applications/<YOUR_APPLICATION_ID>/commands
```

Verified after:

```
global commands : 0
guild commands  : 2   (/clip, /acp — unchanged)
```

## Do not re-register globally

Global registration always duplicates the plugin's guild registration. If the
bot is kicked and re-invited, its guild commands are gone until the plugin
re-registers them — reload the plugin instead of adding a global copy:

```sh
curl -sX POST http://127.0.0.1:3100/api/plugins/<PLUGIN_ID>/disable
curl -sX POST http://127.0.0.1:3100/api/plugins/<PLUGIN_ID>/enable
```

See `README-discord-invocation-scope.md` for why the worker must be reloaded
through the lifecycle and not restarted directly.

## Back up before you clear

`PUT`ing an empty array is not reversible — Discord does not keep the old
definitions. Save them first:

```sh
curl -s -H "Authorization: Bot $TOKEN" \
  https://discord.com/api/v10/applications/<YOUR_APPLICATION_ID>/commands \
  > global-commands-backup.json
```

To put them back, `PUT` that file to the same URL. Doing so re-creates the
duplicates, so only do it if clearing the global scope broke something.

Note that the global scope can also hold leftovers from an unrelated bot that
used the same Discord application earlier. Read the backup before you decide
you want any of it back.

## Client cache

Discord caches the picker per client. Press Ctrl+R in the desktop app to see the
updated list.
