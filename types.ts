/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { FdMatch } from "./records";
import type { RuleViolation } from "./rules";

export type HighlightState = "duplicate" | "unique" | "violation";
export type MatchReason = "title" | "invite" | "content" | "author";

export interface ThreadRecord {
    threadId: string;
    createdAt: number;
    // normalizeTitle() output - matched against card headings in the DOM fallback.
    title: string;
    // normalizeFactionName() output - what duplicate title matching compares, so
    // fancy-unicode/emoji-decorated reposts of the same title still match.
    titleKey: string;
    inviteCode: string;
    // Guild the invite points to: undefined while resolving (or not resolved because
    // the post is outside the duplicate window), null if it couldn't be resolved.
    inviteGuildId: string | null | undefined;
    authorId: string;
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
    violations: RuleViolation[];
    fdMatch: FdMatch | null;
}

export interface MatchEvaluation {
    matched: boolean;
    reasons: MatchReason[];
    contentSimilarity: number | null;
}

export interface DuplicateHistoryEntry {
    threadId: string;
    sourceThreadId: string;
    threadTitle: string;
    sourceTitle: string;
    deltaMs: number;
    reasons: MatchReason[];
    contentSimilarity: number | null;
    createdAt: number;

    // new fields
    authorName: string;
    authorId: string;
    contentSnippet: string;
    inviteCode: string;
    violations: { code: string; summary: string; }[];
    excludedByPattern: boolean;
}

export interface ForumCardMatch {
    element: HTMLElement;
    threadId: string;
}

export interface RecordSummary {
    threadId: string;
    title: string;
}

export interface ViolationNoticeContext {
    threadId: string;
    threadTitle: string;
    authorId: string;
    authorName: string;
    violations: RuleViolation[];
    fdMatch: FdMatch | null;
}
