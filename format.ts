/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { MatchReason } from "./types";

// Shared display formatters (card tooltips, history modal, violation notices).

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
export function formatDurationWords(ms: number) {
    const totalMinutes = Math.max(0, Math.round(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    const hourPart = hours > 0 ? `${hours} hour${hours === 1 ? "" : "s"}` : "";
    const minutePart = minutes > 0 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "";

    if (hourPart && minutePart) return `${hourPart} and ${minutePart}`;
    return hourPart || minutePart || "0 minutes";
}

export function formatCooldownWindowLabel(ms: number) {
    const totalMinutes = Math.max(0, Math.round(ms / 60000));
    if (totalMinutes > 0 && totalMinutes % 60 === 0) {
        return `${totalMinutes / 60}-hour cooldown`;
    }

    return `${formatDurationWords(ms)} cooldown`;
}

export function formatMatchReasons(reasons: MatchReason[], contentSimilarity: number | null) {
    if (!reasons.length) return "none";

    return reasons
        .map(reason => reason === "content" && contentSimilarity != null
            ? `content (${Math.round(contentSimilarity * 100)}%)`
            : reason)
        .join(", ");
}
