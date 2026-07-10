/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface RuleViolation {
    code: string;
    summary: string;
}

export interface RuleCheckInput {
    rawTitle: string;
    content: string;
    appliedTags: string[];
}

export interface RuleCheckOptions {
    multipleInvites: boolean;
    tagCheck: boolean;
    titleQuality: boolean;
    aiDisclosure: boolean;
    aiSignalThreshold: number;
}

// C2-4: every advertisement must carry at least one of these forum tags.
const REQUIRED_TAG_IDS = [
    "1424932961572098150", // Faction
    "1424932920761651210", // Community Hub
] as const;

const INVITE_PATTERN_GLOBAL = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([a-zA-Z0-9-]+)/gi;

// C2-5/C2-7: "custom" unicode letters used as fake fonts - mathematical
// alphanumerics, fullwidth latin, circled/parenthesized letters and digits,
// small caps / phonetic extensions, modifier letters, and super/subscripts.
const FANCY_LETTERS = new RegExp(
    "[" +
    "\\u{1D400}-\\u{1D7FF}" + // mathematical alphanumeric symbols (𝕗𝕒𝕟𝕔𝕪, 𝓯𝓪𝓷𝓬𝔂, ...)
    "\\u{1F110}-\\u{1F189}" + // parenthesized/squared latin letters (🄰🅱, ...)
    "\\uFF21-\\uFF3A\\uFF41-\\uFF5A" + // fullwidth latin letters
    "\\u24B6-\\u24E9\\u2460-\\u2473\\u249C-\\u24B5" + // circled/parenthesized letters and digits
    "\\u02B0-\\u02FF" + // spacing modifier letters
    "\\u1D00-\\u1D7F\\u1D9B-\\u1DBF" + // small caps / phonetic extensions
    "\\u2070-\\u209C" + // super/subscripts
    "]",
    "u"
);

// Stacked combining marks ("zalgo" text).
const ZALGO = new RegExp("[\\u0300-\\u036F]{2,}");

// Arrows, box drawing, geometric shapes, misc symbols, dingbats.
const DECORATIVE_SYMBOLS = /[←-⇿─-➿⬀-⯿]/;

const SENSATIONAL = /\b(?:join (?:us )?now|look no further|don'?t miss(?: out)?|limited (?:time|spots?|slots?)|click here|read this|(?:the )?best faction|#1|number one|act (?:fast|now)|what are you waiting for|sign up (?:now|today)|now recruiting|recruiting now)\b/i;

const EXCESSIVE_PUNCTUATION = /[!?]{3,}/;

// C2-11: a plain-text disclosure anywhere in the post satisfies the rule.
const AI_DISCLOSURE = /\b(?:ai|artificial intelligence)[\s-]*(?:generated|assisted|enhanced|made|created|written|art|content|images?)\b|\b(?:generated|made|created|written|enhanced|produced)\s+(?:with|by|using)\s+(?:ai|artificial intelligence|chat\s?gpt|claude|gemini|copilot|midjourney|dall[\s-]?e|stable\s?diffusion)\b|\bai\s+(?:was\s+)?used\b|\buses?\s+ai\b/i;

const AI_PHRASES = /\b(?:delve|dive into|look no further|elevate your|unleash|embark on|in the world of|seamless(?:ly)?|foster(?:ing)? an?|vibrant|like-?minded|tight-?knit|immersive experience|unparalleled|whether you'?re)\b/gi;

interface AiSignal {
    points: number;
    label: string;
}

function hasExcessiveCaps(title: string) {
    const letters = title.replace(/[^a-z]/gi, "");
    if (letters.length < 10) return false;

    const uppercase = letters.replace(/[^A-Z]/g, "").length;
    return uppercase / letters.length >= 0.75;
}

function collectAiSignals(content: string): AiSignal[] {
    const signals: AiSignal[] = [];

    const emDashCount = (content.match(/—/g) ?? []).length;
    if (emDashCount >= 3) {
        signals.push({ points: 2, label: `${emDashCount} em-dashes` });
    } else if (emDashCount >= 1) {
        signals.push({ points: 1, label: emDashCount === 1 ? "1 em-dash" : `${emDashCount} em-dashes` });
    }

    if (/[‘’“”]/.test(content)) {
        signals.push({ points: 1, label: "typographic quotes" });
    }

    const phraseMatches = content.match(AI_PHRASES) ?? [];
    if (phraseMatches.length) {
        const unique = [...new Set(phraseMatches.map(match => match.toLowerCase()))];
        const sample = unique.slice(0, 4).join(", ");
        signals.push({
            points: phraseMatches.length >= 3 ? 2 : 1,
            label: `AI-typical phrasing (${sample})`,
        });
    }

    const boldSectionLines = content.match(/^\s*(?:[-*•>]\s*)?\*\*[^*\n]+\*\*/gm) ?? [];
    if (boldSectionLines.length >= 4) {
        signals.push({ points: 1, label: "templated bold section formatting" });
    }

    const emojiHeaderLines = content
        .split("\n")
        .filter(line => /^\s*[\u{1F000}-\u{1FAFF}☀-➿⬀-⯿]/u.test(line))
        .length;
    if (emojiHeaderLines >= 4) {
        signals.push({ points: 1, label: "emoji section headers" });
    }

    return signals;
}

function checkMultipleInvites(content: string): RuleViolation | null {
    const codes = new Set<string>();
    for (const match of content.matchAll(INVITE_PATTERN_GLOBAL)) {
        codes.add(match[1].toLowerCase());
    }

    if (codes.size <= 1) return null;
    return { code: "C2-1", summary: `${codes.size} server invites in one post` };
}

function checkRequiredTags(appliedTags: string[]): RuleViolation | null {
    const hasRequiredTag = appliedTags.some(tagId => (REQUIRED_TAG_IDS as readonly string[]).includes(tagId));
    if (hasRequiredTag) return null;
    return { code: "C2-4", summary: "missing Faction / Community Hub tag" };
}

function checkTitleQuality(rawTitle: string): RuleViolation | null {
    const issues: string[] = [];

    if (FANCY_LETTERS.test(rawTitle) || ZALGO.test(rawTitle)) issues.push("custom unicode letters");
    if (DECORATIVE_SYMBOLS.test(rawTitle)) issues.push("decorative symbols");
    if (SENSATIONAL.test(rawTitle)) issues.push("sensationalist language");
    if (hasExcessiveCaps(rawTitle)) issues.push("excessive caps");
    if (EXCESSIVE_PUNCTUATION.test(rawTitle)) issues.push("excessive punctuation");

    if (!issues.length) return null;
    return { code: "C2-5/7", summary: `title: ${issues.join(", ")}` };
}

function checkUndisclosedAi(content: string, threshold: number): RuleViolation | null {
    if (AI_DISCLOSURE.test(content)) return null;

    const signals = collectAiSignals(content);
    const score = signals.reduce((sum, signal) => sum + signal.points, 0);
    if (score < threshold) return null;

    return {
        code: "C2-11",
        summary: `possible undisclosed AI content (${signals.map(signal => signal.label).join(", ")})`,
    };
}

export function checkRules(input: RuleCheckInput, options: RuleCheckOptions): RuleViolation[] {
    const violations: RuleViolation[] = [];

    if (options.multipleInvites && input.content) {
        const violation = checkMultipleInvites(input.content);
        if (violation) violations.push(violation);
    }

    if (options.tagCheck) {
        const violation = checkRequiredTags(input.appliedTags);
        if (violation) violations.push(violation);
    }

    if (options.titleQuality && input.rawTitle) {
        const violation = checkTitleQuality(input.rawTitle);
        if (violation) violations.push(violation);
    }

    if (options.aiDisclosure && input.content) {
        const violation = checkUndisclosedAi(input.content, options.aiSignalThreshold);
        if (violation) violations.push(violation);
    }

    return violations;
}
