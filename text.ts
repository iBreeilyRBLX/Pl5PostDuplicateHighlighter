/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LIMITS } from "./constants";

// Pure text normalizers shared by duplicate matching (index.tsx), FD name lookups
// (records.ts) and the violation notice modal. Kept free of webpack imports so they
// can be unit tested on their own.

const CUSTOM_EMOJI = /<a?:\w+:\d+>/g;
const DISCORD_TIMESTAMP = /<t:-?\d+(?::[tTdDfFR])?>/g;
// User/role/channel mentions are markup too - two ads differing only in who they
// ping shouldn't look less similar.
const DISCORD_MENTION = /<(?:@[!&]?|#)\d+>/g;
const URL = /\b(?:https?:\/\/|www\.)\S+/gi;
// Scheme-less invites ("discord.gg/abc") aren't caught by URL above.
const BARE_INVITE = /\b(?:discord\.gg|discord(?:app)?\.com\/invite)\/\S+/gi;
const MARKDOWN_SYMBOLS = /[*_~`#>|\-=•]+/g;

// Words that start a recruiting tagline appended to a faction name, e.g.
// "Blackout PMC | Now Recruiting" or "Blackout PMC - Join Today".
const RECRUITING_TAGLINE = /\b(?:(?:now|we'?re|are|is)\s+)?(?:recruit\w*|hiring|enlist\w*|accepting|join(?:ing)?|apply|applications?|looking for|lf[mg])\b/i;

// Separators between a faction name and the rest of a title: pipes, bullets, dashes
// with spaces around them (so "Task-Force" stays one word), brackets, and any run
// of emoji or decorative symbols.
const TITLE_SEPARATOR = /\s[-–—]\s|[–—]|[^\p{L}\p{N}\s'&.-]+/u;

/** Lowercased, NFKC-folded letters and digits only - "𝔹𝕃𝔸ℂ𝕂𝕆𝕌𝕋 ★ PMC" -> "blackout pmc". */
export function normalizeFactionName(value: string) {
    return value
        .normalize("NFKC")
        .toLowerCase()
        .replace(CUSTOM_EMOJI, " ")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
}

/** Whitespace/case-normalized title, compared against card headings in the DOM fallback. */
export function normalizeTitle(title: string) {
    return title.trim().toLowerCase().replace(/\s+/g, " ");
}

/** First-message snippet used for content similarity, with markup that varies between reposts removed. */
export function normalizeContent(content: string) {
    return content
        .replace(CUSTOM_EMOJI, " ")
        .replace(DISCORD_TIMESTAMP, " ")
        .replace(DISCORD_MENTION, " ")
        .replace(URL, " ")
        .replace(BARE_INVITE, " ")
        .replace(MARKDOWN_SYMBOLS, " ")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ")
        .slice(0, LIMITS.contentSnippetLength);
}

/**
 * Best guess at the faction name inside a decorated post title, for the prior-warning
 * search: "★ 𝐁𝐋𝐀𝐂𝐊𝐎𝐔𝐓 𝐏𝐌𝐂 ★ | Now Recruiting!" -> "BLACKOUT PMC". Keeps the original
 * case since mods see (and can edit) the result.
 */
export function cleanFactionTitle(rawTitle: string) {
    const folded = rawTitle.normalize("NFKC").replace(CUSTOM_EMOJI, " ");
    const parts: string[] = [];

    // Separators are often part of the name itself ("Task Force - Adak"), so every
    // segment is kept; only a recruiting tagline, and everything after it, is cut.
    for (const segment of folded.split(new RegExp(TITLE_SEPARATOR.source, "gu"))) {
        const tagline = segment.match(RECRUITING_TAGLINE);
        const name = (tagline ? segment.slice(0, tagline.index) : segment)
            .replace(/\s+/g, " ")
            .replace(/^[\s'&.-]+|[\s'&.-]+$/g, "");

        // Skip bare region/status tags like "[EU]" (too short to be a name part).
        if ((name.match(/[\p{L}\p{N}]/gu) ?? []).length >= 3) parts.push(name);
        // A leading "[RECRUITING]" tag is skipped; a trailing tagline ends the name.
        if (tagline && parts.length) break;
    }

    // Nothing name-like (e.g. an emoji-only title): leave whatever letters/digits there
    // are, possibly none, for the mod to fill in rather than searching for symbols.
    return parts.join(" ") || normalizeFactionName(rawTitle);
}
