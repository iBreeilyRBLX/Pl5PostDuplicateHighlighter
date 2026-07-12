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

// ═══════════════════════════════════════════════════════════════════════════
// C2-11: undisclosed AI content detection
//
// Design notes:
// - RECALL over precision: this only queues posts for human review.
// - Every signal carries a human-readable label so mods see WHY.
// - PROSE signals are always active. STRUCTURAL signals are suppressed when
//   the post contains "community artifacts" (custom server emoji, Discord
//   timestamps, CDN attachment links) - things an LLM cannot fabricate,
//   proving the post was hand-assembled in a real server. In this forum's
//   culture, heavy markdown decoration is normal HUMAN behavior, so
//   structure only counts against bare posts that lack those artifacts.
// - Recommended default aiSignalThreshold: 4. (3 works but leaves less
//   margin for iOS smart-punctuation and enthusiastic human posters.)
// ═══════════════════════════════════════════════════════════════════════════

// Every alternation is a literal or a bounded pattern (no unbounded nesting),
// so the regex is linear-time - safe to run on every rendered post.
const AI_PHRASES = new RegExp(
    "\\b(?:" + [
        // original set
        "delve", "dive (?:into|in)", "look no further", "elevate your",
        "unleash", "embark on", "in the world of", "seamless(?:ly)?",
        "foster(?:ing)? an?", "vibrant", "like-?minded", "tight-?knit",
        "immersive (?:experience|world|environment)", "unparalleled",
        "whether you'?re",
        // community-marketing vocabulary
        "thriving", "bustling", "welcoming (?:community|environment|space)",
        "sense of (?:community|belonging)", "camaraderie",
        "forge (?:new )?(?:friendships|bonds|alliances)",
        "hone your", "awaits? you", "something for everyone",
        "we'?ve got you covered", "rest assured", "at its core",
        "a hub for", "testament to",
        // intensifiers and cliches
        "top-?notch", "cutting-?edge", "state-?of-?the-?art",
        "game-?chang(?:er|ing)", "unforgettable", "one-?of-?a-?kind",
        "second to none", "plethora", "myriad", "boasts?",
        "countless (?:hours|opportunities|adventures|possibilities)",
        "take your [\\w '\\-]{1,25} to the next level",
        "and (?:so much|much) more",
        // essay connectives rare in casual Discord writing
        "furthermore", "moreover", "in conclusion",
    ].join("|") + ")\\b",
    "gi"
);

const CTA_BOILERPLATE = /\b(?:join (?:us )?today|can'?t wait to (?:meet|see|have) you|(?:hope|hoping) to see you (?:there|soon)|see you (?:there|soon|in[\s-]?game)|come be a part of|be(?:come)? a part of (?:something|our)|your (?:adventure|journey) (?:starts|begins|awaits)|we look forward to|so what are you waiting for|ready to (?:join|jump in|get started)|the choice is yours|will you answer the call)\b/i;

// Pruned to LLM-ad-specific headers only. "About us", "requirements",
// "who we are", "how to join" etc. are normal human faction-ad culture
// here and were removed after testing against real human posts.
const HEADER_BOILERPLATE = /\b(?:why (?:join|choose) us|what we offer|what to expect|what makes us (?:different|special|unique)|what (?:we'?re|we are) looking for|what you(?:'ll| will) (?:get|find))\b/gi;

const NOT_ONLY_BUT = /\bnot (?:only|just)\b[^.!?\n]{0,80}\bbut(?: also)?\b/i;

// "x, y(,) and z" - single-word triads only, bounded and linear.
const TRIAD_LIST = /\b[\w'’-]+, [\w'’-]+,? and [\w'’-]+\b/g;

// "Tired of X? Looking for Y?" cold-open, checked near the top of the post.
const RHETORICAL_HOOK = /^(?:looking for|tired of|sick of|bored of|searching for|want|ready (?:for|to)|are you)\b[^?\n]{3,90}\?/im;

// Line-leading emoji/symbol (generic unicode - custom server emoji are
// <:name:id> and intentionally NOT matched here).
const LEADING_EMOJI = /^\s*([\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u2714\u2705\u2611])/u;

// Community artifact markers: evidence the post was assembled inside a real
// server. LLMs cannot fabricate valid custom emoji IDs, Discord timestamps,
// or CDN attachment links.
const CUSTOM_EMOJI = /<a?:\w+:\d{15,21}>/;
const DISCORD_TIMESTAMP = /<t:\d{6,12}(?::[tTdDfFR])?>/;
const DISCORD_CDN_LINK = /(?:cdn|media)\.discordapp\.(?:com|net)\//;

// ── C2-11: disclosure (generous by design - a missed disclosure phrase
// produces the wrong kind of false positive: flagging an honest discloser) ──

const AI_MODEL_NAMES =
    "chat\\s?gpt|gpt(?:-?[o\\d][\\w.]*)?|claude|gemini|copilot|grok|llama|" +
    "deepseek|mistral|perplexity|character\\s?ai|midjourney|dall[\\s-]?e|" +
    "stable\\s?diffusion";

const AI_TOOL =
    "(?:ai|a\\.i\\.|llm|artificial intelligence|language model|chat\\s?bot|" +
    AI_MODEL_NAMES + ")";

const AI_DISCLOSURE = new RegExp(
    // "AI-generated", "AI aided", "LLM-written", "ChatGPT-made", "AI art", ...
    "\\b" + AI_TOOL + "[\\s-]*(?:generated|assisted|aided|enhanced|made|created|written|drafted|edited|polished|formatted|translated|proofread|powered|helped|art|content|images?)\\b" +
    // "written by AI", "made using ChatGPT", "polished partly with Claude", ...
    "|\\b(?:generated|made|created|written|drafted|enhanced|produced|edited|polished|formatted|proofread|assisted|aided|improved|touched up|cleaned up)\\s+(?:partly\\s+|partially\\s+|in part\\s+)?(?:with|by|using|via)\\s+(?:the\\s+)?(?:an?\\s+)?" + AI_TOOL + "\\b" +
    // "with the help of AI", "with AI assistance"
    "|\\bwith (?:the )?(?:help|assistance|aid) of (?:an? )?" + AI_TOOL + "\\b" +
    "|\\bwith " + AI_TOOL + " (?:help|assistance|aid)\\b" +
    // "I used ChatGPT", "we asked Claude", "ran it through an AI"
    "|\\b(?:i|we)\\s+(?:used|asked|prompted|got help from)\\s+(?:an?\\s+)?" + AI_TOOL + "\\b" +
    "|\\bran (?:this|it|the post) (?:through|by|past) (?:an? )?" + AI_TOOL + "\\b" +
    // "ChatGPT wrote/helped/was used"
    "|\\b" + AI_TOOL + "\\s+(?:helped|wrote|made|generated|assisted|drafted|was used)\\b" +
    // catch-alls
    "|\\bai\\s+(?:was\\s+)?used\\b|\\buses?\\s+ai\\b|\\bthanks to " + AI_TOOL + "\\b|\\bai[\\s-]?disclosure\\b|\\bdisclosure:\\s*ai\\b",
    "i"
);

interface AiSignal {
    points: number;
    label: string;
}

function hasCommunityArtifacts(content: string): boolean {
    return CUSTOM_EMOJI.test(content)
        || DISCORD_TIMESTAMP.test(content)
        || DISCORD_CDN_LINK.test(content);
}

// 4+ prose paragraphs (8+ words each) with a coefficient of variation in
// word count under 0.25 - LLM output is eerily even; humans ramble.
function hasUniformParagraphs(content: string): boolean {
    const counts = content
        .split(/\n{2,}/)
        .map(paragraph => paragraph.trim())
        .filter(paragraph => paragraph.length > 0 && !/^[-*•#>]/.test(paragraph))
        .map(paragraph => paragraph.split(/\s+/).length)
        .filter(count => count >= 8);

    if (counts.length < 4) return false;

    const mean = counts.reduce((sum, count) => sum + count, 0) / counts.length;
    const variance = counts.reduce((sum, count) => sum + (count - mean) ** 2, 0) / counts.length;
    return Math.sqrt(variance) / mean < 0.25;
}

function hasExcessiveCaps(title: string) {
    const letters = title.replace(/[^a-z]/gi, "");
    if (letters.length < 10) return false;

    const uppercase = letters.replace(/[^A-Z]/g, "").length;
    return uppercase / letters.length >= 0.75;
}

function collectAiSignals(content: string): AiSignal[] {
    const signals: AiSignal[] = [];
    const lines = content.split("\n");
    const isCommunityArtifact = hasCommunityArtifacts(content);

    // ════ PROSE TELLS - always active ════

    // Punctuation. Note: iOS Smart Punctuation auto-inserts em-dashes and
    // curly quotes, so these two signals alone (max 3 points) must stay
    // below the default threshold of 4.
    const dashCount = (content.match(/—|\s–\s/g) ?? []).length;
    if (dashCount >= 3) {
        signals.push({ points: 2, label: `${dashCount} em-dashes` });
    } else if (dashCount >= 1) {
        signals.push({ points: 1, label: dashCount === 1 ? "1 em-dash" : `${dashCount} em-dashes` });
    }

    if (/[\u201C\u201D]/.test(content)) {
        signals.push({ points: 1, label: "typographic double quotes" });
    } else if (/[\u2018\u2019]/.test(content)) {
        signals.push({ points: 1, label: "typographic apostrophes" });
    }

    const phraseMatches = content.match(AI_PHRASES) ?? [];
    if (phraseMatches.length) {
        const unique = [...new Set(phraseMatches.map(match => match.toLowerCase()))];
        const points = phraseMatches.length >= 6 ? 3 : phraseMatches.length >= 3 ? 2 : 1;
        signals.push({
            points,
            label: `AI-typical phrasing (${unique.slice(0, 4).join(", ")})`,
        });
    }

    if (NOT_ONLY_BUT.test(content)) {
        signals.push({ points: 1, label: '"not only/just ... but" construction' });
    }

    const triadCount = (content.match(TRIAD_LIST) ?? []).length;
    if (triadCount >= 3) {
        signals.push({ points: 1, label: `${triadCount} triadic "x, y, and z" lists` });
    }

    const ctaMatch = content.match(CTA_BOILERPLATE);
    if (ctaMatch) {
        signals.push({ points: 1, label: `boilerplate call-to-action ("${ctaMatch[0].toLowerCase()}")` });
    }

    const opening = lines.filter(line => line.trim()).slice(0, 3).join("\n");
    if (RHETORICAL_HOOK.test(opening)) {
        signals.push({ points: 1, label: "rhetorical-question hook opener" });
    }

    if (hasUniformParagraphs(content)) {
        signals.push({ points: 1, label: "uniform paragraph lengths" });
    }

    // ════ STRUCTURAL TELLS - suppressed for community-artifact posts ════
    // Decorated markdown templates (headings, dividers, emoji bullets) are
    // normal HUMAN faction-ad culture on this forum. These only ever fire
    // on posts with no custom emoji, no timestamps, no attachment links -
    // i.e. bare text an LLM could have produced wholesale.

    if (!isCommunityArtifact) {
        const markdownHeadingCount = lines.filter(line => /^#{1,3}\s+\S/.test(line)).length;
        if (markdownHeadingCount >= 3) {
            signals.push({ points: 1, label: `${markdownHeadingCount} markdown # headings` });
        }

        const horizontalRuleCount = lines.filter(line => /^\s*(?:-{3,}|_{3,}|\*{3,}|={3,})\s*$/.test(line)).length;
        if (horizontalRuleCount >= 1) {
            signals.push({ points: 1, label: "horizontal-rule dividers (not rendered by Discord)" });
        }

        const headerMatches = content.match(HEADER_BOILERPLATE) ?? [];
        if (headerMatches.length) {
            const unique = [...new Set(headerMatches.map(match => match.toLowerCase()))];
            signals.push({
                points: unique.length >= 2 ? 2 : 1,
                label: `stock section headers (${unique.slice(0, 3).join(", ")})`,
            });
        }

        // A distinct curated generic emoji per bullet, with ZERO custom
        // server emoji anywhere, is the LLM fallback pattern - the model
        // doesn't know the server's <:emoji:id> assets. Heavy emoji use by
        // itself is normal human Discord behavior, hence 4+ lines minimum
        // and a 2-point cap.
        const leadingEmoji = lines
            .map(line => LEADING_EMOJI.exec(line)?.[1])
            .filter((emoji): emoji is string => Boolean(emoji));
        if (leadingEmoji.length >= 4) {
            const uniqueEmoji = new Set(leadingEmoji).size;
            signals.push(uniqueEmoji >= 4
                ? { points: 2, label: `generic emoji bullets (${uniqueEmoji} distinct, no custom server emoji)` }
                : { points: 1, label: "emoji section headers (no custom server emoji)" });
        }

        const checkmarkLines = lines.filter(line => /^\s*[\u2714\u2705\u2611]/.test(line)).length;
        if (checkmarkLines >= 3) {
            signals.push({ points: 1, label: `checkmark bullet list (${checkmarkLines} lines)` });
        }

        // Short standalone "What we offer:" style labels with no formatting.
        const colonLabelLines = lines.filter(line => /^[A-Za-z][A-Za-z' ]{2,40}:$/.test(line.trim()));
        if (colonLabelLines.length >= 2) {
            signals.push({ points: 1, label: "plain-text section labels ending in colon" });
        }
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

    if (options.aiDisclosure && (input.rawTitle || input.content)) {
        // Title included so a disclosure placed in the post title counts.
        const disclosureText = `${input.rawTitle}\n${input.content}`.trim();
        const violation = checkUndisclosedAi(disclosureText, options.aiSignalThreshold);
        if (violation) violations.push(violation);
    }

    return violations;
}
