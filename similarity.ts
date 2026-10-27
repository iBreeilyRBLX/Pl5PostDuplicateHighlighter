/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * Levenshtein distance, or maxDistance + 1 as soon as it's known to exceed maxDistance.
 * Only the diagonal band |i - j| <= maxDistance is computed (Ukkonen), so a bounded
 * check on two 200-char snippets touches ~2 * maxDistance cells per row instead of 200.
 */
function levenshteinDistance(a: string, b: string, maxDistance: number) {
    if (a.length > b.length) [a, b] = [b, a];

    const n = a.length;
    const m = b.length;
    if (m - n > maxDistance) return maxDistance + 1;
    if (!n) return m;

    const k = Math.min(maxDistance, m);
    const outside = k + 1;
    let previous = new Int32Array(m + 1);
    let current = new Int32Array(m + 1);

    for (let j = 0; j <= k; j++) previous[j] = j;
    if (k + 1 <= m) previous[k + 1] = outside;

    for (let i = 1; i <= n; i++) {
        const lo = Math.max(1, i - k);
        const hi = Math.min(m, i + k);
        current[lo - 1] = lo === 1 ? i : outside;

        const aChar = a.charCodeAt(i - 1);
        let rowMin = current[lo - 1];
        for (let j = lo; j <= hi; j++) {
            const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
            const value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
            current[j] = value;
            if (value < rowMin) rowMin = value;
        }
        // The next row reads one cell past this row's band.
        if (hi + 1 <= m) current[hi + 1] = outside;

        if (rowMin > k) return maxDistance + 1;
        [previous, current] = [current, previous];
    }

    return previous[m] <= k ? previous[m] : maxDistance + 1;
}

export function levenshteinSimilarity(a: string, b: string) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;

    const maxLength = Math.max(a.length, b.length);
    return 1 - levenshteinDistance(a, b, maxLength) / maxLength;
}

/**
 * Exact similarity when it's >= minSimilarity; otherwise some value below
 * minSimilarity (an upper bound), found without computing the full distance.
 */
export function levenshteinSimilarityAtLeast(a: string, b: string, minSimilarity: number) {
    if (a === b) return 1;
    if (!a.length || !b.length) return 0;

    const maxLength = Math.max(a.length, b.length);
    // Epsilon so e.g. 0.9 on 200 chars allows 20 edits, not 19 (1 - 0.9 is 0.0999...).
    const maxDistance = Math.max(0, Math.floor((1 - minSimilarity) * maxLength + 1e-9));
    return 1 - levenshteinDistance(a, b, maxDistance) / maxLength;
}
