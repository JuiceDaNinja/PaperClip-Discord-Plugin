/**
 * Lazy company-ID resolver — avoids startup-time API calls that can crash
 * worker activation. The resolved value is cached after the first successful call.
 *
 * Multi-company fix: check `company_default` instance state (written by
 * `/clip connect`) before falling back to list-based resolution. The
 * connected company is NOT cached so that `/clip connect` changes take effect
 * immediately without restarting the plugin.
 */
let _cachedCompanyId = null;
/**
 * PATCH (JUI-4): the company this worker was bound to by its delivered
 * configuration, published by `bootstrapRuntime`.
 *
 * `ctx.companies.list` below is a wildcard read. The host only allows a
 * wildcard from a call it started itself, so the read fails from a Discord
 * slash command and the resolver used to return the literal string "default".
 * No company has that id, so every command then failed. The delivered config
 * already names the right company, so prefer it and never reach the wildcard.
 */
let _boundCompanyId = null;
export function setBoundCompanyId(companyId) {
    _boundCompanyId =
        typeof companyId === "string" && companyId.trim().length > 0
            ? companyId.trim()
            : null;
}
export async function resolveCompanyId(ctx) {
    // Check if a guild-level default was set via /clip connect — always re-read
    // so that switching companies works without a plugin restart.
    try {
        const connected = (await ctx.state.get({ scopeKind: "instance", stateKey: "company_default" }));
        if (connected?.companyId) {
            return connected.companyId;
        }
    }
    catch {
        // state API unavailable at this call site — fall through to list-based resolution
    }
    // PATCH (JUI-4): the configured company, before any wildcard read.
    if (_boundCompanyId)
        return _boundCompanyId;
    if (_cachedCompanyId)
        return _cachedCompanyId;
    try {
        const companies = await ctx.companies.list({ limit: 1 });
        if (companies.length > 0) {
            _cachedCompanyId = companies[0].id;
            return _cachedCompanyId;
        }
    }
    catch (err) {
        ctx.logger.warn("Failed to resolve company ID, falling back to 'default'", { error: String(err) });
    }
    return "default";
}
/** Reset cached company ID (for testing). */
export function _resetCompanyIdCache() {
    _cachedCompanyId = null;
}
//# sourceMappingURL=company-resolver.js.map