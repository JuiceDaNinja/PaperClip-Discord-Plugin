# JUI-3 — Plugin MCP tools rejected by the host: `structuredContent: null`

Local patch to the **host**, `@paperclipai/server` 2026.1023.0. This is the one
thing in this repository that does not touch `paperclip-plugin-discord`.

## Symptom

Every MCP tool the Discord plugin publishes fails client-side schema validation
before an agent can use it — `discord_signals`, `escalate_to_human`,
`handoff_to_agent`, `discuss_with_agent`, `register_watch`,
`register_custom_command`. The tool itself runs; the host's reply is what gets
rejected:

```json
{"content":[{"type":"text","text":"{\"signals\":[],\"lastScanned\":null}"}],
 "structuredContent":null,"isError":false}
```

Slash commands and interaction cards are **not** affected. Those go Discord →
plugin gateway → host REST and never cross the MCP bridge, which is why
`/clip status` and the question cards work with this bug still live.

## Cause

`@paperclipai/server/dist/routes/tool-gateway.js` emitted the field
unconditionally:

```js
structuredContent: resultRecord?.data ?? null,
```

`ToolResult.data` is **optional** in the plugin SDK contract
(`@paperclipai/plugin-sdk/dist/types.d.ts:114-121`) — `content` is the required
field for a success response. The Discord plugin returns `{ content: "<json>" }`
and never sets `data`; the string `structuredContent` does not appear anywhere
in the plugin package. The `?? null` turns that missing field into an explicit
`null`, and MCP requires `structuredContent` to be a JSON object when the field
is present, so clients reject the response.

The plugin is spec-compliant. The host is not. This hits **any** plugin whose
tools return only `content`, not just this one.

Two observations that rule out the obvious alternative explanation:

- It reproduces on two tools taking different internal paths — `discord_signals`
  (a success return with no `data`) and `register_watch` (a `RUNTIME_NOT_READY`
  error return). Both fail identically, so it is not an empty-result edge case.
- The adjacent line handles string `content` correctly. The host supports these
  plugins and only mishandles this one field.

## The patch

Omit the field unless `data` is a plain object — the same guard the host
already uses at
`dist/vendor/paperclip-runner/drivers/acpx/pi-runtime-extension.js:235`:

```js
function structuredContentField(data) {
    if (!data || typeof data !== "object" || Array.isArray(data))
        return {};
    return { structuredContent: data };
}
```

Applied at both call sites in `dist/routes/tool-gateway.js`: the plugin tool
path, and the context-method path above it, which had the same unguarded shape.

A `!== undefined` check is not enough. The SDK types `data` as `unknown`, so a
plugin returning a string or an array would still produce invalid MCP.

**Not changed:** `dist/services/tool-gateway.js:3959` has a similar `?? null`,
but that one is nested *inside* `data`, so it still yields an object at the MCP
boundary. Cosmetic, not a defect.

## Verification

| Check | Result |
| --- | --- |
| Stock `tool-gateway.js` from the live install vs `npm pack @paperclipai/server@2026.1023.0` | byte-identical (`a408cdc9…`) |
| `patch -p1 --dry-run` against that pristine copy | clean |
| Patched output vs `checksums/host-patched-2026.1023.0.sha256` | `8bff3f9f…`, byte-exact |
| `node --check` on the patched file | OK |
| Helper against 7 input shapes (`undefined`, `null`, object, array, string, number, `{}`) | 7/7 produce MCP-valid output |
| `apply-structuredcontent-fix.sh` run twice | idempotent, second run is a no-op |
| `--revert` with and without a backup present | restores the stock file in both cases |

## Apply it

```sh
bash host-patches/apply-structuredcontent-fix.sh
```

Then **restart the host.** Node holds the old module in memory, so a running
server keeps serving `structuredContent: null` until it is restarted. The
plugin worker is a child of the host process, so this also recycles the Discord
gateway connection — it reconnects on its own.

## Re-run it after every CLI update

The host runs from an npx cache directory whose name is a hash of the CLI spec
(`~/.npm/_npx/43414d9b790239bb` at the time of writing). A version bump installs
into a **new** directory, so this fix silently disappears and the bug comes
back with no error to tell you.

## Worth reporting upstream

The fix belongs in `@paperclipai/server`. Until it lands there,
`host-patches/` is the only thing keeping it alive across updates.
