/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { CACHE_KEYS, LIMITS } from "./constants";
import type { DuplicateHistoryEntry } from "./types";

// Duplicate-history log shared by index.tsx (which writes it on every scan) and
// DuplicateModal.tsx (which displays it). Lives here rather than in index.tsx so the
// modal doesn't have to import the plugin entry point.

let duplicateHistory: DuplicateHistoryEntry[] = readDuplicateHistoryCache();
let duplicateHistorySignature = computeDuplicateHistorySignature(duplicateHistory);
const duplicateHistoryListeners = new Set<() => void>();

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

function emitDuplicateHistory() {
    for (const listener of duplicateHistoryListeners) {
        try {
            listener();
        } catch {
            // Ignore listener failures.
        }
    }
}

export function getDuplicateHistory() {
    return duplicateHistory;
}

export function subscribeDuplicateHistory(listener: () => void) {
    duplicateHistoryListeners.add(listener);
    return () => {
        duplicateHistoryListeners.delete(listener);
    };
}

/** Merges freshly-computed entries into the persisted log, saving and notifying only on change. */
export function updateDuplicateHistory(liveHistory: DuplicateHistoryEntry[]) {
    // Merge into (rather than replace) the persisted log, so entries survive a plugin
    // or Discord restart even before the client has reloaded every thread/message that
    // originally fed a match.
    const history = mergeDuplicateHistory(duplicateHistory, liveHistory);
    const historySignature = computeDuplicateHistorySignature(history);
    if (historySignature === duplicateHistorySignature) return;

    duplicateHistorySignature = historySignature;
    duplicateHistory = history;
    writeDuplicateHistoryCache(history);
    emitDuplicateHistory();
}
