# Local patch: Discord interaction cards

Paperclip task **JUI-3 — Discord Connection Check**.

## What the patch does

`paperclip-plugin-discord@0.11.0` posts task created/completed pings to Discord, but
it never posts the cards that need a human answer — `ask_user_questions` and
`request_confirmation` on a task. The root cause is upstream: Paperclip's fixed
`PLUGIN_EVENT_TYPES` list has no event for issue-thread interactions, so no plugin
is ever told a card exists.

The patch adds:

- A scheduled job (~every 60s) that lists pending cards on open tasks and posts each
  one to the approvals channel as an embed with Discord components.
- Handlers so a button press calls `respondInteraction` / `accept` / `reject`, then
  rewrites the message with the outcome and drops the buttons. Free-text answers and
  reject reasons open a Discord modal.
- Card kinds Discord components cannot express (suggested tasks, item review) post as
  a notice pointing at the board, so nothing is silently dropped.
- Fix for a separate upstream bug: the plugin subscribed to `approval.approved` and
  `approval.rejected`, neither of which exists. The real event is `approval.decided`,
  so company-level Approvals never updated their Discord message after a decision.

The plugin manifest's capability list is **not** changed. The SDK's
`respondInteraction` needs `issue.interactions.read` and
`issue.interactions.respond`, which this plugin does not declare, so
`interaction-cards.js` calls the board's own REST routes instead — the same
routes the web app uses, with the configured board API key.

Verified end to end on 2026-10-04: a question card was answered from Discord and the
answer landed on the board.

## Files

| Path | What it is |
| --- | --- |
| `patched/` | the patched files, including `interaction-cards.js` |
| `upstream-0.11.0/` | untouched upstream 0.11.0 files |
| `patches/` | the change as unified diffs |
| `install.sh` | apply the patch, or put it back after an upgrade wipes it |
| `uninstall.sh` | restore upstream files |

Restart the plugin after running either script (toggle it off and on in the board, or
POST to `/api/plugins/<PLUGIN_ID>/disable` then `/enable`).

## Important

This edits a local npm install. **Any upgrade or reinstall of the plugin overwrites it.**
After an upgrade, run `install.sh` again. It refuses to run on any version other than
0.11.0, because the patch is built against that build's `dist` output — a newer build
needs the patch re-cut.

## The supported alternative

Paperclip ships its own first-party Discord **chat channel**, separate from this
community plugin. It sends questions and confirmations to Discord with native forms
and survives plugin upgrades. Setting it up needs the same bot token, application ID
and guild ID the plugin already holds. Check whether your instance has it configured
before you reach for this patch. If you switch to it, turn the plugin's
interaction-card setting off so you do not get two cards per question.
