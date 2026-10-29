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

## Agent-addressed cards are posted too

An earlier version of this module skipped any card carrying an `addresseeAgentId`,
on the reading that such a card was that agent's to resolve. That was wrong, and it
cost real decisions: cards were withheld from Discord with no other notification, and
some of them expired unanswered.

`addresseeAgentId` is wake routing — it says which agent was woken to look at the
card. It is not an authorization boundary. The complete set of resolver policies the
host can express is `anyone`, `not_creator` and `human_only` (plus the deprecated
`board_or_agents` / `board_only`); **every one of them admits a board actor**, so
there is no such thing as a pending card a human is not allowed to answer. The board
UI has always shown and accepted these cards.

So every pending card posts, regardless of addressee. Addressed ones carry a line
naming who else was asked — *"Asked of AIDevManager — you can answer it too."* — so
the card does not read as though Discord were the only place it landed. Agent names
are looked up once per poll and best-effort: if that lookup fails the card still
posts, just without the name.

The tradeoff is some new noise. An agent-addressed card now appears in Discord even
when the agent answers it a minute later, so you will see cards flip to
"✅ Answered" shortly after arriving. The poller's existing close-out pass does that
rewrite automatically, so the noise cleans itself up.

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
| `patched/interaction-cards.js` | the new module, shipped whole — it has no upstream counterpart |
| `patches/` | the changes to the five existing files, as unified diffs |
| `checksums/` | sha256 for the upstream 0.11.0 files and for the patched outputs |
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
