/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { RuleViolation } from "./rules";

export type HighlightState = "duplicate" | "unique" | "violation";
export type MatchReason = "title" | "invite" | "content";

export interface ThreadRecord {
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
    violations: RuleViolation[];
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
}
