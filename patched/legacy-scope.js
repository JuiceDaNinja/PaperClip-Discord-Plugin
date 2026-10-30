/**
 * Best-effort reads of the legacy `"default"` company scope.
 *
 * Several state helpers in this plugin read their key twice: once under the
 * real company id, and once under the literal scope `"default"` as a
 * backward-compat fallback for records written before the plugin became
 * company-aware.
 *
 * On a governed host that second read is not a miss — it is a refusal:
 *
 *     Plugin is not allowed to perform "state.get": requested company
 *     "default" but the current invocation is scoped to company "276d31f7-…"
 *
 * The refusal throws, and none of the call sites caught it. So an operation
 * whose correctly-scoped read had already succeeded and simply found nothing
 * would die on the compatibility read that followed it. That took down
 * `escalate_to_human`'s pending-escalation tracking and the whole
 * `check-escalation-timeouts` job, with no log line, because the throw
 * escaped past every logging site.
 *
 * A refusal and a miss carry the same information: there is no legacy record
 * here. Treat them the same. Compatibility with old data must never be able to
 * break the current path.
 */
const LEGACY_SCOPE_ID = "default";
let warned = false;
function noteRefused(ctx, stateKey, error) {
    if (warned)
        return;
    warned = true;
    const message = error instanceof Error ? error.message : String(error);
    ctx?.logger?.warn?.("Legacy \"default\"-scope state reads are refused by this host; treating them as empty. Records written before this plugin became company-aware are not readable, which is expected on a governed host.", { stateKey, error: message });
}
/**
 * Read `stateKey` from the legacy `"default"` company scope.
 *
 * Returns `null` both when the key is absent and when the host refuses the
 * read, so callers can use it as a plain fallback value.
 */
export async function readLegacyDefaultScope(ctx, stateKey) {
    try {
        const raw = await ctx.state.get({
            scopeKind: "company",
            scopeId: LEGACY_SCOPE_ID,
            stateKey,
        });
        return raw ?? null;
    }
    catch (error) {
        noteRefused(ctx, stateKey, error);
        return null;
    }
}
/** Reset the one-shot warning. Test seam only. */
export function __resetLegacyScopeWarning() {
    warned = false;
}
