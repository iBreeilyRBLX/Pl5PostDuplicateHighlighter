/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { ChannelRouter, ChannelStore, createRoot, Menu, MessageStore, React, SelectedChannelStore, useStateFromStores } from "@webpack/common";
import type { Root } from "react-dom/client";

const TARGET_GUILD_ID = "553917324340625424";
const TARGET_FORUM_CHANNEL_ID = "1210394762268643328";
const DEFAULT_DUPLICATE_COLOR = 0xff6b6b;
const DEFAULT_UNIQUE_COLOR = 0x4ade80;
const DEFAULT_DUPLICATE_WINDOW_MINUTES = 720;
const MIN_DUPLICATE_WINDOW_MINUTES = 1;
const MAX_DUPLICATE_WINDOW_MINUTES = 10080;
const FALLBACK_SIMILARITY_THRESHOLD = 75;
const DISCORD_INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-zA-Z0-9-]+)/i;
const SNOWFLAKE_RE = /\d{17,20}/g;

type HighlightState = "duplicate" | "unique";
type MatchReason = "title" | "invite" | "content";

interface ThreadRecord {
    threadId: string;
    createdAt: number;
    title: string;
    inviteCode: string;
    contentSnippet: string;
    highlight: HighlightState;
    duplicateUntil: number | null;
    duplicateSourceThreadId: string | null;
    matchedPreviousThreadId: string | null;
    matchedPreviousDeltaMs: number | null;
    matchedPreviousTitle: string;
    matchedReasons: MatchReason[];
    matchedContentSimilarity: number | null;
    excludedByPattern: boolean;
}

interface MatchEvaluation {
    matched: boolean;
    reasons: MatchReason[];
    contentSimilarity: number | null;
}

interface DuplicateHistoryEntry {
    threadId: string;
    sourceThreadId: string;
    threadTitle: string;
    sourceTitle: string;
    deltaMs: number;
    reasons: MatchReason[];
    contentSimilarity: number | null;
    createdAt: number;
}

interface ForumCardMatch {
    element: HTMLElement;
    threadId: string;
}

interface RecordSummary {
    threadId: string;
    title: string;
}

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
    duplicateWindowMinutes: {
        type: OptionType.NUMBER,
        default: DEFAULT_DUPLICATE_WINDOW_MINUTES,
        description: "Duplicate window in minutes (type a value, e.g. 720)",
        isValid(value: number) {
            const numericValue = Number(value);
            if (!Number.isFinite(numericValue)) return "Enter a valid number of minutes";
            if (numericValue < MIN_DUPLICATE_WINDOW_MINUTES || numericValue > MAX_DUPLICATE_WINDOW_MINUTES) {
                return `Value must be between ${MIN_DUPLICATE_WINDOW_MINUTES} and ${MAX_DUPLICATE_WINDOW_MINUTES} minutes`;
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
        default: FALLBACK_SIMILARITY_THRESHOLD,
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
        component: () => <DuplicateHistoryPanel />,
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
let duplicateHistory: DuplicateHistoryEntry[] = [];
let duplicateHistorySignature = "";
const duplicateHistoryListeners = new Set<() => void>();
const postTextCache = new Map<string, { firstMessageId: string; content: string; inviteCode: string; }>();
const similarityCache = new Map<string, number>();
let excludeRegexCacheSource = "";
let excludeRegexCache: RegExp | null = null;

function logDebug(message: string, ...args: any[]) {
    if (!settings.store.debugLogs) return;
    console.log("[Pl5PostDuplicateHighlighter]", message, ...args);
}

function logDebugGroup(title: string, entries: Array<() => void>) {
    if (!settings.store.debugLogs) return;

    console.groupCollapsed(`[Pl5PostDuplicateHighlighter] ${title}`);
    try {
        for (const entry of entries) entry();
    } finally {
        console.groupEnd();
    }
}

function subscribeDuplicateHistory(listener: () => void) {
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

    React.useEffect(() => subscribeDuplicateHistory(() => setVersion(v => v + 1)), []);

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
    const threshold = Number(settings.store.similarityThreshold) || FALLBACK_SIMILARITY_THRESHOLD;
    return Math.min(100, Math.max(0, threshold)) / 100;
}

function getDuplicateWindowMs() {
    const minutes = Number(settings.store.duplicateWindowMinutes);
    const safeMinutes = Number.isFinite(minutes)
        ? Math.min(MAX_DUPLICATE_WINDOW_MINUTES, Math.max(MIN_DUPLICATE_WINDOW_MINUTES, minutes))
        : DEFAULT_DUPLICATE_WINDOW_MINUTES;

    return safeMinutes * 60 * 1000;
}

function normalizeTitle(title: string) {
    return title.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeContent(content: string) {
    return content.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
}

function extractInviteCode(content: string) {
    const inviteMatch = content.match(DISCORD_INVITE_RE);
    return inviteMatch?.[1].toLowerCase() ?? "";
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

function getConfiguredColor(kind: HighlightState) {
    return kind === "duplicate" ? DEFAULT_DUPLICATE_COLOR : DEFAULT_UNIQUE_COLOR;
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

    if (guildId !== TARGET_GUILD_ID) return null;
    if (second === TARGET_FORUM_CHANNEL_ID) return third ?? null;
    return second ?? null;
}

function extractKnownThreadIdFromText(value: string) {
    const ids = value.match(SNOWFLAKE_RE) ?? [];
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

    if (selectedChannelId === TARGET_FORUM_CHANNEL_ID) return true;

    const selectedChannel = ChannelStore.getChannel(selectedChannelId);
    if (!selectedChannel?.isForumPost?.()) return false;
    return selectedChannel.parent_id === TARGET_FORUM_CHANNEL_ID && selectedChannel.getGuildId() === TARGET_GUILD_ID;
}

function getPostText(channelId: string) {
    const message = getFirstForumMessage(channelId);
    if (!message) {
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
                if (similarityCache.size > 4000) {
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

function formatDuration(ms: number) {
    const safe = Math.max(0, ms);
    if (safe <= 0) return "0m";

    const totalMinutes = Math.ceil(safe / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h`;
    return `${totalMinutes}m`;
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

function buildThreadRecords() {
    const windowMs = getDuplicateWindowMs();
    const threads = ChannelStore.getAllThreadsForParent(TARGET_FORUM_CHANNEL_ID)
        .filter(channel => channel?.isForumPost?.() && channel.getGuildId() === TARGET_GUILD_ID)
        .sort((left, right) => getThreadCreatedAt(left) - getThreadCreatedAt(right));

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
        };

        const { content, inviteCode } = getPostText(thread.id);
        record.inviteCode = inviteCode;
        record.contentSnippet = normalizeContent(content);

        const excludeRegex = getExcludeRegex();
        if (excludeRegex && (excludeRegex.test(record.title) || excludeRegex.test(record.contentSnippet))) {
            record.excludedByPattern = true;
            nextRecords.set(thread.id, record);
            continue;
        }

        const duplicateInfo = getDuplicateInfo(record, previousRecords, activeRecords, windowMs);
        record.highlight = duplicateInfo.isDuplicate ? "duplicate" : "unique";
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

    const history = [...nextRecords.values()]
        .filter(record => record.highlight === "duplicate" && record.matchedPreviousThreadId && record.matchedPreviousDeltaMs != null)
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 50)
        .map(record => {
            const source = nextRecords.get(record.matchedPreviousThreadId!) ?? null;
            return {
                threadId: record.threadId,
                sourceThreadId: record.matchedPreviousThreadId!,
                threadTitle: record.title,
                sourceTitle: source?.title ?? "",
                deltaMs: record.matchedPreviousDeltaMs!,
                reasons: record.matchedReasons,
                contentSimilarity: record.matchedContentSimilarity,
                createdAt: record.createdAt,
            } as DuplicateHistoryEntry;
        });

    const historySignature = history.map(entry => `${entry.threadId}:${entry.sourceThreadId}:${entry.createdAt}`).join("|");
    if (historySignature !== duplicateHistorySignature) {
        duplicateHistorySignature = historySignature;
        duplicateHistory = history;
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

function getForumCardMatches(): ForumCardMatch[] {
    const cards = new Map<string, ForumCardMatch>();
    const headings = document.querySelectorAll<HTMLElement>("[role='heading'], h1, h2, h3, h4, h5, h6");
    const titleToThreadId = new Map<string, string>();
    const debugSamples: Array<{ heading: string; parsedThreadId: string | null; }> = [];

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

        if (debugSamples.length < 10) {
            debugSamples.push({
                heading: (heading.textContent ?? "").trim(),
                parsedThreadId: threadId,
            });
        }

        cards.set(threadId, { element: card, threadId });
    }

    const result = [...cards.values()];

    logDebugGroup("getForumCardMatches", [
        () => logDebug("headingCount", headings.length),
        () => logDebug("matchedCards", result.length),
        () => logDebug("matchedThreadIds", result.slice(0, 20).map(c => c.threadId)),
    ]);

    // Plain log to avoid losing key info in collapsed groups.
    logDebug("getForumCardMatches summary", {
        headingCount: headings.length,
        matchedCards: result.length,
        sampleThreadIds: result.slice(0, 5).map(c => c.threadId),
        sampleMatches: debugSamples,
    });

    return result;
}

function setCardStyle(element: HTMLElement, property: string, value: string) {
    element.style.setProperty(property, value, "important");
}

function applyHighlightToCard(element: HTMLElement, record: ThreadRecord) {
    if (record.highlight === "unique" && !settings.store.tintUniquePosts) {
        element.dataset.vcPl5PostDuplicateHighlighter = record.highlight;
        element.style.removeProperty("background-color");
        element.style.removeProperty("border-color");
        element.style.removeProperty("border-style");
        element.style.removeProperty("border-width");
        element.style.removeProperty("box-shadow");
        applyExpiryTooltip(element, record);
        return;
    }

    const color = getConfiguredColor(record.highlight);
    const rgb = `#${color.toString(16).padStart(6, "0")}`;
    const translucent = hexToRgba(color, 0.12);

    element.dataset.vcPl5PostDuplicateHighlighter = record.highlight;
    setCardStyle(element, "background-color", translucent);
    element.style.removeProperty("border-color");
    element.style.removeProperty("border-style");
    element.style.removeProperty("border-width");
    element.style.removeProperty("box-shadow");
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
    const targets: HTMLElement[] = [element];

    // Legacy cleanup: previous versions also tinted parent/child containers.
    if (element.parentElement) targets.push(element.parentElement);
    const firstChild = element.firstElementChild;
    if (firstChild instanceof HTMLElement) targets.push(firstChild);

    for (const target of targets) {
        target.style.removeProperty("background-color");
        target.style.removeProperty("border-color");
        target.style.removeProperty("border-style");
        target.style.removeProperty("border-width");
        target.style.removeProperty("box-shadow");
    }

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
            console.error("[Pl5PostDuplicateHighlighter] Failed to refresh forum highlights", error);
        }
    }, 80);
}

function attachObserver() {
    if (mutationObserver || typeof MutationObserver === "undefined") return;

    mutationObserver = new MutationObserver(() => scheduleRefresh());
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
    heartbeatTimer = window.setInterval(() => scheduleRefresh(), 30000);
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
        "duplicateWindowMinutes",
        "excludePatternRegex",
        "checkTitle",
        "checkInvite",
        "checkContent",
        "similarityThreshold",
        "showExpiryTooltip",
        "tintUniquePosts",
        "debugLogs",
    ]);

    useStateFromStores(
        [ChannelStore, MessageStore, SelectedChannelStore],
        () => {
            const threads = ChannelStore.getAllThreadsForParent(TARGET_FORUM_CHANNEL_ID)
                .filter(channel => channel?.isForumPost?.() && channel.getGuildId() === TARGET_GUILD_ID);
            const selected = SelectedChannelStore.getChannelId() ?? "";
            return `${selected}|${threads.map(thread => `${thread.id}:${thread.lastMessageId ?? ""}:${thread.messageCount ?? 0}:${MessageStore.getMessages(thread.id)?._array.length ?? 0}`).join("|")}`;
        },
        null,
        (oldValue, newValue) => oldValue === newValue
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
    reactRoot.render(<Driver />);
}

function unmountDriver() {
    reactRoot?.unmount();
    reactRoot = null;
    mountNode?.remove();
    mountNode = null;
}

const patchThreadContextMenu: NavContextMenuPatchCallback = (children, { channel }: any) => {
    if (!settings.store.enabled) return;

    const thread = channel ?? null;
    if (!thread?.id || !thread?.isForumPost?.()) return;
    if (thread.parent_id !== TARGET_FORUM_CHANNEL_ID || thread.getGuildId() !== TARGET_GUILD_ID) return;

    const record = renderedRecords.get(thread.id);
    if (!record?.duplicateSourceThreadId) return;

    const sourceThread = ChannelStore.getChannel(record.duplicateSourceThreadId);
    if (!sourceThread?.isForumPost?.()) return;

    children.push(
        <Menu.MenuItem
            id="vc-pl5-open-previous-duplicate"
            label="Go to previous duplicate post"
            action={() => ChannelRouter.transitionToThread(sourceThread)}
        />
    );
};

export default definePlugin({
    name: "Pl5PostDuplicateHighlighter",
    description: "Highlights forum posts in the target channel when they appear to duplicate a recent post.",
    authors: [
        {
            id: 471040217030328320n,
            name: "iBreeily",
        },
    ],
    settings,
    contextMenus: {
        "thread-context": patchThreadContextMenu,
    },

    start() {
        logDebug("start()");
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

        renderedRecords.clear();
        postTextCache.clear();
        similarityCache.clear();
        duplicateHistory = [];
        duplicateHistorySignature = "";
        emitDuplicateHistory();
    },
});
