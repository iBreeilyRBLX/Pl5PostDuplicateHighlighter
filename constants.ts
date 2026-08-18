/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const LOG_PREFIX = "[Pl5PostDuplicateHighlighter]";

export const FIXED_IDS = {
    guildId: "553917324340625424",
    forumChannelId: "1210394762268643328",
} as const;

export const COLORS = {
    duplicate: 0xff6b6b,
    duplicateWarning: 0xfacc15,
    unique: 0x4ade80,
    violation: 0x00e5ff,
    official: 0xff69b4,
} as const;

export const LIMITS = {
    duplicateWindowMinutes: {
        default: 720,
        min: 1,
        max: 10080,
    },
    warningDuplicateThresholdMinutes: {
        default: 3,
        min: 1,
        max: 1440,
    },
    similarityCacheMaxEntries: 4000,
    // Persisted duplicate-history log cap (survives plugin/Discord restarts). Larger
    // than the 40-50 entries shown in the panel/modal so older matches remain
    // available in localStorage even after they scroll out of the visible list.
    duplicateHistoryMaxEntries: 200,
    maxConcurrentMessageFetches: 4,
    // Backoff for threads whose first message can't be fetched yet (rate limit,
    // transient error). Mirrors inviteResolutionRetry.
    messageFetchRetry: {
        baseMs: 10_000,
        maxMs: 5 * 60_000,
    },
} as const;

export const TIMING = {
    // The mutation observer watches the whole document (see attachObserver()), so
    // bursts of unrelated DOM churn (scrolling, hover states, virtualization) inside
    // the forum view can retrigger this repeatedly. 80ms let a lot of those bursts
    // each schedule their own full rescan; 250ms collapses far more of them into one
    // without feeling sluggish for a moderation tool.
    refreshDebounceMs: 250,
    heartbeatIntervalMs: 30_000,
} as const;

export const CACHE_KEYS = {
    duplicateHistory: "vc-pl5-duplicate-history-v1",
} as const;

export const PATTERNS = {
    discordInvite: /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-zA-Z0-9-]+)/i,
    snowflake: /\d{17,20}/g,
} as const;

export const BADGE_STYLE_ID = "vc-pl5-post-duplicate-highlighter-badge-style";
