/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings, SettingsStore } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import type { Message } from "@vencord/discord-types";
import { Button, ChannelRouter, ChannelStore, Constants, Menu, MessageStore, RestAPI, SelectedChannelStore } from "@webpack/common";

import { BADGE_STYLE_ID, COLORS, FIXED_IDS, LIMITS, LOG_PREFIX, PATTERNS, TIMING } from "./constants";
import { openDuplicateHistoryModal } from "./DuplicateModal";
import { formatCooldownWindowLabel, formatDuration, formatDurationWords, formatMatchReasons } from "./format";
import { updateDuplicateHistory } from "./history";
import { clearRecordsCache, describeFdLevel, type FdMatch, formatFdBadge, formatFdRecordLine, getFdMatch, getRecordsVersion, resolveInviteGuildId, setRecordsChangeListener, stopRecords } from "./records";
import { checkRules, type RuleCheckOptions, type RuleViolation } from "./rules";
import { levenshteinSimilarity, levenshteinSimilarityAtLeast } from "./similarity";
import { normalizeContent, normalizeFactionName, normalizeTitle } from "./text";
import type { DuplicateHistoryEntry, ForumCardMatch, MatchEvaluation, MatchReason, RecordSummary, ThreadRecord, ViolationNoticeContext } from "./types";
import { openViolationTextModal } from "./ViolationModal";

const FALLBACKS = {
    similarityThreshold: 75,
} as const;


const settings = definePluginSettings({
    enabled: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Enable duplicate highlighting for the target forum channel",
    },
    tintUniquePosts: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Apply green tint to unique posts",
    },
    warningDuplicateThresholdMinutes: {
        type: OptionType.NUMBER,
        default: LIMITS.warningDuplicateThresholdMinutes.default,
        description: "When duplicate expiry is within this many minutes, use warning color",
        isValid(value: number) {
            const numericValue = Number(value);
            if (!Number.isFinite(numericValue)) return "Enter a valid number of minutes";
            if (numericValue < LIMITS.warningDuplicateThresholdMinutes.min || numericValue > LIMITS.warningDuplicateThresholdMinutes.max) {
                return `Value must be between ${LIMITS.warningDuplicateThresholdMinutes.min} and ${LIMITS.warningDuplicateThresholdMinutes.max} minutes`;
            }

            return true;
        },
    },
    duplicateWindowMinutes: {
        type: OptionType.NUMBER,
        default: LIMITS.duplicateWindowMinutes.default,
        description: "Duplicate window in minutes (type a value, e.g. 720)",
        isValid(value: number) {
            const numericValue = Number(value);
            if (!Number.isFinite(numericValue)) return "Enter a valid number of minutes";
            if (numericValue < LIMITS.duplicateWindowMinutes.min || numericValue > LIMITS.duplicateWindowMinutes.max) {
                return `Value must be between ${LIMITS.duplicateWindowMinutes.min} and ${LIMITS.duplicateWindowMinutes.max} minutes`;
            }

            return true;
        },
    },
    excludePatternRegex: {
        type: OptionType.STRING,
        default: "",
        placeholder: "optional regex, e.g. leviathan|faction",
        description: "Skip posts matching this regex (checked against title + content snippet)",
        isValid(value: string) {
            const source = String(value ?? "").trim();
            if (!source) return true;

            try {
                new RegExp(source, "i");
                return true;
            } catch (error: any) {
                return `Invalid regex: ${error?.message ?? "unknown error"}`;
            }
        }
    },
    ruleMultipleInvites: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "C2-1: Flag posts containing more than one server invite",
    },
    ruleMissingTags: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "C2-4: Flag posts missing both the Faction and Community Hub tags",
    },
    ruleTitleQuality: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "C2-5/C2-7: Flag titles using custom unicode letters, decorative symbols, or sensationalist language",
    },
    ruleUndisclosedAi: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "C2-11: Flag posts that look AI-written without a plain-text AI disclosure",
    },
    aiSignalThreshold: {
        type: OptionType.SLIDER,
        markers: [1, 2, 3, 4, 5, 6],
        default: 4,
        stickToMarkers: true,
        description: "AI-writing signal points required before flagging C2-11 (higher = fewer false positives)",
    },
    showViolationBadge: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show a corner badge listing violated rule codes on flagged posts",
    },
    checkTitle: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Compare normalized post titles (ignores case, fancy unicode letters, emoji, and symbols)",
    },
    checkInvite: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Compare Discord invites found in the first message (same code, or different codes for the same server)",
    },
    checkContent: {
        type: OptionType.BOOLEAN,
        default: true,
        description: `Compare the first ${LIMITS.contentSnippetLength} characters of the first message content (ignoring emoji, links, timestamps, and markdown)`,
    },
    checkAuthor: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Treat a post by the same author within the duplicate window as a duplicate",
    },
    similarityThreshold: {
        type: OptionType.SLIDER,
        markers: [50, 60, 70, 75, 80, 90, 100],
        default: FALLBACKS.similarityThreshold,
        stickToMarkers: true,
        description: "Minimum similarity percentage required for content matches",
    },
    showExpiryTooltip: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Show remaining duplicate window time when hovering duplicate cards",
    },
    fdRecordsEnabled: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Check posts against the FD blacklist/warning records (pl5fd.com)",
    },
    fdCheckAuthor: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "FD: look up the post author's Discord ID (also matches server owners)",
    },
    fdCheckTitle: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "FD: look up the post title as a faction name (shown as a possible match)",
    },
    fdConfirmViaInvite: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "FD: when something matches, resolve the post's invite and confirm by server ID",
    },
    fdClearCache: {
        type: OptionType.COMPONENT,
        description: "Clear cached FD records",
        component: () => (
            <Button size={Button.Sizes.SMALL} onClick={clearRecordsCache}>
                Clear FD records cache
            </Button>
        ),
    },
    duplicateHistoryPanel: {
        type: OptionType.COMPONENT,
        description: "Recent duplicate matches",
        component: () => (
            <Button size={Button.Sizes.SMALL} onClick={openHistoryModal}>
                Open duplicate history
            </Button>
        ),
    },
    debugLogs: {
        type: OptionType.BOOLEAN,
        default: false,
        description: "Enable verbose debug logs in the console",
    },
});

let mutationObserver: MutationObserver | null = null;
let scanQueued = false;
let refreshTimer: number | null = null;
let heartbeatTimer: number | null = null;
let renderedRecords = new Map<string, ThreadRecord>();
// Lets buildThreadRecords() skip its full rebuild (duplicate matching, rule checks,
// similarity scoring) when nothing about the underlying thread/message data or the
// settings that affect it has actually changed since the last scan. Without this,
// every DOM-only mutation (e.g. the forum's virtualized list mounting/unmounting
// cards while scrolling) re-triggers the observer and pays for a full rebuild even
// though renderedRecords would come out identical.
let lastRecordsSignature = "";
const postTextCache = new Map<string, { firstMessageId: string; content: string; inviteCode: string; contentSnippet: string; }>();
// checkRules() runs a dozen-plus regexes (title quality, invite counting, and
// especially the C2-11 AI-signal detector) over full post content. Without this
// cache it re-ran on every thread on every scan - every mutation-observer tick and
// every 30s heartbeat - even when nothing about that post had changed, which was a
// major source of the "laggy while browsing the forum" cost. Keyed by thread id;
// invalidated when the first message, title, tags, or rule settings actually change.
const ruleViolationsCache = new Map<string, { firstMessageId: string; rawTitle: string; appliedTagsKey: string; optionsKey: string; violations: RuleViolation[]; }>();
// Backoff bookkeeping for threads whose first message failed to fetch at least once.
const messageFetchRetryState = new Map<string, { failCount: number; nextRetryAt: number; }>();
// Opening messages fetched by fetchFirstMessage(). The REST response isn't merged
// into MessageStore (that's Discord's own job when the thread is opened), so it's
// kept here; null means the opening message was deleted and shouldn't be refetched.
const fetchedFirstMessages = new Map<string, Message | null>();
// Bounded-concurrency queue for proactively fetching a forum thread's first message
// when it isn't already cached client-side (e.g. right after a restart, or for a post
// the officer hasn't opened yet) - without this, duplicate/violation checks that need
// message content, and history entries that need the author, silently fall back to
// empty/"Unknown" until someone happens to open the thread.
const messageFetchQueue: string[] = [];
const queuedOrFetchingMessageThreadIds = new Set<string>();
let activeMessageFetches = 0;
// Content similarity per (post, earlier post) pair, keyed by thread ids and checked
// against both snippets so it stays valid across rescans until a post's content
// changes. A busy forum has tens of thousands of in-window pairs; the old flat cache
// was capped far below that, so it thrashed and every rescan re-ran Levenshtein on
// nearly every pair - the main cause of the forum freezing the client. Pruned to
// live threads after each rebuild. `exact` is false when the check stopped early
// because the pair was already below the threshold (similarity is then an upper bound).
const similarityCache = new Map<string, Map<string, { left: string; right: string; similarity: number; exact: boolean; }>>();
let excludeRegexCacheSource = "";
let excludeRegexCache: RegExp | null = null;

function logDebug(message: string, ...args: any[]) {
    if (!settings.store.debugLogs) return;
    console.log(LOG_PREFIX, message, ...args);
}

function logDebugGroup(title: string, entries: Array<() => void>) {
    if (!settings.store.debugLogs) return;

    console.groupCollapsed(`${LOG_PREFIX} ${title}`);
    try {
        for (const entry of entries) entry();
    } finally {
        console.groupEnd();
    }
}

function getRenderedFdMatch(threadId: string) {
    return renderedRecords.get(threadId)?.fdMatch ?? null;
}

// DuplicateModal gets the window and FD lookups passed in rather than importing
// them from here, which would make it (and the settings button below) circular.
function openHistoryModal() {
    openDuplicateHistoryModal({ getDuplicateWindowMs, getFdMatch: getRenderedFdMatch });
}

function getExcludeRegex() {
    const source = String(settings.store.excludePatternRegex ?? "").trim();
    if (!source) {
        excludeRegexCacheSource = "";
        excludeRegexCache = null;
        return null;
    }

    if (source === excludeRegexCacheSource) {
        return excludeRegexCache;
    }

    excludeRegexCacheSource = source;
    try {
        excludeRegexCache = new RegExp(source, "i");
    } catch {
        excludeRegexCache = null;
    }

    return excludeRegexCache;
}

function getSimilarityThreshold() {
    const threshold = Number(settings.store.similarityThreshold) || FALLBACKS.similarityThreshold;
    return Math.min(100, Math.max(0, threshold)) / 100;
}

function getDuplicateWindowMs() {
    const minutes = Number(settings.store.duplicateWindowMinutes);
    const safeMinutes = Number.isFinite(minutes)
        ? Math.min(LIMITS.duplicateWindowMinutes.max, Math.max(LIMITS.duplicateWindowMinutes.min, minutes))
        : LIMITS.duplicateWindowMinutes.default;

    return safeMinutes * 60 * 1000;
}

function extractInviteCode(content: string) {
    const inviteMatch = content.match(PATTERNS.discordInvite);
    return inviteMatch?.[1].toLowerCase() ?? "";
}

function getRuleCheckOptions(): RuleCheckOptions {
    return {
        multipleInvites: settings.store.ruleMultipleInvites,
        tagCheck: settings.store.ruleMissingTags,
        titleQuality: settings.store.ruleTitleQuality,
        aiDisclosure: settings.store.ruleUndisclosedAi,
        aiSignalThreshold: Number(settings.store.aiSignalThreshold) || 4,
    };
}

function getCachedRuleViolations(
    threadId: string,
    rawTitle: string,
    content: string,
    appliedTags: string[],
    firstMessageId: string,
    options: RuleCheckOptions,
): RuleViolation[] {
    const appliedTagsKey = appliedTags.join(",");
    const optionsKey = `${options.multipleInvites}|${options.tagCheck}|${options.titleQuality}|${options.aiDisclosure}|${options.aiSignalThreshold}`;

    // Don't cache the "message not loaded yet" state (empty firstMessageId) - let it
    // keep recomputing (cheap on empty content) until the real message arrives, then
    // start caching against its actual id.
    if (!firstMessageId) {
        return checkRules({ rawTitle, content, appliedTags }, options);
    }

    const cached = ruleViolationsCache.get(threadId);
    if (
        cached
        && cached.firstMessageId === firstMessageId
        && cached.rawTitle === rawTitle
        && cached.appliedTagsKey === appliedTagsKey
        && cached.optionsKey === optionsKey
    ) {
        return cached.violations;
    }

    const violations = checkRules({ rawTitle, content, appliedTags }, options);
    ruleViolationsCache.set(threadId, { firstMessageId, rawTitle, appliedTagsKey, optionsKey, violations });
    return violations;
}

function getWarningDuplicateThresholdMs() {
    const minutes = Number(settings.store.warningDuplicateThresholdMinutes);
    const safeMinutes = Number.isFinite(minutes)
        ? Math.min(LIMITS.warningDuplicateThresholdMinutes.max, Math.max(LIMITS.warningDuplicateThresholdMinutes.min, minutes))
        : LIMITS.warningDuplicateThresholdMinutes.default;

    return safeMinutes * 60 * 1000;
}

function scheduleFirstMessageFetch(threadId: string) {
    if (!threadId) return;
    if (queuedOrFetchingMessageThreadIds.has(threadId)) return;

    const retryState = messageFetchRetryState.get(threadId);
    if (retryState && retryState.nextRetryAt > Date.now()) return;

    queuedOrFetchingMessageThreadIds.add(threadId);
    messageFetchQueue.push(threadId);
    pumpMessageFetchQueue();
}

function pumpMessageFetchQueue() {
    while (activeMessageFetches < LIMITS.maxConcurrentMessageFetches && messageFetchQueue.length) {
        const threadId = messageFetchQueue.shift();
        if (threadId == null) break;
        void fetchFirstMessage(threadId);
    }
}

async function fetchFirstMessage(threadId: string) {
    activeMessageFetches++;
    try {
        // A forum post's opening message shares the thread's id, so this one-message
        // `around` fetch is the smallest request that returns it - the same pattern
        // messageLinkEmbeds/validReply use. (MessageActions.fetchMessages has no
        // typed single-message form and would pull a whole page of replies.)
        const res = await RestAPI.get({
            url: Constants.Endpoints.MESSAGES(threadId),
            query: { limit: 1, around: threadId },
        });
        const message = res?.body?.[0];
        // `around` returns the nearest surviving message when the opening post was
        // deleted - that's a reply, so it must not stand in for the post.
        fetchedFirstMessages.set(
            threadId,
            message?.id === threadId
                ? MessageStore.getMessages(threadId).receiveMessage(message).get(threadId) ?? null
                : null,
        );
        messageFetchRetryState.delete(threadId);
    } catch (error) {
        const previousFailCount = messageFetchRetryState.get(threadId)?.failCount ?? 0;
        const failCount = previousFailCount + 1;
        const backoffMs = Math.min(
            LIMITS.messageFetchRetry.maxMs,
            LIMITS.messageFetchRetry.baseMs * (2 ** (failCount - 1)),
        );

        messageFetchRetryState.set(threadId, {
            failCount,
            nextRetryAt: Date.now() + backoffMs,
        });

        logDebug("First-message fetch failed, will retry with backoff", {
            threadId,
            failCount,
            backoffMs,
            error,
        });
    } finally {
        queuedOrFetchingMessageThreadIds.delete(threadId);
        activeMessageFetches--;
        scheduleRefresh();
        pumpMessageFetchQueue();
    }
}

function snowflakeToTimestamp(id: string) {
    try {
        return Number((BigInt(id) >> 22n) + 1420070400000n);
    } catch {
        return Date.now();
    }
}

function getThreadCreatedAt(channel: ReturnType<typeof ChannelStore.getChannel>) {
    const timestamp = channel.threadMetadata?.createTimestamp;
    if (timestamp) {
        const parsed = Date.parse(timestamp);
        if (!Number.isNaN(parsed)) return parsed;
    }

    return snowflakeToTimestamp(channel.id);
}

// A forum post's opening message has the same id as the thread. No "oldest loaded
// message" fallback: with only part of the thread loaded that's a reply, which would
// attribute someone else's author/content to the post.
function getFirstForumMessage(threadId: string): Message | undefined {
    return MessageStore.getMessage(threadId, threadId) ?? fetchedFirstMessages.get(threadId) ?? undefined;
}

// Cache key for the opening message's current version, so edits invalidate the
// text/rule caches below instead of being masked by an unchanged message id.
function getFirstMessageKey(message: Message | undefined) {
    return message ? `${message.id}:${message.editedTimestamp ?? ""}` : "";
}

function hexToRgba(hexColor: number, alpha: number) {
    const red = (hexColor >> 16) & 0xff;
    const green = (hexColor >> 8) & 0xff;
    const blue = hexColor & 0xff;
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function getHighlightColor(record: ThreadRecord) {
    if (record.highlight === "violation") {
        return COLORS.violation;
    }

    if (record.highlight !== "duplicate") {
        return COLORS.unique;
    }

    const windowMs = getDuplicateWindowMs();
    const warningThresholdMs = getWarningDuplicateThresholdMs();
    const timeUntilUnique = record.matchedPreviousDeltaMs == null
        ? null
        : Math.max(0, windowMs - record.matchedPreviousDeltaMs);

    if (timeUntilUnique != null && timeUntilUnique <= warningThresholdMs) {
        return COLORS.duplicateWarning;
    }

    return COLORS.duplicate;
}

function parseThreadIdFromHref(href: string) {
    if (!href) return null;

    let pathname = href;
    try {
        // Works for both absolute and relative URLs.
        pathname = new URL(href, window.location.origin).pathname;
    } catch {
        // Keep raw href as a fallback.
    }

    const match = pathname.match(/\/channels\/(\d+)\/(\d+)(?:\/(\d+))?/);
    if (!match) return null;

    const guildId = match[1];
    const second = match[2];
    const third = match[3];

    if (guildId !== FIXED_IDS.guildId) return null;
    if (second === FIXED_IDS.forumChannelId) return third ?? null;
    return second ?? null;
}

function extractKnownThreadIdFromText(value: string) {
    const ids = value.match(PATTERNS.snowflake) ?? [];
    for (const id of ids) {
        if (renderedRecords.has(id)) return id;
    }

    return null;
}

function getThreadIdFromElementData(element: HTMLElement) {
    const parts = [
        element.id,
        element.className,
        element.getAttribute("data-list-item-id"),
        element.getAttribute("aria-label"),
        element.getAttribute("aria-labelledby"),
        element.getAttribute("data-item-id"),
    ].filter(Boolean) as string[];

    for (const part of parts) {
        const threadId = extractKnownThreadIdFromText(part);
        if (threadId) return threadId;
    }

    const anchors = element.querySelectorAll<HTMLAnchorElement>("a[href*='/channels/']");
    for (const anchor of anchors) {
        const href = anchor.getAttribute("href") ?? "";
        const fromPath = parseThreadIdFromHref(href);
        if (fromPath && renderedRecords.has(fromPath)) return fromPath;

        const fromHrefText = extractKnownThreadIdFromText(href);
        if (fromHrefText) return fromHrefText;
    }

    return null;
}

function isInTargetForumContext() {
    const selectedChannelId = SelectedChannelStore.getChannelId();
    if (!selectedChannelId) return false;

    if (selectedChannelId === FIXED_IDS.forumChannelId) return true;

    const selectedChannel = ChannelStore.getChannel(selectedChannelId);
    if (!selectedChannel?.isForumPost?.()) return false;
    return selectedChannel.parent_id === FIXED_IDS.forumChannelId && selectedChannel.getGuildId() === FIXED_IDS.guildId;
}

function getPostText(channelId: string) {
    const message = getFirstForumMessage(channelId);
    if (!message) {
        // Message not cached client-side yet (e.g. right after a restart). Queue a
        // fetch so content/invite/author data backfills on a later scan instead of
        // staying empty until someone happens to open the thread. Skipped once a
        // fetch has shown the opening message was deleted.
        if (!fetchedFirstMessages.has(channelId)) scheduleFirstMessageFetch(channelId);
        return { content: "", inviteCode: "", contentSnippet: "" };
    }

    const firstMessageKey = getFirstMessageKey(message);
    const cached = postTextCache.get(channelId);
    if (cached && cached.firstMessageId === firstMessageKey) {
        return cached;
    }

    const content = typeof message.content === "string" ? message.content : "";
    const entry = {
        firstMessageId: firstMessageKey,
        content,
        inviteCode: extractInviteCode(content),
        contentSnippet: normalizeContent(content),
    };
    postTextCache.set(channelId, entry);

    return entry;
}

interface MatchOptions {
    titleEnabled: boolean;
    inviteEnabled: boolean;
    contentEnabled: boolean;
    authorEnabled: boolean;
    similarityThreshold: number;
}

function evaluateMatch(left: ThreadRecord, right: ThreadRecord, options: MatchOptions): MatchEvaluation {
    const { titleEnabled, inviteEnabled, contentEnabled, authorEnabled, similarityThreshold } = options;
    const reasons: MatchReason[] = [];
    let contentSimilarity: number | null = null;

    if (titleEnabled && left.titleKey && right.titleKey && left.titleKey === right.titleKey) {
        reasons.push("title");
    }

    if (inviteEnabled && left.inviteCode && right.inviteCode) {
        // Different invite codes can point at the same server; once both have resolved
        // (undefined = pending, null = unresolvable) compare the server instead.
        const sameCode = left.inviteCode === right.inviteCode;
        const sameGuild = left.inviteGuildId != null && left.inviteGuildId === right.inviteGuildId;
        if (sameCode || sameGuild) reasons.push("invite");
    }

    if (authorEnabled && left.authorId && left.authorId === right.authorId) {
        reasons.push("author");
    }

    if (contentEnabled && left.contentSnippet && right.contentSnippet) {
        const lengthDelta = Math.abs(left.contentSnippet.length - right.contentSnippet.length);
        const maxLength = Math.max(left.contentSnippet.length, right.contentSnippet.length);
        if (!maxLength || lengthDelta / maxLength <= (1 - similarityThreshold)) {
            // The score is only shown for pairs that matched on something; when nothing
            // else matched, a bounded check that bails out below the threshold is enough.
            const needExact = reasons.length > 0;
            let byRight = similarityCache.get(left.threadId);
            if (!byRight) similarityCache.set(left.threadId, byRight = new Map());

            let cached = byRight.get(right.threadId);
            if (
                !cached
                || cached.left !== left.contentSnippet
                || cached.right !== right.contentSnippet
                || (!cached.exact && (needExact || cached.similarity >= similarityThreshold))
            ) {
                const similarity = needExact
                    ? levenshteinSimilarity(left.contentSnippet, right.contentSnippet)
                    : levenshteinSimilarityAtLeast(left.contentSnippet, right.contentSnippet, similarityThreshold);
                cached = {
                    left: left.contentSnippet,
                    right: right.contentSnippet,
                    similarity,
                    exact: needExact || similarity >= similarityThreshold,
                };
                byRight.set(right.threadId, cached);
            }

            contentSimilarity = cached.similarity;
            if (cached.similarity >= similarityThreshold) {
                reasons.push("content");
            }
        }
    }

    return {
        matched: reasons.length > 0,
        reasons,
        contentSimilarity,
    };
}

function getDuplicateInfo(record: ThreadRecord, previousRecords: ThreadRecord[], activeRecords: ThreadRecord[], windowMs: number) {
    const matchOptions: MatchOptions = {
        titleEnabled: settings.store.checkTitle,
        inviteEnabled: settings.store.checkInvite,
        contentEnabled: settings.store.checkContent,
        authorEnabled: settings.store.checkAuthor,
        similarityThreshold: getSimilarityThreshold(),
    };
    let duplicateUntil: number | null = null;
    let duplicateSourceThreadId: string | null = null;
    let matchedPreviousThreadId: string | null = null;
    let matchedPreviousDeltaMs: number | null = null;
    let matchedPreviousTitle = "";
    let matchedReasons: MatchReason[] = [];
    let matchedContentSimilarity: number | null = null;

    // activeRecords is always built as a chronological suffix of previousRecords (see
    // buildThreadRecords: both are pushed to together, activeRecords just also shifts
    // off its front past the cutoff), so every element in it also appears in
    // previousRecords. A single pass - checking active-window membership as we go -
    // covers what used to be two separate loops, each calling evaluateMatch() again
    // for anything inside the duplicate window, doubling that work for no difference
    // in output (matchedPrevious* always resolves to the same nearest match either
    // way, since it's a pure function of the (record, previous) pair).
    const activeSet = new Set(activeRecords);
    // previousRecords is chronological, so walk it newest-first and stop once posts are
    // too old to matter: the active window is always inside this lookback, so only the
    // tooltip's "nearest previous match" for long-unique posts is affected.
    const lookbackCutoff = record.createdAt - windowMs * LIMITS.duplicateLookbackWindows;

    for (let i = previousRecords.length - 1; i >= 0; i--) {
        const previous = previousRecords[i];
        if (previous.createdAt < lookbackCutoff) break;

        const match = evaluateMatch(record, previous, matchOptions);
        if (!match.matched) {
            continue;
        }

        const delta = Math.max(0, record.createdAt - previous.createdAt);
        if (matchedPreviousDeltaMs == null || delta < matchedPreviousDeltaMs) {
            matchedPreviousDeltaMs = delta;
            matchedPreviousThreadId = previous.threadId;
            matchedPreviousTitle = previous.title;
            matchedReasons = [...match.reasons];
            matchedContentSimilarity = match.contentSimilarity;
        }

        if (activeSet.has(previous)) {
            const expiresAt = previous.createdAt + windowMs;
            if (duplicateUntil == null || expiresAt > duplicateUntil) {
                duplicateUntil = expiresAt;
                duplicateSourceThreadId = previous.threadId;
            }
        }
    }

    return {
        isDuplicate: duplicateUntil != null,
        duplicateUntil,
        duplicateSourceThreadId,
        matchedPreviousThreadId,
        matchedPreviousDeltaMs,
        matchedPreviousTitle,
        matchedReasons,
        matchedContentSimilarity,
    };
}

// Duplicate-ness is read from the match itself rather than record.highlight.
function isDuplicateRecord(record: ThreadRecord) {
    return record.duplicateUntil != null;
}

// C2-2: re-posting before the duplicate window (cooldown) has elapsed. This isn't
// one of the rules.ts content checks - it's derived from the duplicate match itself -
// so it's synthesized here rather than returned from checkRules().
function buildCooldownViolation(record: ThreadRecord): RuleViolation | null {
    if (!isDuplicateRecord(record) || record.matchedPreviousDeltaMs == null) return null;

    const windowMs = getDuplicateWindowMs();
    const earlyByMs = Math.max(0, windowMs - record.matchedPreviousDeltaMs);
    if (earlyByMs <= 0) return null;

    return {
        code: "C2-2",
        summary: `Posting ${formatDurationWords(earlyByMs)} early from ${formatCooldownWindowLabel(windowMs)}`,
    };
}

function applyExpiryTooltip(element: HTMLElement, record: ThreadRecord) {
    if (element.dataset.vcPl5TooltipInit !== "1") {
        element.dataset.vcPl5TooltipInit = "1";
        element.dataset.vcPl5HadTitle = element.hasAttribute("title") ? "1" : "0";
        if (element.hasAttribute("title")) {
            element.dataset.vcPl5OriginalTitle = element.getAttribute("title") ?? "";
        }
    }

    if (!settings.store.showExpiryTooltip) {
        if (element.dataset.vcPl5HadTitle === "1") {
            element.setAttribute("title", element.dataset.vcPl5OriginalTitle ?? "");
        } else {
            element.removeAttribute("title");
        }
        return;
    }

    const tooltipLines: string[] = [];
    const windowMs = getDuplicateWindowMs();

    if (record.fdMatch) {
        tooltipLines.push(`FD ${record.fdMatch.hasActive ? record.fdMatch.kind : "history only"} (${describeFdLevel(record.fdMatch)}): ${record.fdMatch.records.map(formatFdRecordLine).join("; ")}`);
    }

    if (record.excludedByPattern) {
        tooltipLines.push("Excluded by regex pattern");
    }

    if (record.violations.length) {
        tooltipLines.push(`Violations: ${record.violations.map(violation => `${violation.code} (${violation.summary})`).join("; ")}`);
    }

    if (record.matchedPreviousDeltaMs == null) {
        tooltipLines.push("Matching previous post: none");
    } else {
        tooltipLines.push(`Since matching previous post: ${formatDuration(record.matchedPreviousDeltaMs)}`);
        tooltipLines.push(`Match reasons: ${formatMatchReasons(record.matchedReasons, record.matchedContentSimilarity)}`);

        const timeUntilUnique = Math.max(0, windowMs - record.matchedPreviousDeltaMs);
        if (timeUntilUnique > 0) {
            tooltipLines.push(`Time until unique: ${formatDuration(timeUntilUnique)}`);
        } else {
            tooltipLines.push("Time until unique: 0m (unique now)");
        }
    }

    element.setAttribute("title", tooltipLines.join(" | "));
}

function getForumThreads(): any[] {
    return ChannelStore.getAllThreadsForParent(FIXED_IDS.forumChannelId)
        .filter((channel: any) => channel?.isForumPost?.() && channel.getGuildId() === FIXED_IDS.guildId);
}

// Per-thread inputs to buildThreadRecords(): thread metadata, tags, and which version
// of the opening message (if any) is available yet.
function computeThreadSignature(thread: any) {
    return [
        thread.id,
        thread.name ?? "",
        thread.lastMessageId ?? "",
        thread.messageCount ?? 0,
        getFirstMessageKey(getFirstForumMessage(thread.id)),
        (thread.appliedTags ?? []).join(","),
    ].join(":");
}

function computeRecordsSignature(threads: any[]) {
    // Everything here that can change what buildThreadRecords() produces has to be
    // part of the signature, or a settings/content change could get silently skipped
    // until some unrelated thread mutation happens to invalidate the cache.
    const settingsKey = [
        getDuplicateWindowMs(),
        getWarningDuplicateThresholdMs(),
        settings.store.excludePatternRegex,
        settings.store.checkTitle,
        settings.store.checkInvite,
        settings.store.checkContent,
        settings.store.checkAuthor,
        settings.store.similarityThreshold,
        settings.store.ruleMultipleInvites,
        settings.store.ruleMissingTags,
        settings.store.ruleTitleQuality,
        settings.store.ruleUndisclosedAi,
        settings.store.aiSignalThreshold,
        settings.store.fdRecordsEnabled,
        settings.store.fdCheckAuthor,
        settings.store.fdCheckTitle,
        settings.store.fdConfirmViaInvite,
        getRecordsVersion(),
    ].join("|");

    const threadsKey = threads.map(computeThreadSignature).join("|");

    return `${settingsKey}::${threadsKey}`;
}

function getFdMatchForThread(thread: any, inviteCode: string): FdMatch | null {
    if (!settings.store.fdRecordsEnabled) return null;

    return getFdMatch(
        getFirstForumMessage(thread.id)?.author?.id ?? "",
        thread.name ?? "",
        inviteCode,
        {
            checkAuthor: settings.store.fdCheckAuthor,
            checkTitle: settings.store.fdCheckTitle,
            confirmViaInvite: settings.store.fdConfirmViaInvite,
        },
    );
}

function buildThreadRecords() {
    const windowMs = getDuplicateWindowMs();
    // createdAt is parsed once per thread rather than on every sort comparison.
    const threads = getForumThreads();
    const createdAtById = new Map<string, number>();
    for (const thread of threads) createdAtById.set(thread.id, getThreadCreatedAt(thread));
    threads.sort((left: any, right: any) => createdAtById.get(left.id)! - createdAtById.get(right.id)!);

    const signature = computeRecordsSignature(threads);
    if (signature === lastRecordsSignature) {
        logDebug("buildThreadRecords skipped: no relevant change since last scan", {
            totalThreads: threads.length,
        });
        return;
    }
    lastRecordsSignature = signature;

    // Only posts inside the duplicate window get their invites resolved for
    // same-server matching - older ones can't make a current post a duplicate.
    const inviteResolveCutoff = Date.now() - windowMs;
    const activeRecords: ThreadRecord[] = [];
    const previousRecords: ThreadRecord[] = [];
    const nextRecords = new Map<string, ThreadRecord>();

    for (const thread of threads) {
        const createdAt = createdAtById.get(thread.id)!;
        const cutoff = createdAt - windowMs;

        while (activeRecords.length && activeRecords[0].createdAt < cutoff) {
            activeRecords.shift();
        }

        const firstMessage = getFirstForumMessage(thread.id);
        const record: ThreadRecord = {
            threadId: thread.id,
            createdAt,
            title: normalizeTitle(thread.name ?? ""),
            titleKey: normalizeFactionName(thread.name ?? ""),
            inviteCode: "",
            inviteGuildId: undefined,
            authorId: firstMessage?.author?.id ?? "",
            contentSnippet: "",
            highlight: "unique",
            duplicateUntil: null,
            duplicateSourceThreadId: null,
            matchedPreviousThreadId: null,
            matchedPreviousDeltaMs: null,
            matchedPreviousTitle: "",
            matchedReasons: [],
            matchedContentSimilarity: null,
            excludedByPattern: false,
            violations: [],
            fdMatch: null,
        };

        const { content, inviteCode, contentSnippet } = getPostText(thread.id);
        record.inviteCode = inviteCode;
        if (inviteCode && settings.store.checkInvite && createdAt >= inviteResolveCutoff) {
            record.inviteGuildId = resolveInviteGuildId(inviteCode);
        }
        record.contentSnippet = contentSnippet;
        record.fdMatch = getFdMatchForThread(thread, inviteCode);

        const appliedTags = Array.isArray((thread as any).appliedTags)
            ? (thread as any).appliedTags.map(String)
            : [];
        const firstMessageId = postTextCache.get(thread.id)?.firstMessageId ?? "";
        record.violations = getCachedRuleViolations(
            thread.id,
            thread.name ?? "",
            content,
            appliedTags,
            firstMessageId,
            getRuleCheckOptions(),
        );

        const excludeRegex = getExcludeRegex();
        if (excludeRegex && (excludeRegex.test(record.title) || excludeRegex.test(record.contentSnippet))) {
            record.excludedByPattern = true;
            nextRecords.set(thread.id, record);
            continue;
        }

        const duplicateInfo = getDuplicateInfo(record, previousRecords, activeRecords, windowMs);
        // Tint priority: duplicate > violation > unique.
        // Violations on duplicate posts still surface via badge + tooltip, and FD
        // records are an extra outline + badge on top of whatever tint applies.
        record.highlight = duplicateInfo.isDuplicate
            ? "duplicate"
            : record.violations.length
                ? "violation"
                : "unique";
        record.duplicateUntil = duplicateInfo.duplicateUntil;
        record.duplicateSourceThreadId = duplicateInfo.duplicateSourceThreadId;
        record.matchedPreviousThreadId = duplicateInfo.matchedPreviousThreadId;
        record.matchedPreviousDeltaMs = duplicateInfo.matchedPreviousDeltaMs;
        record.matchedPreviousTitle = duplicateInfo.matchedPreviousTitle;
        record.matchedReasons = duplicateInfo.matchedReasons;
        record.matchedContentSimilarity = duplicateInfo.matchedContentSimilarity;


        nextRecords.set(thread.id, record);
        previousRecords.push(record);
        activeRecords.push(record);
    }

    renderedRecords = nextRecords;
    // Drop pairs whose posts are gone or that fell out of the lookback, which
    // getDuplicateInfo() never compares again.
    const lookbackMs = windowMs * LIMITS.duplicateLookbackWindows;
    for (const [threadId, byRight] of similarityCache) {
        const left = nextRecords.get(threadId);
        if (!left) {
            similarityCache.delete(threadId);
            continue;
        }

        for (const rightId of byRight.keys()) {
            const right = nextRecords.get(rightId);
            if (!right || right.createdAt < left.createdAt - lookbackMs) byRight.delete(rightId);
        }
    }

    const liveHistory: DuplicateHistoryEntry[] = [...nextRecords.values()]
        .filter(record => isDuplicateRecord(record) && record.matchedPreviousThreadId && record.matchedPreviousDeltaMs != null)
        .sort((left, right) => right.createdAt - left.createdAt)
        .map(record => {
            const source = nextRecords.get(record.matchedPreviousThreadId!) ?? null;
            const firstMessage = getFirstForumMessage(record.threadId);
            const authorName = firstMessage?.author?.username ?? firstMessage?.author?.globalName ?? "Unknown";
            const authorId = firstMessage?.author?.id ?? "";
            // Every entry here is by definition a cooldown violation (that's what
            // "duplicate" means), so this is always attached alongside any rules.ts
            // violations - it's what makes "Copy violation notice" show for these.
            const cooldownViolation = buildCooldownViolation(record);
            const violations = cooldownViolation ? [cooldownViolation, ...record.violations] : record.violations;
            return {
                threadId: record.threadId,
                sourceThreadId: record.matchedPreviousThreadId!,
                threadTitle: ChannelStore.getChannel(record.threadId)?.name ?? record.title,
                sourceTitle: ChannelStore.getChannel(record.matchedPreviousThreadId!)?.name ?? source?.title ?? "",
                deltaMs: record.matchedPreviousDeltaMs!,
                reasons: record.matchedReasons,
                contentSimilarity: record.matchedContentSimilarity,
                createdAt: record.createdAt,
                authorName,
                authorId,
                contentSnippet: record.contentSnippet,
                inviteCode: record.inviteCode,
                violations,
                excludedByPattern: record.excludedByPattern,
            };
        });

    updateDuplicateHistory(liveHistory);

    logDebugGroup("buildThreadRecords", [
        () => logDebug("windowMs", windowMs),
        () => logDebug("totalThreads", threads.length),
        () => logDebug("recordsBuilt", nextRecords.size),
        () => {
            const sample = [...nextRecords.values()].slice(0, 8).map(r => ({
                threadId: r.threadId,
                highlight: r.highlight,
                title: r.title,
                inviteCode: r.inviteCode,
                contentSnippet: r.contentSnippet,
            }));
            logDebug("recordSample", sample);
        }
    ]);
}

function getForumCardMatchesFast(): ForumCardMatch[] | null {
    // Forum post cards consistently render with a `mainCard_<hash>` class in every
    // build we've observed (the `<hash>` suffix is a per-release webpack module id
    // and changes across Discord updates, but the `mainCard_` prefix - derived from
    // the source SCSS module name - doesn't). Querying for it directly is far
    // narrower than scanning every heading in the entire app and walking back up
    // from each one, which is what the fallback below has to do because it has no
    // more specific hook to start from.
    const candidates = document.querySelectorAll<HTMLElement>("[class*='mainCard_']");
    if (!candidates.length) return null;

    const cards = new Map<string, ForumCardMatch>();
    for (const candidate of candidates) {
        const threadId = getThreadIdFromElementData(candidate);
        // getThreadIdFromElementData() only ever resolves to an id already present in
        // renderedRecords (see extractKnownThreadIdFromText), so a false-positive
        // match here (some other, unrelated "mainCard_" element) can't slip through -
        // it just fails to resolve and gets skipped, same as it would in the fallback.
        if (threadId) cards.set(threadId, { element: candidate, threadId });
    }

    // If the class matched something but resolved none of our threads, don't trust
    // it - fall through to the heading scan rather than reporting zero cards.
    return cards.size ? [...cards.values()] : null;
}

function getForumCardMatchesViaHeadings(): ForumCardMatch[] {
    const cards = new Map<string, ForumCardMatch>();
    const headings = document.querySelectorAll<HTMLElement>("[role='heading'], h1, h2, h3, h4, h5, h6");
    const titleToThreadId = new Map<string, string>();

    const summaries: RecordSummary[] = [...renderedRecords.values()].map(record => ({
        threadId: record.threadId,
        title: record.title,
    }));

    for (const summary of summaries) {
        if (!summary.title || titleToThreadId.has(summary.title)) continue;
        titleToThreadId.set(summary.title, summary.threadId);
    }

    for (const heading of headings) {
        const card = heading.closest<HTMLElement>("li, article, [role='listitem'], [data-list-item-id], [class*='container'], [class*='card']") ?? heading;

        let threadId = getThreadIdFromElementData(card);
        if (!threadId) {
            const normalizedHeading = normalizeTitle(heading.textContent ?? "");
            threadId = titleToThreadId.get(normalizedHeading) ?? null;
        }
        if (!threadId) continue;

        cards.set(threadId, { element: card, threadId });
    }

    logDebug("getForumCardMatches fallback (heading scan)", {
        headingCount: headings.length,
        matchedCards: cards.size,
    });

    return [...cards.values()];
}

function getForumCardMatches(): ForumCardMatch[] {
    const fast = getForumCardMatchesFast();
    const result = fast ?? getForumCardMatchesViaHeadings();

    logDebug("getForumCardMatches summary", {
        usedFastPath: fast != null,
        matchedCards: result.length,
        sampleThreadIds: result.slice(0, 5).map(c => c.threadId),
    });

    return result;
}

// FD records never replace the tint - they add an inset outline on top of it, so the
// duplicate/violation/unique state stays visible. Name-only matches get a dashed-looking
// thinner outline since they're only "possible".
function applyFdOutline(element: HTMLElement, fdMatch: FdMatch | null) {
    if (!fdMatch) {
        element.style.removeProperty("box-shadow");
        return;
    }

    const color = !fdMatch.hasActive
        ? COLORS.fdPast
        : fdMatch.kind === "blacklist" ? COLORS.fdBlacklist : COLORS.fdWarning;
    const width = fdMatch.level === "name" ? 1 : 2;
    setCardStyle(element, "box-shadow", `inset 0 0 0 ${width}px ${hexToRgba(color, fdMatch.notInDb ? 0.45 : 0.9)}`);
}

function setCardStyle(element: HTMLElement, property: string, value: string) {
    element.style.setProperty(property, value, "important");
}

function applyViolationBadge(element: HTMLElement, record: ThreadRecord) {
    const showViolations = settings.store.showViolationBadge && record.violations.length > 0;
    if (!showViolations && !record.fdMatch) {
        removeViolationBadge(element);
        return;
    }

    // The ::before/::after badges are absolutely positioned, so the card needs to be a
    // positioning context. Only patch cards that are position: static so we
    // never break Discord's own absolutely-positioned list items.
    if (element.dataset.vcPl5PositionPatched !== "1" && getComputedStyle(element).position === "static") {
        element.dataset.vcPl5PositionPatched = "1";
        element.style.setProperty("position", "relative");
    }

    if (showViolations) {
        element.setAttribute("data-vc-pl5-violations", record.violations.map(violation => violation.code).join(" "));
    } else {
        element.removeAttribute("data-vc-pl5-violations");
    }

    if (record.fdMatch) {
        element.setAttribute("data-vc-pl5-fd", formatFdBadge(record.fdMatch));
        element.setAttribute("data-vc-pl5-fd-kind", record.fdMatch.hasActive ? record.fdMatch.kind : "past");
        element.toggleAttribute("data-vc-pl5-fd-dim", record.fdMatch.notInDb);
    } else {
        element.removeAttribute("data-vc-pl5-fd");
        element.removeAttribute("data-vc-pl5-fd-kind");
        element.removeAttribute("data-vc-pl5-fd-dim");
    }
}

function removeViolationBadge(element: HTMLElement) {
    element.removeAttribute("data-vc-pl5-violations");
    element.removeAttribute("data-vc-pl5-fd");
    element.removeAttribute("data-vc-pl5-fd-kind");
    element.removeAttribute("data-vc-pl5-fd-dim");
    if (element.dataset.vcPl5PositionPatched === "1") {
        delete element.dataset.vcPl5PositionPatched;
        element.style.removeProperty("position");
    }
}

function computeCardSignature(record: ThreadRecord) {
    // Everything applyHighlightToCard/applyViolationBadge/applyExpiryTooltip read to
    // decide what to write to the DOM has to be part of this, plus the threadId - the
    // forum's virtualized list recycles DOM nodes for different posts as you scroll,
    // so without threadId a coincidental match could skip writing a different post's
    // data onto a reused element.
    return [
        record.threadId,
        record.highlight,
        settings.store.tintUniquePosts,
        settings.store.showViolationBadge,
        settings.store.showExpiryTooltip,
        settings.store.checkAuthor,
        record.excludedByPattern,
        record.violations.map(violation => `${violation.code}:${violation.summary}`).join(","),
        record.fdMatch ? `${record.fdMatch.level}:${record.fdMatch.kind}:${record.fdMatch.hasActive}:${record.fdMatch.notInDb}:${record.fdMatch.records.map(entry => `${entry.record.id}/${entry.sources.join("+")}/${entry.active}`).join(",")}` : "",
        record.matchedPreviousDeltaMs,
        record.matchedReasons.join(","),
        record.matchedContentSimilarity,
        getDuplicateWindowMs(),
        getWarningDuplicateThresholdMs(),
    ].join("|");
}

function applyHighlightToCard(element: HTMLElement, record: ThreadRecord) {
    // The forum's virtualized list keeps re-mounting/unmounting cards as you scroll,
    // which retriggers a scan even though nothing about the underlying data changed.
    // Skip redoing the style/badge/tooltip writes when this exact element already has
    // this exact record's output applied - avoids needless layout/paint work and, with
    // debug logging on, a console.log per already-correct card on every single scan.
    const signature = computeCardSignature(record);
    if (element.dataset.vcPl5Signature === signature) return;
    element.dataset.vcPl5Signature = signature;

    if (record.highlight === "unique" && !settings.store.tintUniquePosts) {
        element.dataset.vcPl5PostDuplicateHighlighter = record.highlight;
        element.style.removeProperty("background-color");
        element.style.removeProperty("border-color");
        element.style.removeProperty("border-style");
        element.style.removeProperty("border-width");
        applyFdOutline(element, record.fdMatch);
        applyViolationBadge(element, record);
        applyExpiryTooltip(element, record);
        return;
    }

    const color = getHighlightColor(record);
    const rgb = `#${color.toString(16).padStart(6, "0")}`;
    const translucent = record.highlight === "violation"
        ? hexToRgba(color, 0.16)
        : hexToRgba(color, 0.12);

    element.dataset.vcPl5PostDuplicateHighlighter = record.highlight;
    setCardStyle(element, "background-color", translucent);
    element.style.removeProperty("border-color");
    element.style.removeProperty("border-style");
    element.style.removeProperty("border-width");
    applyFdOutline(element, record.fdMatch);
    applyViolationBadge(element, record);
    applyExpiryTooltip(element, record);

    logDebug("applyHighlightToCard", {
        threadId: record.threadId,
        highlight: record.highlight,
        rgb,
        tag: element.tagName,
        className: element.className,
    });
}

function clearHighlightFromCard(element: HTMLElement) {
    if (!element.dataset.vcPl5PostDuplicateHighlighter) return;

    delete element.dataset.vcPl5PostDuplicateHighlighter;
    delete element.dataset.vcPl5Signature;
    removeViolationBadge(element);
    element.style.removeProperty("background-color");
    element.style.removeProperty("border-color");
    element.style.removeProperty("border-style");
    element.style.removeProperty("border-width");
    element.style.removeProperty("box-shadow");

    if (element.dataset.vcPl5HadTitle === "1") {
        element.setAttribute("title", element.dataset.vcPl5OriginalTitle ?? "");
    } else {
        element.removeAttribute("title");
    }

}

function refreshHighlights() {
    if (!settings.store.enabled) {
        for (const element of document.querySelectorAll<HTMLElement>("[data-vc-pl5-post-duplicate-highlighter]")) {
            clearHighlightFromCard(element);
        }
        renderedRecords.clear();
        // Force the next buildThreadRecords() call (once re-enabled) to do a real
        // rebuild instead of comparing against a signature computed before we went
        // idle, which could otherwise match and leave renderedRecords empty.
        lastRecordsSignature = "";
        return;
    }

    if (!isInTargetForumContext()) {
        for (const element of document.querySelectorAll<HTMLElement>("[data-vc-pl5-post-duplicate-highlighter]")) {
            clearHighlightFromCard(element);
        }
        logDebug("refreshHighlights skipped: not in target forum context");
        return;
    }

    buildThreadRecords();
    const currentCards = new Set<HTMLElement>();
    let applied = 0;
    let cleared = 0;
    let missingRecord = 0;

    for (const { element, threadId } of getForumCardMatches()) {
        currentCards.add(element);
        const record = renderedRecords.get(threadId);
        if (!record) {
            clearHighlightFromCard(element);
            cleared++;
            missingRecord++;
            continue;
        }

        applyHighlightToCard(element, record);
        applied++;
    }

    for (const element of document.querySelectorAll<HTMLElement>("[data-vc-pl5-post-duplicate-highlighter]")) {
        if (!currentCards.has(element)) {
            clearHighlightFromCard(element);
            cleared++;
        }
    }

    logDebugGroup("refreshHighlights", [
        () => logDebug("enabled", settings.store.enabled),
        () => logDebug("inTargetForumContext", isInTargetForumContext()),
        () => logDebug("tintUniquePosts", settings.store.tintUniquePosts),
        () => logDebug("renderedRecords", renderedRecords.size),
        () => logDebug("applied", applied),
        () => logDebug("cleared", cleared),
        () => logDebug("missingRecord", missingRecord),
    ]);
}

function scheduleRefresh() {
    if (scanQueued) return;
    scanQueued = true;

    if (refreshTimer != null) {
        clearTimeout(refreshTimer);
    }

    refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        scanQueued = false;
        try {
            refreshHighlights();
        } catch (error) {
            console.error(`${LOG_PREFIX} Failed to refresh forum highlights`, error);
        }
    }, TIMING.refreshDebounceMs);
}

function injectBadgeStyles() {
    if (document.getElementById(BADGE_STYLE_ID)) return;

    const style = document.createElement("style");
    style.id = BADGE_STYLE_ID;
    style.textContent = `
[data-vc-pl5-violations]::after {
    content: attr(data-vc-pl5-violations);
    position: absolute;
    top: 6px;
    right: 6px;
    z-index: 100;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(0, 229, 255, 0.92);
    color: #00343a;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.02em;
    pointer-events: none;
}
[data-vc-pl5-fd]::before {
    content: attr(data-vc-pl5-fd);
    position: absolute;
    top: 6px;
    left: 6px;
    z-index: 100;
    padding: 2px 6px;
    border-radius: 4px;
    background: rgba(185, 28, 28, 0.95);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.02em;
    pointer-events: none;
}
[data-vc-pl5-fd-kind="warning"]::before {
    background: rgba(249, 115, 22, 0.95);
    color: #2a1000;
}
[data-vc-pl5-fd-kind="past"]::before {
    background: rgba(156, 163, 175, 0.95);
    color: #111827;
}
[data-vc-pl5-fd-dim]::before {
    opacity: 0.5;
}
`;
    document.head.appendChild(style);
}

function removeBadgeStyles() {
    document.getElementById(BADGE_STYLE_ID)?.remove();
}

function attachObserver() {
    if (mutationObserver || typeof MutationObserver === "undefined") return;

    mutationObserver = new MutationObserver(() => {
        // The observer has to watch the whole document (Discord's own DOM structure
        // gives us no safe, stable, narrower container to scope to), so it fires on
        // every DOM change app-wide - typing elsewhere, other channels' messages,
        // tooltips, etc. Bailing out here before touching the debounce timer avoids
        // that overhead entirely whenever the plugin isn't even relevant, instead of
        // only bailing out later inside refreshHighlights() after the timer already fired.
        if (!settings.store.enabled || !isInTargetForumContext()) return;
        scheduleRefresh();
    });
    mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
    });
}

function detachObserver() {
    mutationObserver?.disconnect();
    mutationObserver = null;
    if (refreshTimer != null) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
    scanQueued = false;
}

function attachHeartbeat() {
    if (heartbeatTimer != null) return;
    heartbeatTimer = window.setInterval(() => {
        // Mirror the mutation observer's bail-out: no point even queuing a debounced
        // scan (and the isInTargetForumContext() check refreshHighlights() would do
        // anyway) when we're not somewhere the plugin is relevant.
        if (!settings.store.enabled || !isInTargetForumContext()) return;
        scheduleRefresh();
    }, TIMING.heartbeatIntervalMs);
}

function detachHeartbeat() {
    if (heartbeatTimer != null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

function isTargetForumThread(channelId: string | undefined) {
    if (!channelId) return false;

    const channel = ChannelStore.getChannel(channelId);
    return channel?.parent_id === FIXED_IDS.forumChannelId && channel.getGuildId() === FIXED_IDS.guildId;
}

// Store changes reach us as Flux events rather than through a React component
// subscribed with useStateFromStores: that selector re-ran on every MessageStore
// change app-wide (every message in every channel) and rebuilt the whole forum's
// signature string each time, while these handlers drop unrelated channels with a
// single lookup. buildThreadRecords()' signature check still skips no-op rebuilds.
function onForumDataChanged() {
    if (!settings.store.enabled || !isInTargetForumContext()) return;
    scheduleRefresh();
}

function onThreadEvent({ channel }: { channel?: { id?: string; parent_id?: string; }; }) {
    if (channel?.parent_id !== FIXED_IDS.forumChannelId) return;
    onForumDataChanged();
}

function onMessageEvent({ channelId, message }: { channelId?: string; message?: { channel_id?: string; }; }) {
    if (!isTargetForumThread(channelId ?? message?.channel_id)) return;
    onForumDataChanged();
}

const SETTINGS_PREFIX = "plugins.Pl5PostDuplicateHighlighter";

function buildViolationNoticeContext(thread: any, record: ThreadRecord): ViolationNoticeContext {
    const firstMessage = getFirstForumMessage(thread.id);
    const cooldownViolation = buildCooldownViolation(record);
    return {
        threadId: thread.id,
        threadTitle: thread.name ?? "",
        authorId: firstMessage?.author?.id ?? "",
        authorName: firstMessage?.author?.username ?? firstMessage?.author?.globalName ?? "",
        violations: cooldownViolation ? [cooldownViolation, ...record.violations] : record.violations,
        fdMatch: record.fdMatch,
    };
}

const patchThreadContextMenu: NavContextMenuPatchCallback = (children: any, { channel }: any) => {
    if (!settings.store.enabled) return;

    const thread = channel ?? null;
    if (!thread?.id || !thread?.isForumPost?.()) return;
    if (thread.parent_id !== FIXED_IDS.forumChannelId || thread.getGuildId() !== FIXED_IDS.guildId) return;

    const record = renderedRecords.get(thread.id);
    if (!record) return;

    if (record.duplicateSourceThreadId) {
        const sourceThread = ChannelStore.getChannel(record.duplicateSourceThreadId);
        if (sourceThread?.isForumPost?.()) {
            children.push(
                <Menu.MenuItem
                    id="vc-pl5-open-previous-duplicate"
                    label="Go to previous duplicate post"
                    action={() => ChannelRouter.transitionToThread(sourceThread)}
                />
            );
        }
    }

    // Always offered, even for posts with nothing auto-detected - the modal's
    // guideline picker lets a mod flag any C2 rule by hand.
    children.push(
        <Menu.MenuItem
            id="vc-pl5-copy-violation-text"
            label={record.violations.length || record.fdMatch || isDuplicateRecord(record) ? "Copy violation notice…" : "Create violation notice…"}
            action={() => openViolationTextModal(buildViolationNoticeContext(thread, record))}
        />
    );
};

export default definePlugin({
    name: "Pl5PostDuplicateHighlighter",
    description: "Highlights forum posts in the target channel that duplicate a recent post or appear to violate the C2 advertising guidelines.",
    authors: [
        {
            id: 471040217030328320n,
            name: "iBreeily",
        },
    ],
    settings,

    start() {
        logDebug("start()");
        injectBadgeStyles();
        setRecordsChangeListener(scheduleRefresh);
        // Every setting either changes what gets highlighted or how, so any change
        // rescans (buildThreadRecords' signature check skips the no-op cases).
        SettingsStore.addPrefixChangeListener(SETTINGS_PREFIX, scheduleRefresh);
        attachObserver();
        attachHeartbeat();
        scheduleRefresh();
    },

    stop() {
        logDebug("stop()");
        detachObserver();
        detachHeartbeat();
        SettingsStore.removePrefixChangeListener(SETTINGS_PREFIX, scheduleRefresh);

        for (const element of document.querySelectorAll<HTMLElement>("[data-vc-pl5-post-duplicate-highlighter]")) {
            clearHighlightFromCard(element);
        }
        for (const element of document.querySelectorAll<HTMLElement>("[data-vc-pl5-violations], [data-vc-pl5-fd]")) {
            removeViolationBadge(element);
        }
        removeBadgeStyles();

        renderedRecords.clear();
        lastRecordsSignature = "";
        postTextCache.clear();
        ruleViolationsCache.clear();
        messageFetchRetryState.clear();
        messageFetchQueue.length = 0;
        queuedOrFetchingMessageThreadIds.clear();
        activeMessageFetches = 0;
        similarityCache.clear();
        fetchedFirstMessages.clear();
        stopRecords();
        // duplicateHistory is intentionally left alone here (and persisted to
        // localStorage on every update) so the log survives a plugin restart
        // instead of resetting to empty every time the plugin is toggled/reloaded.
    },

    commands: [
        {
            name: "view-duplicate-history",
            description: "View the history of recent duplicate posts",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [],
            execute() {
                openHistoryModal();
            },
        }
    ],
    contextMenus: {
        "thread-context": patchThreadContextMenu,
    },

    // Subscribed in start() and unsubscribed in stop() by Vencord.
    flux: {
        THREAD_CREATE: onThreadEvent,
        THREAD_UPDATE: onThreadEvent,
        THREAD_LIST_SYNC: onForumDataChanged,
        MESSAGE_CREATE: onMessageEvent,
        MESSAGE_UPDATE: onMessageEvent,
        LOAD_MESSAGES_SUCCESS: onMessageEvent,
    },
});
