/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ApplicationCommandInputType } from "@api/Commands";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Button, ChannelRouter, ChannelStore, createRoot, Menu, MessageActions, MessageStore, React, SelectedChannelStore, useStateFromStores } from "@webpack/common";
import type { Root } from "react-dom/client";

import { BADGE_STYLE_ID, CACHE_KEYS, COLORS, FIXED_IDS, LIMITS, LOG_PREFIX, PATTERNS, TIMING } from "./constants";
import { openDuplicateHistoryModal } from "./DuplicateModal";
import { checkRules, type RuleCheckOptions, type RuleViolation } from "./rules";
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
        description: "Compare normalized post titles",
    },
    checkInvite: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Compare Discord invite codes found in the first message",
    },
    checkContent: {
        type: OptionType.BOOLEAN,
        default: true,
        description: "Compare the first 80 characters of the first message content",
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
    duplicateHistoryPanel: {
        type: OptionType.COMPONENT,
        description: "Recent duplicate matches",
        component: () => (
            <Button size={Button.Sizes.SMALL} onClick={openDuplicateHistoryModal}>
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

let mountNode: HTMLDivElement | null = null;
let reactRoot: Root | null = null;
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
export let duplicateHistory: DuplicateHistoryEntry[] = readDuplicateHistoryCache();
let duplicateHistorySignature = computeDuplicateHistorySignature(duplicateHistory);
const duplicateHistoryListeners = new Set<() => void>();
const postTextCache = new Map<string, { firstMessageId: string; content: string; inviteCode: string; }>();
// checkRules() runs a dozen-plus regexes (title quality, invite counting, and
// especially the C2-11 AI-signal detector) over full post content. Without this
// cache it re-ran on every thread on every scan - every mutation-observer tick and
// every 30s heartbeat - even when nothing about that post had changed, which was a
// major source of the "laggy while browsing the forum" cost. Keyed by thread id;
// invalidated when the first message, title, tags, or rule settings actually change.
const ruleViolationsCache = new Map<string, { firstMessageId: string; rawTitle: string; appliedTagsKey: string; optionsKey: string; violations: RuleViolation[]; }>();
// Backoff bookkeeping for threads whose first message failed to fetch at least once.
const messageFetchRetryState = new Map<string, { failCount: number; nextRetryAt: number; }>();
// Bounded-concurrency queue for proactively fetching a forum thread's first message
// when it isn't already cached client-side (e.g. right after a restart, or for a post
// the officer hasn't opened yet) - without this, duplicate/violation checks that need
// message content, and history entries that need the author, silently fall back to
// empty/"Unknown" until someone happens to open the thread.
const messageFetchQueue: string[] = [];
const queuedOrFetchingMessageThreadIds = new Set<string>();
let activeMessageFetches = 0;
const similarityCache = new Map<string, number>();
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

function isDuplicateHistoryEntry(value: unknown): value is DuplicateHistoryEntry {
    if (!value || typeof value !== "object") return false;

    const entry = value as Partial<DuplicateHistoryEntry>;
    return typeof entry.threadId === "string"
        && typeof entry.sourceThreadId === "string"
        && typeof entry.createdAt === "number"
        && Array.isArray(entry.reasons)
        && Array.isArray(entry.violations);
}

function readDuplicateHistoryCache(): DuplicateHistoryEntry[] {
    try {
        const raw = localStorage.getItem(CACHE_KEYS.duplicateHistory);
        if (!raw) return [];

        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];

        return parsed.filter(isDuplicateHistoryEntry).slice(0, LIMITS.duplicateHistoryMaxEntries);
    } catch {
        return [];
    }
}

function writeDuplicateHistoryCache(history: DuplicateHistoryEntry[]) {
    try {
        localStorage.setItem(CACHE_KEYS.duplicateHistory, JSON.stringify(history));
    } catch {
        // Ignore storage failures (quota exceeded, private browsing, etc).
    }
}

function computeDuplicateHistorySignature(history: DuplicateHistoryEntry[]) {
    return history.map(entry => `${entry.threadId}:${entry.sourceThreadId}:${entry.createdAt}`).join("|");
}

function mergeDuplicateHistoryEntry(previous: DuplicateHistoryEntry, incoming: DuplicateHistoryEntry): DuplicateHistoryEntry {
    // Prefer the freshly-computed entry, but a scan that ran before this thread's first
    // message was cached (author "Unknown", empty snippet/invite) shouldn't clobber
    // better data an earlier scan already recorded for the same thread.
    return {
        ...incoming,
        authorName: incoming.authorName && incoming.authorName !== "Unknown" ? incoming.authorName : previous.authorName,
        authorId: incoming.authorId || previous.authorId,
        contentSnippet: incoming.contentSnippet || previous.contentSnippet,
        inviteCode: incoming.inviteCode || previous.inviteCode,
    };
}

function mergeDuplicateHistory(existing: DuplicateHistoryEntry[], incoming: DuplicateHistoryEntry[]) {
    const merged = new Map<string, DuplicateHistoryEntry>();

    // Persisted entries first, then let a freshly-computed entry for the same thread
    // overwrite it with up-to-date data. This is what makes the log survive a plugin
    // or Discord restart instead of resetting to only whatever's currently loaded in
    // the client's thread/message caches.
    for (const entry of existing) merged.set(entry.threadId, entry);
    for (const entry of incoming) {
        const previous = merged.get(entry.threadId);
        merged.set(entry.threadId, previous ? mergeDuplicateHistoryEntry(previous, entry) : entry);
    }

    return [...merged.values()]
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, LIMITS.duplicateHistoryMaxEntries);
}

export function subscribeDuplicateHistory(listener: () => void) {
    duplicateHistoryListeners.add(listener);
    return () => {
        duplicateHistoryListeners.delete(listener);
    };
}

function emitDuplicateHistory() {
    for (const listener of duplicateHistoryListeners) {
        try {
            listener();
        } catch {
            // Ignore listener failures.
        }
    }
}

function DuplicateHistoryPanel() {
    const [, setVersion] = React.useState(0);

    React.useEffect(() => subscribeDuplicateHistory(() => setVersion((v: number) => v + 1)), []);

    const items = duplicateHistory.slice(0, 30);
    if (!items.length) {
        return <div style={{ opacity: 0.8 }}>No duplicate history yet.</div>;
    }

    return (
        <div style={{ display: "grid", gap: 6, maxHeight: 260, overflowY: "auto", paddingRight: 4 }}>
            {items.map(item => {
                const reasonText = item.reasons.map(reason => reason.toUpperCase()).join(", ") || "NONE";
                const similarityText = item.contentSimilarity == null ? "" : ` (${Math.round(item.contentSimilarity * 100)}%)`;
                return (
                    <div key={`${item.threadId}:${item.sourceThreadId}`} style={{ fontSize: 12, lineHeight: 1.3, opacity: 0.95 }}>
                        <strong>{item.threadTitle || item.threadId}</strong>
                        <div>matches {item.sourceTitle || item.sourceThreadId}</div>
                        <div>{formatDuration(item.deltaMs)} apart | {reasonText}{similarityText}</div>
                    </div>
                );
            })}
        </div>
    );
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

function formatMatchReasons(reasons: MatchReason[], contentSimilarity: number | null) {
    if (!reasons.length) return "none";

    return reasons.join(", ");
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

function normalizeTitle(title: string) {
    return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeContent(content: string) {
    return content.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
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
        aiSignalThreshold: Number(settings.store.aiSignalThreshold) || 3,
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
        // Forum threads are typically short, so the latest `limit` messages almost
        // always include the opening post; this mirrors the fetchMessages usage
        // elsewhere in Vencord rather than reaching for a lower-level API.
        await MessageActions.fetchMessages({ channelId: threadId, limit: 50 });
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

function getFirstForumMessage(channelId: string) {
    const channel = ChannelStore.getChannel(channelId);
    const messages = MessageStore.getMessages(channelId)?._array ?? [];

    for (const message of messages) {
        if ((message as any).isFirstMessageInForumPost?.(channel)) return message;
    }

    let oldest = messages[0];
    for (let i = 1; i < messages.length; i++) {
        const current = messages[i];
        if (!oldest) {
            oldest = current;
            continue;
        }

        try {
            if (BigInt(current.id) < BigInt(oldest.id)) {
                oldest = current;
            }
        } catch {
            continue;
        }
    }

    return oldest;
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
        // staying empty until someone happens to open the thread.
        scheduleFirstMessageFetch(channelId);
        return { content: "", inviteCode: "" };
    }

    const cached = postTextCache.get(channelId);
    if (cached && cached.firstMessageId === message.id) {
        return {
            content: cached.content,
            inviteCode: cached.inviteCode,
        };
    }

    const content = typeof message.content === "string" ? message.content : "";
    const inviteCode = extractInviteCode(content);

    postTextCache.set(channelId, {
        firstMessageId: message.id,
        content,
        inviteCode,
    });

    return {
        content,
        inviteCode,
    };
}

function levenshteinSimilarity(a: string, b: string) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;

    const previous = new Array(b.length + 1);
    const current = new Array(b.length + 1);

    for (let j = 0; j <= b.length; j++) previous[j] = j;

    for (let i = 1; i <= a.length; i++) {
        current[0] = i;
        const aChar = a.charCodeAt(i - 1);

        for (let j = 1; j <= b.length; j++) {
            const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
            current[j] = Math.min(
                previous[j] + 1,
                current[j - 1] + 1,
                previous[j - 1] + cost,
            );
        }

        for (let j = 0; j <= b.length; j++) previous[j] = current[j];
    }

    const distance = previous[b.length];
    return 1 - (distance / Math.max(a.length, b.length));
}

function evaluateMatch(
    left: ThreadRecord,
    right: ThreadRecord,
    titleEnabled: boolean,
    inviteEnabled: boolean,
    contentEnabled: boolean,
    similarityThreshold: number,
): MatchEvaluation {
    const reasons: MatchReason[] = [];
    let contentSimilarity: number | null = null;

    if (titleEnabled && left.title && right.title && left.title === right.title) {
        reasons.push("title");
    }

    if (inviteEnabled && left.inviteCode && right.inviteCode && left.inviteCode === right.inviteCode) {
        reasons.push("invite");
    }

    if (contentEnabled && left.contentSnippet && right.contentSnippet) {
        const lengthDelta = Math.abs(left.contentSnippet.length - right.contentSnippet.length);
        const maxLength = Math.max(left.contentSnippet.length, right.contentSnippet.length);
        if (!maxLength || lengthDelta / maxLength <= (1 - similarityThreshold)) {
            const similarityCacheKey = `${left.threadId}|${right.threadId}|${left.contentSnippet}|${right.contentSnippet}`;
            let similarity = similarityCache.get(similarityCacheKey);
            if (similarity == null) {
                similarity = levenshteinSimilarity(left.contentSnippet, right.contentSnippet);
                if (similarityCache.size > LIMITS.similarityCacheMaxEntries) {
                    similarityCache.clear();
                }
                similarityCache.set(similarityCacheKey, similarity);
            }

            contentSimilarity = similarity;
            if (similarity >= similarityThreshold) {
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
    const titleEnabled = settings.store.checkTitle;
    const inviteEnabled = settings.store.checkInvite;
    const contentEnabled = settings.store.checkContent;
    const similarityThreshold = getSimilarityThreshold();
    let duplicateUntil: number | null = null;
    let duplicateSourceThreadId: string | null = null;
    let matchedPreviousThreadId: string | null = null;
    let matchedPreviousDeltaMs: number | null = null;
    let matchedPreviousTitle = "";
    let matchedReasons: MatchReason[] = [];
    let matchedContentSimilarity: number | null = null;

    const markDuplicate = (previous: ThreadRecord, match: MatchEvaluation) => {
        const expiresAt = previous.createdAt + windowMs;
        if (duplicateUntil == null || expiresAt > duplicateUntil) {
            duplicateUntil = expiresAt;
            duplicateSourceThreadId = previous.threadId;

            if (matchedPreviousThreadId == null) {
                matchedPreviousThreadId = previous.threadId;
                matchedPreviousDeltaMs = Math.max(0, record.createdAt - previous.createdAt);
                matchedPreviousTitle = previous.title;
                matchedReasons = [...match.reasons];
                matchedContentSimilarity = match.contentSimilarity;
            }
        }
    };

    for (const previous of previousRecords) {
        const match = evaluateMatch(record, previous, titleEnabled, inviteEnabled, contentEnabled, similarityThreshold);
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
    }

    for (const previous of activeRecords) {
        const match = evaluateMatch(record, previous, titleEnabled, inviteEnabled, contentEnabled, similarityThreshold);
        if (match.matched) {
            markDuplicate(previous, match);
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

export function formatDuration(ms: number) {
    const safe = Math.max(0, ms);
    if (safe <= 0) return "0m";

    const totalMinutes = Math.ceil(safe / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    return `${totalMinutes}m`;
}

// Prose duration for violation-notice text, e.g. "1 hour and 24 minutes" /
// "45 minutes", matching the wording used in the C2 warning templates.
function formatDurationWords(ms: number) {
    const totalMinutes = Math.max(0, Math.round(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    const hourPart = hours > 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : "";
    const minutePart = minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "";

    if (hourPart && minutePart) return `${hourPart} and ${minutePart}`;
    return hourPart || minutePart || "0 minutes";
}

function formatCooldownWindowLabel(ms: number) {
    const totalMinutes = Math.max(0, Math.round(ms / 60000));
    if (totalMinutes > 0 && totalMinutes % 60 === 0) {
        return `${totalMinutes / 60}-hour cooldown`;
    }

    return `${formatDurationWords(ms)} cooldown`;
}

// C2-2: re-posting before the duplicate window (cooldown) has elapsed. This isn't
// one of the rules.ts content checks - it's derived from the duplicate match itself -
// so it's synthesized here rather than returned from checkRules().
function buildCooldownViolation(record: ThreadRecord): RuleViolation | null {
    if (record.highlight !== "duplicate" || record.matchedPreviousDeltaMs == null) return null;

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
        settings.store.similarityThreshold,
        settings.store.ruleMultipleInvites,
        settings.store.ruleMissingTags,
        settings.store.ruleTitleQuality,
        settings.store.ruleUndisclosedAi,
        settings.store.aiSignalThreshold,
    ].join("|");

    const threadsKey = threads
        .map((thread: any) => `${thread.id}:${thread.lastMessageId ?? ""}:${thread.messageCount ?? 0}:${MessageStore.getMessages(thread.id)?._array.length ?? 0}:${((thread as any).appliedTags ?? []).join(",")}`)
        .join("|");

    return `${settingsKey}::${threadsKey}`;
}

function buildThreadRecords() {
    const windowMs = getDuplicateWindowMs();
    const threads = ChannelStore.getAllThreadsForParent(FIXED_IDS.forumChannelId)
        .filter((channel: any) => channel?.isForumPost?.() && channel.getGuildId() === FIXED_IDS.guildId)
        .sort((left: any, right: any) => getThreadCreatedAt(left) - getThreadCreatedAt(right));

    const signature = computeRecordsSignature(threads);
    if (signature === lastRecordsSignature) {
        logDebug("buildThreadRecords skipped: no relevant change since last scan", {
            totalThreads: threads.length,
        });
        return;
    }
    lastRecordsSignature = signature;

    const activeRecords: ThreadRecord[] = [];
    const previousRecords: ThreadRecord[] = [];
    const nextRecords = new Map<string, ThreadRecord>();

    for (const thread of threads) {
        const createdAt = getThreadCreatedAt(thread);
        const cutoff = createdAt - windowMs;

        while (activeRecords.length && activeRecords[0].createdAt < cutoff) {
            activeRecords.shift();
        }

        const record: ThreadRecord = {
            threadId: thread.id,
            createdAt,
            title: normalizeTitle(thread.name ?? ""),
            inviteCode: "",
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
        };

        const { content, inviteCode } = getPostText(thread.id);
        record.inviteCode = inviteCode;
        record.contentSnippet = normalizeContent(content);

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
        // Violations on duplicate posts still surface via badge + tooltip.
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

    const liveHistory = [...nextRecords.values()]
        .filter(record => record.highlight === "duplicate" && record.matchedPreviousThreadId && record.matchedPreviousDeltaMs != null)
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
            } as DuplicateHistoryEntry;
        });

    // Merge into (rather than replace) the persisted log, so entries survive a plugin
    // or Discord restart even before the client has reloaded every thread/message that
    // originally fed a match.
    const history = mergeDuplicateHistory(duplicateHistory, liveHistory);
    const historySignature = computeDuplicateHistorySignature(history);
    if (historySignature !== duplicateHistorySignature) {
        duplicateHistorySignature = historySignature;
        duplicateHistory = history;
        writeDuplicateHistoryCache(history);
        emitDuplicateHistory();
    }

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

function setCardStyle(element: HTMLElement, property: string, value: string) {
    element.style.setProperty(property, value, "important");
}

function applyViolationBadge(element: HTMLElement, record: ThreadRecord) {
    if (!settings.store.showViolationBadge || !record.violations.length) {
        removeViolationBadge(element);
        return;
    }

    // The ::after badge is absolutely positioned, so the card needs to be a
    // positioning context. Only patch cards that are position: static so we
    // never break Discord's own absolutely-positioned list items.
    if (element.dataset.vcPl5PositionPatched !== "1" && getComputedStyle(element).position === "static") {
        element.dataset.vcPl5PositionPatched = "1";
        element.style.setProperty("position", "relative");
    }

    element.setAttribute("data-vc-pl5-violations", record.violations.map(violation => violation.code).join(" "));
}

function removeViolationBadge(element: HTMLElement) {
    element.removeAttribute("data-vc-pl5-violations");
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
        record.excludedByPattern,
        record.violations.map(violation => `${violation.code}:${violation.summary}`).join(","),
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
        element.style.removeProperty("box-shadow");
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
    element.style.removeProperty("box-shadow");
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

function Driver() {
    settings.use([
        "enabled",
        "warningDuplicateThresholdMinutes",
        "duplicateWindowMinutes",
        "excludePatternRegex",
        "checkTitle",
        "checkInvite",
        "checkContent",
        "similarityThreshold",
        "showExpiryTooltip",
        "tintUniquePosts",
        "ruleMultipleInvites",
        "ruleMissingTags",
        "ruleTitleQuality",
        "ruleUndisclosedAi",
        "aiSignalThreshold",
        "showViolationBadge",
        "debugLogs",
    ]);

    useStateFromStores(
        [ChannelStore, MessageStore, SelectedChannelStore],
        () => {
            const threads = ChannelStore.getAllThreadsForParent(FIXED_IDS.forumChannelId)
                .filter((channel: any) => channel?.isForumPost?.() && channel.getGuildId() === FIXED_IDS.guildId);
            const selected = SelectedChannelStore.getChannelId() ?? "";
            return `${selected}|${threads.map((thread: any) => `${thread.id}:${thread.lastMessageId ?? ""}:${thread.messageCount ?? 0}:${MessageStore.getMessages(thread.id)?._array.length ?? 0}:${((thread as any).appliedTags ?? []).join(",")}`).join("|")}`;
        },
        null,
        (oldValue: any, newValue: any) => oldValue === newValue
    );

    React.useEffect(() => {
        logDebug("Driver effect scheduleRefresh()");
        scheduleRefresh();
    }, []);

    return null;
}

function mountDriver() {
    if (typeof document === "undefined" || mountNode) return;

    mountNode = document.createElement("div");
    mountNode.id = "vc-pl5-post-duplicate-highlighter";
    mountNode.style.display = "none";
    document.body.appendChild(mountNode);

    reactRoot = createRoot(mountNode);
    reactRoot?.render(<Driver />);
}

function unmountDriver() {
    reactRoot?.unmount();
    reactRoot = null;
    mountNode?.remove();
    mountNode = null;
}

function buildViolationNoticeContext(thread: any, record: ThreadRecord): ViolationNoticeContext {
    const firstMessage = getFirstForumMessage(thread.id);
    const cooldownViolation = buildCooldownViolation(record);
    return {
        threadId: thread.id,
        threadTitle: thread.name ?? "",
        authorId: firstMessage?.author?.id ?? "",
        authorName: firstMessage?.author?.username ?? firstMessage?.author?.globalName ?? "",
        violations: cooldownViolation ? [cooldownViolation, ...record.violations] : record.violations,
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

    if (record.violations.length || record.highlight === "duplicate") {
        children.push(
            <Menu.MenuItem
                id="vc-pl5-copy-violation-text"
                label="Copy violation notice…"
                action={() => openViolationTextModal(buildViolationNoticeContext(thread, record))}
            />
        );
    }
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
        mountDriver();
        attachObserver();
        attachHeartbeat();
        scheduleRefresh();
    },

    stop() {
        logDebug("stop()");
        detachObserver();
        detachHeartbeat();
        unmountDriver();

        for (const element of document.querySelectorAll<HTMLElement>("[data-vc-pl5-post-duplicate-highlighter]")) {
            clearHighlightFromCard(element);
        }
        for (const element of document.querySelectorAll<HTMLElement>("[data-vc-pl5-violations]")) {
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
                openDuplicateHistoryModal();
            },
        }
    ],
    contextMenus: {
        "thread-context": patchThreadContextMenu,
    },
});
