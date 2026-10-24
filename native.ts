/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { IpcMainInvokeEvent } from "electron";

const RECORDS_API = "https://pl5fd.com/api/records";
const ALLOWED_FIELDS = new Set(["all", "name", "discordUserId", "discordTag", "robloxUsername", "serverId", "violationCode", "violationText"]);

// Runs in the main process because Discord's CSP blocks connect-src to pl5fd.com
// from the renderer. Only the URL's field/query are caller-controlled.
export async function searchRecords(_: IpcMainInvokeEvent, field: string, query: string) {
    if (!ALLOWED_FIELDS.has(field)) return { status: -1, retryAfter: null, data: "invalid field" };

    const url = `${RECORDS_API}?${new URLSearchParams({ query, field, limit: "50" })}`;

    try {
        // A hung request would otherwise hold one of records.ts's concurrency slots forever.
        const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
        const data = await res.text();
        return { status: res.status, retryAfter: res.headers.get("Retry-After"), data };
    } catch (e) {
        return { status: -1, retryAfter: null, data: String(e) };
    }
}
