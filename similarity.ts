/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function levenshteinSimilarity(a: string, b: string) {
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
