/**
 * Issue-thread interaction cards in Discord.
 *
 * Paperclip's question and approval cards (`ask_user_questions`,
 * `request_confirmation`, `request_checkbox_confirmation`) are issue-thread
 * interactions. The host broadcasts no plugin event for them — PLUGIN_EVENT_TYPES
 * has no `issue.interaction.*` member — so there is nothing for the worker to
 * subscribe to. This module polls the board on a schedule instead, posts each
 * pending card to the approvals channel with interactive components, and routes
 * a component press back to the board's accept / reject / respond routes.
 *
 * Why the board routes and not `ctx.issues.*`: the SDK's `respondInteraction`
 * only does accept/reject, so it cannot answer a question card at all, and the
 * `issue.interactions.read` / `issue.interactions.respond` capabilities are not
 * in this plugin's manifest. `paperclipFetch` reaches the same routes the web app
 * uses, and in a `local_trusted` deployment those requests are promoted to a
 * board actor — the only actor a `human_only` card will accept. In an
 * `authenticated` deployment, set the Paperclip Board API Key so the same calls
 * satisfy board auth.
 */
import { COLORS, METRIC_NAMES } from "./constants.js";
import { paperclipFetch } from "./paperclip-fetch.js";
import { withRetry } from "./retry.js";
const COMPONENT_PREFIX = "pci|";
const MODAL_PREFIX = "pcim|";
/** Statuses whose issues can still hold a card a human has to resolve. */
const OPEN_ISSUE_STATUSES = new Set([
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "blocked",
]);
/** Kinds this surface can fully resolve. Everything else posts as a notice. */
const ACTIONABLE_KINDS = new Set([
    "ask_user_questions",
    "request_confirmation",
    "request_checkbox_confirmation",
]);
const ISSUE_PAGE_LIMIT = 100;
const ISSUE_SCAN_LIMIT = 40;
const TRACKED_CARD_LIMIT = 200;
/** Five action rows per message; one is reserved for the submit controls. */
const MAX_SELECT_ROWS = 4;
const MAX_SELECT_OPTIONS = 25;
const MAX_MODAL_INPUTS = 5;
const INDEX_STATE_KEY = "pci_index";
function cardStateKey(interactionId) {
    return `pci_card_${interactionId}`;
}
function selectionStateKey(interactionId) {
    return `pci_sel_${interactionId}`;
}
function truncate(value, max) {
    const text = String(value ?? "");
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function readState(ctx, stateKey) {
    return ctx.state.get({ scopeKind: "instance", stateKey });
}
function writeState(ctx, stateKey, value) {
    return ctx.state.set({ scopeKind: "instance", stateKey }, value);
}
function clearState(ctx, stateKey) {
    return ctx.state.delete({ scopeKind: "instance", stateKey });
}
async function boardJson(base, apiKey, path, init) {
    const response = await withRetry(() => paperclipFetch(`${base}${path}`, init, apiKey));
    if (response.status === 204)
        return null;
    return response.json();
}
function errorMessage(error) {
    if (!(error instanceof Error))
        return String(error);
    // PaperclipFetchError embeds the JSON body; surface the server's own wording
    // rather than the whole request line.
    const match = /\{"error":"((?:[^"\\]|\\.)*)"/.exec(error.message);
    if (match) {
        try {
            return JSON.parse(`"${match[1]}"`);
        }
        catch {
            return match[1];
        }
    }
    return error.message;
}
// ---------------------------------------------------------------------------
// Card rendering
// ---------------------------------------------------------------------------
function issueLabel(card) {
    const identifier = card.issueIdentifier ? `${card.issueIdentifier} · ` : "";
    return truncate(`${identifier}${card.issueTitle ?? "Task"}`, 240);
}
function kindLabel(kind) {
    if (kind === "ask_user_questions")
        return "Question";
    if (kind === "request_confirmation")
        return "Approval";
    if (kind === "request_checkbox_confirmation")
        return "Approval";
    if (kind === "suggest_tasks")
        return "Suggested tasks";
    if (kind === "request_item_verdicts")
        return "Item review";
    if (kind === "connection_intent")
        return "Connection request";
    return kind;
}
function selectableQuestions(interaction) {
    const questions = interaction.payload?.questions ?? [];
    return questions
        .map((question, index) => ({ question, index }))
        .filter((entry) => (entry.question.options ?? []).length > 0);
}
function freeTextQuestions(interaction) {
    const questions = interaction.payload?.questions ?? [];
    return questions
        .map((question, index) => ({ question, index }))
        .filter((entry) => (entry.question.options ?? []).length === 0 ||
        entry.question.allowOther !== false ||
        (entry.question.options ?? []).some((option) => option.freeText === true))
        .slice(0, MAX_MODAL_INPUTS);
}
function answerSummary(question, answer) {
    const parts = [];
    for (const optionId of answer?.optionIds ?? []) {
        const option = (question.options ?? []).find((candidate) => candidate.id === optionId);
        parts.push(option ? option.label : optionId);
    }
    if (answer?.otherText)
        parts.push(`"${answer.otherText}"`);
    return parts.join(", ");
}
function buildQuestionCard(interaction, card, selections) {
    const payload = interaction.payload ?? {};
    const questions = payload.questions ?? [];
    const selectable = selectableQuestions(interaction);
    const fields = questions.map((question, index) => {
        const answer = selections[question.id];
        const chosen = answerSummary(question, answer);
        const options = (question.options ?? [])
            .map((option) => `• ${option.label}`)
            .join("\n");
        const lines = [options || "_Free text answer_"];
        lines.push(chosen ? `**Your answer:** ${chosen}` : "**Your answer:** _none yet_");
        return {
            name: truncate(`${index + 1}. ${question.prompt}${question.required ? " *" : ""}`, 256),
            value: truncate(lines.join("\n"), 1024),
        };
    });
    const overflow = selectable.length > MAX_SELECT_ROWS;
    const descriptionLines = [issueLabel(card)];
    if (interaction.summary)
        descriptionLines.push(truncate(interaction.summary, 500));
    if (overflow) {
        descriptionLines.push(`⚠️ ${selectable.length} multiple-choice questions is more than Discord can show at once. Answer this one on the Paperclip board.`);
    }
    const embed = {
        title: truncate(interaction.title ?? payload.title ?? "A question needs your answer", 256),
        description: truncate(descriptionLines.join("\n"), 2000),
        color: COLORS.BLUE,
        fields: fields.slice(0, 25),
        footer: { text: `Paperclip · ${kindLabel(interaction.kind)}` },
        timestamp: new Date().toISOString(),
    };
    if (overflow)
        return { embeds: [embed], components: [] };
    const components = [];
    for (const { question, index } of selectable.slice(0, MAX_SELECT_ROWS)) {
        const options = (question.options ?? []).slice(0, MAX_SELECT_OPTIONS);
        const selected = selections[question.id]?.optionIds ?? [];
        components.push({
            type: 1,
            components: [
                {
                    type: 3,
                    // Option ids can run to 160 characters; Discord caps a component
                    // value at 100. Carry the option's index and map it back from the
                    // live payload instead.
                    custom_id: `${COMPONENT_PREFIX}q|${interaction.id}|${index}`,
                    placeholder: truncate(question.prompt, 150),
                    min_values: 0,
                    max_values: question.selectionMode === "multi" ? options.length : 1,
                    options: options.map((option, optionIndex) => ({
                        label: truncate(option.label, 100),
                        value: String(optionIndex),
                        ...(option.description
                            ? { description: truncate(option.description, 100) }
                            : {}),
                        default: selected.includes(option.id),
                    })),
                },
            ],
        });
    }
    const controls = [
        {
            type: 2,
            style: 1,
            label: truncate(payload.submitLabel ?? "Submit answer", 80),
            custom_id: `${COMPONENT_PREFIX}sub|${interaction.id}`,
        },
    ];
    if (freeTextQuestions(interaction).length > 0) {
        controls.push({
            type: 2,
            style: 2,
            label: "Type an answer",
            custom_id: `${COMPONENT_PREFIX}txt|${interaction.id}`,
        });
    }
    components.push({ type: 1, components: controls });
    return { embeds: [embed], components };
}
function buildConfirmationCard(interaction, card, selections) {
    const payload = interaction.payload ?? {};
    const fields = [];
    if (payload.detailsMarkdown) {
        fields.push({
            name: "Details",
            value: truncate(payload.detailsMarkdown, 1024),
        });
    }
    const embed = {
        title: truncate(interaction.title ?? "Approval needed", 256),
        description: truncate([issueLabel(card), payload.prompt ?? ""].filter(Boolean).join("\n\n"), 2000),
        color: COLORS.YELLOW,
        fields,
        footer: { text: `Paperclip · ${kindLabel(interaction.kind)}` },
        timestamp: new Date().toISOString(),
    };
    const components = [];
    if (interaction.kind === "request_checkbox_confirmation") {
        const options = (payload.options ?? []).slice(0, MAX_SELECT_OPTIONS);
        const selected = selections.__checkbox?.optionIds ?? payload.defaultSelectedOptionIds ?? [];
        if (options.length > 0) {
            components.push({
                type: 1,
                components: [
                    {
                        type: 3,
                        custom_id: `${COMPONENT_PREFIX}cb|${interaction.id}`,
                        placeholder: "Choose what to include",
                        min_values: Math.min(payload.minSelected ?? 0, options.length),
                        max_values: Math.min(payload.maxSelected ?? options.length, options.length),
                        options: options.map((option, optionIndex) => ({
                            label: truncate(option.label, 100),
                            value: String(optionIndex),
                            ...(option.description
                                ? { description: truncate(option.description, 100) }
                                : {}),
                            default: selected.includes(option.id),
                        })),
                    },
                ],
            });
        }
    }
    components.push({
        type: 1,
        components: [
            {
                type: 2,
                style: 3,
                label: truncate(payload.acceptLabel ?? "Approve", 80),
                custom_id: `${COMPONENT_PREFIX}ok|${interaction.id}`,
            },
            {
                type: 2,
                style: 4,
                label: truncate(payload.rejectLabel ?? "Reject", 80),
                custom_id: `${COMPONENT_PREFIX}no|${interaction.id}`,
            },
        ],
    });
    return { embeds: [embed], components };
}
function buildNoticeCard(interaction, card) {
    const payload = interaction.payload ?? {};
    return {
        embeds: [
            {
                title: truncate(interaction.title ?? `${kindLabel(interaction.kind)} waiting for you`, 256),
                description: truncate([
                    issueLabel(card),
                    payload.prompt ?? interaction.summary ?? "",
                    "This card type can only be resolved on the Paperclip board.",
                ]
                    .filter(Boolean)
                    .join("\n\n"), 2000),
                color: COLORS.GRAY,
                footer: { text: `Paperclip · ${kindLabel(interaction.kind)}` },
                timestamp: new Date().toISOString(),
            },
        ],
        components: [],
    };
}
function buildCard(interaction, card, selections) {
    if (interaction.kind === "ask_user_questions")
        return buildQuestionCard(interaction, card, selections);
    if (interaction.kind === "request_confirmation" ||
        interaction.kind === "request_checkbox_confirmation") {
        return buildConfirmationCard(interaction, card, selections);
    }
    return buildNoticeCard(interaction, card);
}
const RESOLVED_LABELS = {
    accepted: { title: "✅ Approved", color: COLORS.GREEN },
    answered: { title: "✅ Answered", color: COLORS.GREEN },
    rejected: { title: "❌ Rejected", color: COLORS.RED },
    cancelled: { title: "⚪ Cancelled", color: COLORS.GRAY },
    expired: { title: "⚪ Expired", color: COLORS.GRAY },
    failed: { title: "⚠️ Failed", color: COLORS.ORANGE },
};
function buildResolvedCard(interaction, card, actor) {
    const label = RESOLVED_LABELS[interaction.status] ?? {
        title: `Resolved — ${interaction.status}`,
        color: COLORS.GRAY,
    };
    const lines = [issueLabel(card)];
    if (interaction.title)
        lines.push(truncate(interaction.title, 300));
    const answers = interaction.result?.answers ?? [];
    const questions = interaction.payload?.questions ?? [];
    for (const answer of answers) {
        const question = questions.find((candidate) => candidate.id === answer.questionId);
        if (!question)
            continue;
        lines.push(`**${truncate(question.prompt, 120)}** → ${truncate(answerSummary(question, answer) || "—", 300)}`);
    }
    if (interaction.result?.reason)
        lines.push(`Reason: ${truncate(interaction.result.reason, 300)}`);
    lines.push(actor ? `Resolved from Discord by ${actor}` : "Resolved on the Paperclip board");
    return {
        embeds: [
            {
                title: label.title,
                description: truncate(lines.join("\n"), 2000),
                color: label.color,
                footer: { text: `Paperclip · ${kindLabel(interaction.kind)}` },
                timestamp: new Date().toISOString(),
            },
        ],
        components: [],
    };
}
function failureResponse(title, detail) {
    return {
        type: 4,
        data: {
            embeds: [
                {
                    title,
                    description: truncate(detail, 2000),
                    color: COLORS.RED,
                    footer: { text: "Paperclip" },
                    timestamp: new Date().toISOString(),
                },
            ],
            flags: 64,
        },
    };
}
// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------
async function readIndex(ctx) {
    const stored = await readState(ctx, INDEX_STATE_KEY);
    return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
}
async function trackCard(ctx, card) {
    await writeState(ctx, cardStateKey(card.interactionId), card);
    const index = await readIndex(ctx);
    const next = [card.interactionId, ...index.filter((id) => id !== card.interactionId)];
    const dropped = next.slice(TRACKED_CARD_LIMIT);
    for (const id of dropped) {
        await clearState(ctx, cardStateKey(id));
        await clearState(ctx, selectionStateKey(id));
    }
    await writeState(ctx, INDEX_STATE_KEY, next.slice(0, TRACKED_CARD_LIMIT));
}
async function untrackCard(ctx, interactionId) {
    await clearState(ctx, cardStateKey(interactionId));
    await clearState(ctx, selectionStateKey(interactionId));
    const index = await readIndex(ctx);
    await writeState(ctx, INDEX_STATE_KEY, index.filter((id) => id !== interactionId));
}
async function readSelections(ctx, interactionId) {
    const stored = await readState(ctx, selectionStateKey(interactionId));
    return stored && typeof stored === "object" ? stored : {};
}
// ---------------------------------------------------------------------------
// Poll job
// ---------------------------------------------------------------------------
/**
 * Post newly pending interaction cards and close out tracked cards that were
 * resolved elsewhere (on the board, or by another surface).
 */
export async function syncInteractionCards(ctx, rt, resolveChannel) {
    const companyId = rt.companyId;
    if (!companyId)
        return;
    const base = rt.baseUrl;
    const apiKey = rt.paperclipBoardApiKey ?? "";
    const channelId = await resolveChannel(ctx, companyId, rt.approvalsChannelId ?? rt.defaultChannelId, rt.config?.approvalsChannels);
    if (!channelId) {
        ctx.logger.debug("No Discord channel resolved for interaction cards", { companyId });
        return;
    }
    let issues;
    try {
        issues = (await boardJson(base, apiKey, `/api/companies/${companyId}/issues?view=compact&limit=${ISSUE_PAGE_LIMIT}`));
    }
    catch (error) {
        ctx.logger.warn("Could not list issues for interaction cards", {
            companyId,
            error: errorMessage(error),
        });
        return;
    }
    const open = (Array.isArray(issues) ? issues : [])
        .filter((issue) => OPEN_ISSUE_STATUSES.has(String(issue.status)))
        .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
        .slice(0, ISSUE_SCAN_LIMIT);
    const seenPending = new Set();
    for (const issue of open) {
        let interactions;
        try {
            interactions = (await boardJson(base, apiKey, `/api/issues/${issue.id}/interactions`));
        }
        catch (error) {
            ctx.logger.debug("Could not list interactions for issue", {
                issueId: issue.id,
                error: errorMessage(error),
            });
            continue;
        }
        for (const interaction of Array.isArray(interactions) ? interactions : []) {
            if (interaction.status !== "pending")
                continue;
            // A card addressed to a specific agent is that agent's to resolve.
            if (interaction.addresseeAgentId)
                continue;
            seenPending.add(interaction.id);
            const existing = (await readState(ctx, cardStateKey(interaction.id)));
            if (existing?.messageId)
                continue;
            const card = {
                interactionId: interaction.id,
                issueId: issue.id,
                companyId,
                channelId,
                messageId: "",
                kind: interaction.kind,
                issueIdentifier: issue.identifier ?? null,
                issueTitle: issue.title ?? null,
                postedAt: new Date().toISOString(),
            };
            const { embeds, components } = buildCard(interaction, card, {});
            const messageId = await rt.adapter.sendButtons(channelId, embeds, components);
            if (!messageId) {
                ctx.logger.warn("Could not post interaction card to Discord", {
                    interactionId: interaction.id,
                    channelId,
                });
                continue;
            }
            card.messageId = messageId;
            await trackCard(ctx, card);
            ctx.logger.info("Posted interaction card to Discord", {
                interactionId: interaction.id,
                kind: interaction.kind,
                issueId: issue.id,
                actionable: ACTIONABLE_KINDS.has(interaction.kind),
            });
        }
    }
    // Close out cards resolved somewhere other than Discord.
    for (const interactionId of await readIndex(ctx)) {
        if (seenPending.has(interactionId))
            continue;
        const card = (await readState(ctx, cardStateKey(interactionId)));
        if (!card?.messageId) {
            await untrackCard(ctx, interactionId);
            continue;
        }
        let interaction = null;
        try {
            const interactions = (await boardJson(base, apiKey, `/api/issues/${card.issueId}/interactions`));
            interaction =
                (Array.isArray(interactions) ? interactions : []).find((candidate) => candidate.id === interactionId) ?? null;
        }
        catch (error) {
            ctx.logger.debug("Could not refresh interaction for card close-out", {
                interactionId,
                error: errorMessage(error),
            });
            continue;
        }
        if (interaction?.status === "pending")
            continue;
        if (interaction) {
            const { embeds, components } = buildResolvedCard(interaction, card, null);
            await rt.adapter.editMessage(card.channelId, card.messageId, { embeds, components });
        }
        await untrackCard(ctx, interactionId);
    }
}
// ---------------------------------------------------------------------------
// Component and modal routing
// ---------------------------------------------------------------------------
export function isInteractionCardComponentId(customId) {
    return typeof customId === "string" && customId.startsWith(COMPONENT_PREFIX);
}
export function isInteractionCardModalId(customId) {
    return typeof customId === "string" && customId.startsWith(MODAL_PREFIX);
}
async function loadLiveInteraction(base, apiKey, card) {
    const interactions = (await boardJson(base, apiKey, `/api/issues/${card.issueId}/interactions`));
    return ((Array.isArray(interactions) ? interactions : []).find((candidate) => candidate.id === card.interactionId) ?? null);
}
function buildAnswers(interaction, selections) {
    const questions = interaction.payload?.questions ?? [];
    const answers = [];
    for (const question of questions) {
        const selection = selections[question.id];
        if (!selection)
            continue;
        const optionIds = selection.optionIds ?? [];
        const otherText = selection.otherText?.trim() ?? "";
        if (optionIds.length === 0 && !otherText)
            continue;
        answers.push({
            questionId: question.id,
            optionIds,
            ...(otherText ? { otherText } : {}),
        });
    }
    return answers;
}
function missingRequired(interaction, answers) {
    const answered = new Set(answers.map((answer) => answer.questionId));
    return (interaction.payload?.questions ?? [])
        .filter((question) => question.required && !answered.has(question.id))
        .map((question) => question.prompt);
}
function answersModal(interaction, selections) {
    const entries = freeTextQuestions(interaction);
    if (entries.length === 0)
        return null;
    return {
        type: 9,
        data: {
            custom_id: `${MODAL_PREFIX}a|${interaction.id}`,
            title: truncate(interaction.title ?? "Type your answer", 45),
            components: entries.map(({ question, index }) => ({
                type: 1,
                components: [
                    {
                        type: 4,
                        custom_id: `q${index}`,
                        label: truncate(question.prompt, 45),
                        style: 2,
                        required: false,
                        max_length: 1000,
                        value: truncate(selections[question.id]?.otherText ?? "", 1000),
                    },
                ],
            })),
        },
    };
}
function rejectReasonModal(interaction) {
    const payload = interaction.payload ?? {};
    return {
        type: 9,
        data: {
            custom_id: `${MODAL_PREFIX}r|${interaction.id}`,
            title: truncate(payload.rejectLabel ?? "Reject", 45),
            components: [
                {
                    type: 1,
                    components: [
                        {
                            type: 4,
                            custom_id: "reason",
                            label: truncate(payload.rejectReasonLabel ?? "Why are you rejecting this?", 45),
                            style: 2,
                            required: true,
                            max_length: 1000,
                        },
                    ],
                },
            ],
        },
    };
}
async function submitAnswers(ctx, base, apiKey, card, interaction, selections, actor) {
    const answers = buildAnswers(interaction, selections);
    const missing = missingRequired(interaction, answers);
    if (missing.length > 0) {
        return failureResponse("Answer still incomplete", `These questions are required:\n${missing
            .map((prompt) => `• ${truncate(prompt, 200)}`)
            .join("\n")}`);
    }
    const resolved = (await boardJson(base, apiKey, `/api/issues/${card.issueId}/interactions/${card.interactionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            answers,
            summaryMarkdown: `Answered from Discord by ${actor}.`,
        }),
    }));
    await untrackCard(ctx, card.interactionId);
    return { type: 7, data: buildResolvedCard(resolved, card, actor) };
}
async function resolveConfirmation(ctx, base, apiKey, card, interaction, selections, actor, action, reason) {
    const body = action === "accept"
        ? interaction.kind === "request_checkbox_confirmation"
            ? { selectedOptionIds: selections.__checkbox?.optionIds ?? [] }
            : {}
        : { reason: reason ?? `Rejected from Discord by ${actor}.` };
    const resolved = (await boardJson(base, apiKey, `/api/issues/${card.issueId}/interactions/${card.interactionId}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }));
    await ctx.metrics.write(METRIC_NAMES.approvalsDecided, 1);
    await untrackCard(ctx, card.interactionId);
    // `accept` returns { interaction, createdIssues }; `reject` returns the row.
    const settled = resolved?.interaction ?? resolved;
    return { type: 7, data: buildResolvedCard(settled, card, actor) };
}
/** Route a button or select-menu press on an interaction card. */
export async function handleInteractionCardComponent(ctx, data, actor, cmdCtx) {
    const customId = String(data.custom_id ?? "");
    const [, op, interactionId, extra] = customId.split("|");
    const base = cmdCtx?.baseUrl ?? "http://localhost:3100";
    const apiKey = cmdCtx?.paperclipBoardApiKey ?? "";
    const card = (await readState(ctx, cardStateKey(interactionId)));
    if (!card?.issueId) {
        return failureResponse("Card no longer tracked", "This card is older than the plugin's tracking window. Open it on the Paperclip board.");
    }
    try {
        const interaction = await loadLiveInteraction(base, apiKey, card);
        if (!interaction) {
            await untrackCard(ctx, interactionId);
            return failureResponse("Card not found", "Paperclip no longer has this card.");
        }
        if (interaction.status !== "pending") {
            await untrackCard(ctx, interactionId);
            return { type: 7, data: buildResolvedCard(interaction, card, null) };
        }
        const selections = await readSelections(ctx, interactionId);
        if (op === "q") {
            const questionIndex = Number(extra);
            const question = (interaction.payload?.questions ?? [])[questionIndex];
            if (!question)
                return failureResponse("Question changed", "This question no longer exists on the card. Reload it on the board.");
            const options = question.options ?? [];
            const picked = (data.values ?? [])
                .map((value) => options[Number(value)]?.id)
                .filter((id) => typeof id === "string");
            selections[question.id] = {
                optionIds: picked,
                otherText: selections[question.id]?.otherText,
            };
            await writeState(ctx, selectionStateKey(interactionId), selections);
            return { type: 7, data: buildCard(interaction, card, selections) };
        }
        if (op === "cb") {
            const options = interaction.payload?.options ?? [];
            const picked = (data.values ?? [])
                .map((value) => options[Number(value)]?.id)
                .filter((id) => typeof id === "string");
            selections.__checkbox = { optionIds: picked };
            await writeState(ctx, selectionStateKey(interactionId), selections);
            return { type: 7, data: buildCard(interaction, card, selections) };
        }
        if (op === "txt") {
            const modal = answersModal(interaction, selections);
            if (!modal)
                return failureResponse("No free-text answer here", "Every question on this card is multiple choice.");
            return modal;
        }
        if (op === "sub") {
            return await submitAnswers(ctx, base, apiKey, card, interaction, selections, actor);
        }
        if (op === "ok") {
            return await resolveConfirmation(ctx, base, apiKey, card, interaction, selections, actor, "accept");
        }
        if (op === "no") {
            if (interaction.payload?.rejectRequiresReason === true) {
                return rejectReasonModal(interaction);
            }
            return await resolveConfirmation(ctx, base, apiKey, card, interaction, selections, actor, "reject");
        }
        return failureResponse("Unknown action", `This plugin build does not handle "${truncate(op ?? "", 40)}".`);
    }
    catch (error) {
        ctx.logger.error("Interaction card action failed", {
            interactionId,
            op,
            error: errorMessage(error),
        });
        return failureResponse("Paperclip rejected that", errorMessage(error));
    }
}
function modalValues(data) {
    const values = {};
    for (const row of data.components ?? []) {
        for (const component of row.components ?? []) {
            if (typeof component?.custom_id === "string") {
                values[component.custom_id] = String(component.value ?? "");
            }
        }
    }
    return values;
}
/** Route a modal submit raised from an interaction card. */
export async function handleInteractionCardModal(ctx, data, actor, cmdCtx) {
    const customId = String(data.custom_id ?? "");
    const [, op, interactionId] = customId.split("|");
    const base = cmdCtx?.baseUrl ?? "http://localhost:3100";
    const apiKey = cmdCtx?.paperclipBoardApiKey ?? "";
    const card = (await readState(ctx, cardStateKey(interactionId)));
    if (!card?.issueId) {
        return failureResponse("Card no longer tracked", "This card is older than the plugin's tracking window. Open it on the Paperclip board.");
    }
    try {
        const interaction = await loadLiveInteraction(base, apiKey, card);
        if (!interaction) {
            await untrackCard(ctx, interactionId);
            return failureResponse("Card not found", "Paperclip no longer has this card.");
        }
        if (interaction.status !== "pending") {
            await untrackCard(ctx, interactionId);
            return { type: 7, data: buildResolvedCard(interaction, card, null) };
        }
        const values = modalValues(data);
        if (op === "r") {
            const reason = values.reason?.trim();
            if (!reason)
                return failureResponse("Reason required", "This card cannot be rejected without a reason.");
            return await resolveConfirmation(ctx, base, apiKey, card, interaction, await readSelections(ctx, interactionId), actor, "reject", reason);
        }
        if (op === "a") {
            const selections = await readSelections(ctx, interactionId);
            const questions = interaction.payload?.questions ?? [];
            for (const [key, value] of Object.entries(values)) {
                const index = Number(key.replace(/^q/, ""));
                const question = questions[index];
                if (!question)
                    continue;
                const text = value.trim();
                selections[question.id] = {
                    optionIds: selections[question.id]?.optionIds ?? [],
                    ...(text ? { otherText: text } : {}),
                };
            }
            await writeState(ctx, selectionStateKey(interactionId), selections);
            return await submitAnswers(ctx, base, apiKey, card, interaction, selections, actor);
        }
        return failureResponse("Unknown form", `This plugin build does not handle "${truncate(op ?? "", 40)}".`);
    }
    catch (error) {
        ctx.logger.error("Interaction card form failed", {
            interactionId,
            op,
            error: errorMessage(error),
        });
        return failureResponse("Paperclip rejected that", errorMessage(error));
    }
}
