/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PluginNative } from "@utils/types";
import { InviteActions } from "@webpack/common";

import { CACHE_KEYS, LIMITS, LOG_PREFIX } from "./constants";
import { levenshteinSimilarity } from "./similarity";
import { normalizeFactionName } from "./text";

// FD sanction records (blacklists / warnings) from https://pl5fd.com/api/records.
// Lookups are asynchronous and rate limited (30 req/min public), so getFdMatch()
// only ever reads the cache synchronously and queues whatever is missing; the
// plugin rescans via the onChange callback once results land.

const Native = VencordNative?.pluginHelpers?.Pl5PostDuplicateHighlighter as PluginNative<typeof import("./native")> | undefined;

export type FdLookupField = "discordUserId" | "name" | "serverId";
export type FdRecordKind = "Blacklist" | "Warning" | "User Violation";

export interface FdRecord {
    kind: FdRecordKind;
    id: string;
    primaryName: string;
    serverId: string | null;
    discordUserId: string | null;
    discordTag: string | null;
    robloxUsername: string | null;
    status: string | null;
    violationCodes: string[];
    description: string | null;
    sanctionDate: string | null;
    appealDate: string | null;
    expirationDate: string | null;
    evidenceUrl: string | null;
}

export type FdMatchSource = "author" | "name" | "server";

export interface FdMatchedRecord {
    record: FdRecord;
    sources: FdMatchSource[];
    // false for expired / appealed records - still shown, just as history
    active: boolean;
}

export interface FdMatch {
    // confirmed: invite's guild ID equals a record's serverId
    // author: post author's Discord ID is on a record (user or server owner)
    // name: only the post title resembles a record's name - a "possible" match
    level: "confirmed" | "author" | "name";
    // Based on active records when there are any, otherwise on the past ones.
    kind: "blacklist" | "warning";
    hasActive: boolean;
    // Active records first, then past ones.
    records: FdMatchedRecord[];
    inviteGuildId: string | null;
    // Name-only match whose invite server ID was looked up and isn't in the FD
    // database, but some record has no server ID on file so it can't be ruled out.
    // (If every record lists a different server ID, the match is dropped entirely.)
    notInDb: boolean;
}

export interface FdMatchOptions {
    checkAuthor: boolean;
    checkTitle: boolean;
    confirmViaInvite: boolean;
}

interface CacheEntry {
    results: FdRecord[];
    fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const failState = new Map<string, { failCount: number; nextRetryAt: number; }>();
const queue: string[] = [];
const queued = new Set<string>();
const requestTimes: number[] = [];
let activeRequests = 0;
let pausedUntil = 0;
let pumpTimer: number | null = null;
let persistTimer: number | null = null;
let version = 0;
let cacheLoaded = false;
let onChange: () => void = () => { };

const inviteGuildCache = new Map<string, { guildId: string | null; fetchedAt: number; }>();
const inviteInFlight = new Set<string>();
// Invite resolves are queued too: duplicate matching asks for every in-window post's
// invite on the first scan, which would otherwise fire dozens of Discord requests at once.
const inviteQueue: string[] = [];
let activeInviteResolves = 0;

// Words that are too common in faction names to search by (they'd match dozens of
// unrelated records) or to count as a name match on their own.
const GENERIC_NAME_WORDS = new Set([
    "the", "of", "and", "pmc", "company", "army", "corps", "division", "battalion", "regiment",
    "group", "faction", "server", "community", "roblox", "brm5", "official", "military", "forces",
    "force", "recruiting", "now", "open", "new", "join", "private", "team", "squad", "unit", "clan",
    "brigade", "platoon", "legion", "task", "special", "operations", "ops", "rp", "roleplay",
]);

export function setRecordsChangeListener(listener: () => void) {
    onChange = listener;
}

export function getRecordsVersion() {
    return version;
}

function cacheKey(field: FdLookupField, query: string) {
    return `${field}:${query}`;
}

// Both caches are persisted/refreshed but would otherwise grow for as long as Discord
// stays open. Map iteration is insertion order, so re-inserting on write keeps the
// first key the least recently written one.
function setBounded<V>(map: Map<string, V>, key: string, value: V) {
    map.delete(key);
    map.set(key, value);
    while (map.size > LIMITS.records.cacheMaxEntries) {
        map.delete(map.keys().next().value!);
    }
}

function bump() {
    version++;
    onChange();
}

function loadCache() {
    if (cacheLoaded) return;
    cacheLoaded = true;

    try {
        const raw = localStorage.getItem(CACHE_KEYS.fdRecords);
        if (!raw) return;

        const parsed = JSON.parse(raw) as Record<string, CacheEntry>;
        const now = Date.now();
        for (const [key, entry] of Object.entries(parsed)) {
            if (entry && Array.isArray(entry.results) && now - entry.fetchedAt < LIMITS.records.cacheTtlMs) {
                setBounded(cache, key, entry);
            }
        }
    } catch {
        // Corrupt or unavailable storage just means a cold cache.
    }
}

function schedulePersist() {
    if (persistTimer != null) return;

    persistTimer = window.setTimeout(() => {
        persistTimer = null;
        try {
            const now = Date.now();
            const entries = [...cache.entries()]
                .filter(([, entry]) => now - entry.fetchedAt < LIMITS.records.cacheTtlMs)
                .slice(-LIMITS.records.cacheMaxEntries);
            localStorage.setItem(CACHE_KEYS.fdRecords, JSON.stringify(Object.fromEntries(entries)));
        } catch {
            // Best effort only.
        }
    }, 2000);
}

function schedulePump(delayMs: number) {
    if (pumpTimer != null) return;

    pumpTimer = window.setTimeout(() => {
        pumpTimer = null;
        pump();
    }, Math.max(50, delayMs));
}

function pump() {
    while (activeRequests < LIMITS.records.maxConcurrentRequests && queue.length) {
        const now = Date.now();
        if (now < pausedUntil) {
            schedulePump(pausedUntil - now);
            return;
        }

        while (requestTimes.length && now - requestTimes[0] >= 60_000) requestTimes.shift();
        if (requestTimes.length >= LIMITS.records.requestsPerMinute) {
            schedulePump(requestTimes[0] + 60_000 - now);
            return;
        }

        const key = queue.shift()!;
        requestTimes.push(now);
        void runLookup(key);
    }
}

async function requestRecords(field: FdLookupField, query: string) {
    if (Native) return Native.searchRecords(field, query);

    // Non-desktop builds have no native helper; this only works where the page's
    // CSP allows pl5fd.com.
    try {
        const params = new URLSearchParams({ query, field, limit: "50" });
        const res = await fetch(`https://pl5fd.com/api/records?${params}`, { signal: AbortSignal.timeout(10_000) });
        return { status: res.status, retryAfter: res.headers.get("Retry-After"), data: await res.text() };
    } catch (e) {
        return { status: -1, retryAfter: null, data: String(e) };
    }
}

async function runLookup(key: string) {
    activeRequests++;
    const separator = key.indexOf(":");
    const field = key.slice(0, separator) as FdLookupField;
    const query = key.slice(separator + 1);
    let requeued = false;

    try {
        const { status, retryAfter, data } = await requestRecords(field, query);

        if (status === 429) {
            const seconds = Number(retryAfter);
            pausedUntil = Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 30) * 1000;
            queue.unshift(key);
            requeued = true;
            return;
        }

        const body = status === 200 ? JSON.parse(data) : null;
        if (!body?.ok || !Array.isArray(body.results)) {
            throw new Error(`HTTP ${status}: ${String(body?.error ?? data).slice(0, 200)}`);
        }

        setBounded(cache, key, { results: body.results, fetchedAt: Date.now() });
        failState.delete(key);
        schedulePersist();
        bump();
    } catch (error) {
        const failCount = (failState.get(key)?.failCount ?? 0) + 1;
        const backoffMs = Math.min(LIMITS.records.retry.maxMs, LIMITS.records.retry.baseMs * (2 ** (failCount - 1)));
        failState.set(key, { failCount, nextRetryAt: Date.now() + backoffMs });
        console.warn(LOG_PREFIX, "FD records lookup failed", { field, query, failCount, backoffMs, error });
    } finally {
        if (!requeued) queued.delete(key);
        activeRequests--;
        pump();
    }
}

/** Cached results (possibly stale), or undefined if never fetched. Queues a refresh when missing/stale. */
function lookup(field: FdLookupField, query: string): FdRecord[] | undefined {
    loadCache();
    const key = cacheKey(field, query);
    const entry = cache.get(key);

    if (entry && Date.now() - entry.fetchedAt < LIMITS.records.cacheTtlMs) return entry.results;

    const retry = failState.get(key);
    if (!queued.has(key) && !(retry && retry.nextRetryAt > Date.now())) {
        queued.add(key);
        queue.push(key);
        pump();
    }

    return entry?.results;
}

function pumpInvites() {
    while (activeInviteResolves < LIMITS.records.maxConcurrentInviteResolves && inviteQueue.length) {
        const code = inviteQueue.shift()!;
        activeInviteResolves++;
        InviteActions.resolveInvite(code, "Desktop Modal")
            .then((result: any) => {
                setBounded(inviteGuildCache, code, { guildId: result?.invite?.guild?.id ?? null, fetchedAt: Date.now() });
            })
            .catch(() => {
                setBounded(inviteGuildCache, code, { guildId: null, fetchedAt: Date.now() });
            })
            .finally(() => {
                inviteInFlight.delete(code);
                activeInviteResolves--;
                bump();
                pumpInvites();
            });
    }
}

/** Guild ID for an invite code: undefined while pending, null if it couldn't be resolved. */
export function resolveInviteGuildId(code: string): string | null | undefined {
    const cached = inviteGuildCache.get(code);
    if (cached && Date.now() - cached.fetchedAt < LIMITS.records.cacheTtlMs) return cached.guildId;
    if (inviteInFlight.has(code)) return cached?.guildId;

    inviteInFlight.add(code);
    inviteQueue.push(code);
    pumpInvites();

    return cached?.guildId;
}

function distinctiveTokens(normalized: string) {
    return normalized.split(" ").filter(token => token.length >= 3 && !GENERIC_NAME_WORDS.has(token));
}

/** The single most distinctive word of a title - the API does substring matching on names. */
function titleSearchQuery(rawTitle: string) {
    const tokens = distinctiveTokens(normalizeFactionName(rawTitle));
    if (!tokens.length) return null;

    return tokens.reduce((longest, token) => token.length > longest.length ? token : longest);
}

function nameMatchesTitle(normalizedTitle: string, recordName: string) {
    const name = normalizeFactionName(recordName);
    if (name.length < 4 || !distinctiveTokens(name).length) return false;

    if (` ${normalizedTitle} `.includes(` ${name} `)) return true;
    if (normalizedTitle.length >= 4 && ` ${name} `.includes(` ${normalizedTitle} `)) return true;

    return levenshteinSimilarity(normalizedTitle, name) >= 0.85;
}

export function isRecordActive(record: FdRecord, now = Date.now()) {
    const status = (record.status ?? "").toLowerCase();
    if (status === "appealed" || status === "expired warning") return false;

    if (record.kind === "Warning" && record.expirationDate) {
        const expires = Date.parse(record.expirationDate);
        if (!Number.isNaN(expires) && expires < now) return false;
    }

    return true;
}

export function isBlacklistRecord(record: FdRecord) {
    return record.kind === "Blacklist" || record.kind === "User Violation";
}

export function getFdMatch(authorId: string, rawTitle: string, inviteCode: string, options: FdMatchOptions): FdMatch | null {
    const matched = new Map<string, FdMatchedRecord>();
    const add = (records: FdRecord[] | undefined, source: FdMatchSource, filter?: (record: FdRecord) => boolean) => {
        for (const record of records ?? []) {
            if (filter && !filter(record)) continue;

            const existing = matched.get(record.id);
            if (existing) {
                if (!existing.sources.includes(source)) existing.sources.push(source);
            } else {
                matched.set(record.id, { record, sources: [source], active: true });
            }
        }
    };

    if (options.checkAuthor && /^\d{17,20}$/.test(authorId)) {
        add(lookup("discordUserId", authorId), "author");
    }

    if (options.checkTitle) {
        const query = titleSearchQuery(rawTitle);
        if (query) {
            const normalizedTitle = normalizeFactionName(rawTitle);
            add(lookup("name", query), "name", record => record.kind !== "User Violation" && nameMatchesTitle(normalizedTitle, record.primaryName));
        }
    }

    // Only spend a Discord invite resolve + an extra API call once something hit.
    let inviteGuildId: string | null = null;
    let serverResults: FdRecord[] | undefined;
    if (matched.size && options.confirmViaInvite && inviteCode) {
        inviteGuildId = resolveInviteGuildId(inviteCode) ?? null;
        if (inviteGuildId) {
            serverResults = lookup("serverId", inviteGuildId);
            add(serverResults, "server");
        }
    }

    const all = [...matched.values()];
    if (!all.length) return null;

    // Past (expired/appealed) records are kept so mods still see the history.
    const now = Date.now();
    for (const entry of all) entry.active = isRecordActive(entry.record, now);
    const active = all.filter(entry => entry.active);
    const relevant = active.length ? active : all;

    const confirmed = inviteGuildId != null && all.some(entry => entry.record.serverId === inviteGuildId);
    const level: FdMatch["level"] = confirmed
        ? "confirmed"
        : all.some(entry => entry.sources.includes("author"))
            ? "author"
            : "name";

    // Name-only and the server-ID lookup finished without confirming it. Waiting for
    // the lookup (serverResults !== undefined) keeps the badge from flickering away.
    const serverChecked = level === "name" && inviteGuildId != null && serverResults !== undefined;
    // Every record lists a different server ID - a same-named community, not this one.
    if (serverChecked && all.every(entry => entry.record.serverId && entry.record.serverId !== inviteGuildId)) return null;

    all.sort((left, right) =>
        Number(right.active) - Number(left.active)
        || Number(isBlacklistRecord(right.record)) - Number(isBlacklistRecord(left.record)));

    return {
        level,
        kind: relevant.some(entry => isBlacklistRecord(entry.record)) ? "blacklist" : "warning",
        hasActive: active.length > 0,
        records: all,
        inviteGuildId,
        notInDb: serverChecked,
    };
}

export function formatFdBadge(match: FdMatch) {
    const prefix = match.kind === "blacklist" ? "BL" : "WARN";
    const marker = match.level === "confirmed" ? " ✓" : match.level === "name" ? "?" : "";
    const codes = [...new Set(match.records
        .filter(entry => entry.active === match.hasActive && (match.kind === "blacklist") === isBlacklistRecord(entry.record))
        .flatMap(entry => entry.record.violationCodes))]
        .slice(0, 3);

    return `${match.hasActive ? "" : "PAST "}${prefix}${marker}${match.notInDb ? " not in DB" : ""}${codes.length ? ` ${codes.join(" ")}` : ""}`;
}

function formatDate(value: string | null) {
    return value ? value.slice(0, 10) : "no date";
}

export function formatFdRecordLine(entry: FdMatchedRecord) {
    const { record } = entry;
    const codes = record.violationCodes.length ? record.violationCodes.join(", ") : "no code";
    return `${entry.active ? "" : "[past] "}${record.kind}${record.status ? ` (${record.status})` : ""}: ${record.primaryName} - ${codes}, ${formatDate(record.sanctionDate)} [via ${entry.sources.join("+")}]`;
}

export function describeFdLevel(match: FdMatch) {
    switch (match.level) {
        case "confirmed": return "confirmed by server ID";
        case "author": return "author's Discord ID";
        case "name": return match.notInDb ? "possible name match, server ID not in FD database" : "possible name match";
    }
}

export function getEvidenceUrl(record: FdRecord) {
    const value = record.evidenceUrl?.trim();
    return value && /^https?:\/\//i.test(value) ? value : null;
}

export function clearRecordsCache() {
    cache.clear();
    failState.clear();
    inviteGuildCache.clear();
    try {
        localStorage.removeItem(CACHE_KEYS.fdRecords);
    } catch { }
    bump();
}

export function stopRecords() {
    if (pumpTimer != null) clearTimeout(pumpTimer);
    if (persistTimer != null) clearTimeout(persistTimer);
    pumpTimer = null;
    persistTimer = null;
    queue.length = 0;
    queued.clear();
    // Already-started resolves finish on their own (their bump() is a no-op once
    // onChange is reset); queued ones are dropped so a restart can re-request them.
    for (const code of inviteQueue) inviteInFlight.delete(code);
    inviteQueue.length = 0;
    onChange = () => { };
}
