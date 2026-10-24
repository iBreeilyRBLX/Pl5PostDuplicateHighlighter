/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { copyToClipboard } from "@utils/clipboard";
import {
    ModalCloseButton,
    ModalContent,
    ModalFooter,
    ModalHeader,
    ModalProps,
    ModalRoot,
    ModalSize,
    openModal,
} from "@utils/modal";
import {
    Button,
    ChannelRouter,
    Checkbox,
    Forms,
    MessageActions,
    React,
    RestAPI,
    showToast,
    Text,
    TextArea,
    TextInput,
} from "@webpack/common";

import { FIXED_IDS } from "./constants";
import { describeFdLevel, type FdMatch, formatFdRecordLine, getEvidenceUrl, isBlacklistRecord } from "./records";
import { C2_RULE_CATALOG, type RuleViolation } from "./rules";
import { cleanFactionTitle } from "./text";
import type { ViolationNoticeContext } from "./types";

const PL5_EMOJI = "<:PL5:646268257384398848>";

type WarningKind = "verbal" | "minor" | "major" | "blacklist";

const WARNING_KINDS: Array<{ kind: WarningKind; label: string; color: any; }> = [
    { kind: "verbal", label: "Copy Verbal Warning", color: undefined },
    { kind: "minor", label: "Copy Minor Warning", color: undefined },
    { kind: "major", label: "Copy Major Warning", color: undefined },
    { kind: "blacklist", label: "Copy Blacklist Notice", color: undefined },
];

// A detected violation's code can be a combo like "C2-5/7" - normalize it
// to the individual catalog codes it covers ("C2-5", "C2-7").
function ruleCodesFromViolationCode(code: string): string[] {
    return code.split("/").map(part => (part.startsWith("C2-") ? part : `C2-${part}`));
}

// Builds the guideline text from whichever catalog checkboxes are selected, using
// the official guideline wording. The one exception is C2-2, where the detected
// violation's summary carries the actual cooldown timing ("Posting 3 hours early...").
function buildGuidelinesText(selected: ReadonlySet<string>, detected: RuleViolation[]): string {
    const cooldown = detected.find(violation => violation.code === "C2-2");

    return C2_RULE_CATALOG
        .filter(rule => selected.has(rule.code))
        .map(rule => rule.code === "C2-2" && cooldown
            ? `${rule.code}: ${cooldown.summary}`
            : `${rule.code}: ${rule.label}`)
        .join("\n");
}

function initialSelectedCodes(violations: RuleViolation[]): Set<string> {
    const codes = new Set<string>();
    for (const violation of violations) {
        for (const code of ruleCodesFromViolationCode(violation.code)) codes.add(code);
    }
    return codes;
}

interface SearchHit {
    messageId: string;
    channelId: string;
    content: string;
    authorName: string;
    timestamp: number;
}

interface SearchResult {
    hits: SearchHit[];
    totalResults: number;
}

// Runs a single live search against Discord's message index, scoped to
// #faction-discussion (where mods actually track "post for {faction}"
// history, not the ad forum channel itself), for the given faction name.
// This is a one-off call triggered by the moderator (on modal open, and on
// demand afterwards) - the same request weight as manually typing into
// Discord's search bar once, not a bulk scan, so it doesn't need the
// retry/backoff machinery pl5ModScan uses for its many-query sweeps.
async function searchFactionPosts(query: string, excludeThreadId: string): Promise<SearchResult> {
    const response = await RestAPI.get({
        url: `/guilds/${FIXED_IDS.guildId}/messages/search`,
        query: { channel_id: FIXED_IDS.factionDiscussionChannelId, content: `post for ${query}`, include_nsfw: true },
    });

    const body = response.body as { total_results?: number; messages?: any[][]; } | undefined;
    const groups = body?.messages ?? [];

    const hits: SearchHit[] = groups
        .map(group => group.find((message: any) => message?.hit) ?? group[0])
        .filter((message: any): message is any => Boolean(message?.id) && message.channel_id !== excludeThreadId)
        .map((message: any) => ({
            messageId: message.id,
            channelId: message.channel_id,
            content: String(message.content ?? ""),
            authorName: message.author?.globalName ?? message.author?.username ?? "unknown",
            timestamp: Date.parse(message.timestamp ?? "") || 0,
        }))
        .sort((a, b) => b.timestamp - a.timestamp);

    return { hits, totalResults: body?.total_results ?? hits.length };
}

function buildWarningMessage(kind: WarningKind, ping: string, faction: string, guidelines: string) {
    const pingText = ping.trim() || "(Discord ID/ping)";
    const factionText = faction.trim() || "(Faction name)";
    const guidelineText = guidelines.trim() || "(list the violated guideline here)";

    switch (kind) {
        case "verbal":
            return `**${PL5_EMOJI} | Faction Advertisement Infraction** \n${pingText} - Your advertisement post for ${factionText} has been removed for violating the following guidelines: \n\n${guidelineText}\n\nThis is a verbal warning for your first violation. Further violations will lead to recorded minor warnings for your faction.`;

        case "minor":
            return `Minor Warning: \n\n**${PL5_EMOJI} | Faction Advertisement Infraction** \n${pingText} - Your advertisement post for ${factionText} has been removed for violating the following guidelines: \n\n${guidelineText}\n\nThis is now escalated as a minor warning and will be recorded in Blacklists & Warnings. Further violations will lead to a major warning for your faction in which you are required to appeal.`;

        case "major":
            return `**${PL5_EMOJI} | Faction Advertisement Infraction**\n${pingText} - Your advertisement post(s) for ${factionText} has been removed for violating the following guidelines: \n\n${guidelineText}\n\nThis is now escalated as a major warning and will be recorded in Blacklists & Warnings. Further violations will lead to a major warning for your faction in which you are required to appeal.`;

        case "blacklist":
            return `**${PL5_EMOJI} | Faction Advertisement Infraction**\n${pingText} - Your advertisement post(s) for ${factionText} has been removed for violating the following guidelines: \n\n${guidelineText}\n\nThis is now escalated to a blacklist and will be recorded in Blacklists & Warnings.`;
    }
}

interface FdStanding {
    // e.g. ["Blacklist (Permanent)", "Major Warning"] - active sanctions only
    activeLabels: string[];
    suggested: WarningKind | null;
    reason: string;
}

// Summarizes the active FD sanctions on record and the next tier to escalate to.
function getFdStanding(match: FdMatch | null): FdStanding | null {
    if (!match?.records.length) return null;

    const records = match.records.filter(entry => entry.active).map(entry => entry.record);
    if (!records.length) return { activeLabels: [], suggested: null, reason: "nothing active, only past records" };

    const status = (value: string | null) => (value ?? "").toLowerCase();
    const blacklist = records.find(isBlacklistRecord);
    const major = records.find(record => record.kind === "Warning" && status(record.status) === "major warning");
    const minor = records.find(record => record.kind === "Warning" && status(record.status) === "minor warning");
    const otherWarning = records.find(record => record.kind === "Warning" && record !== major && record !== minor);

    const activeLabels = [
        blacklist && `Blacklist${blacklist.status ? ` (${blacklist.status})` : ""}`,
        major && "Major Warning",
        minor && "Minor Warning",
        otherWarning && (otherWarning.status ?? "Warning"),
    ].filter(Boolean) as string[];

    if (blacklist) return { activeLabels, suggested: "blacklist", reason: "already blacklisted" };
    if (major) return { activeLabels, suggested: "blacklist", reason: "active major warning → escalate to blacklist" };
    if (minor) return { activeLabels, suggested: "major", reason: "active minor warning → escalate to major warning" };
    return { activeLabels, suggested: "minor", reason: "active warning on record → at least a minor warning" };
}

function formatExpiry(value: string | null) {
    return value ? `, expires ${value.slice(0, 10)}` : "";
}

function FdRecordsSection({ match, standing }: { match: FdMatch; standing: FdStanding; }) {
    const accent = !match.hasActive
        ? "var(--text-muted)"
        : match.kind === "blacklist" ? "var(--text-danger)" : "var(--text-warning)";

    return (
        <div style={{
            borderRadius: 8,
            padding: "10px 12px",
            background: "var(--background-base-lower)",
            borderLeft: `3px solid ${accent}`,
        }}>
            <Forms.FormTitle tag="h5" style={{ color: accent }}>
                {standing.activeLabels.length
                    ? `⚠ Active on FD record: ${standing.activeLabels.join(", ")}`
                    : "FD record history (expired / appealed)"}
            </Forms.FormTitle>
            <Forms.FormText style={{ marginBottom: 8 }}>
                {standing.suggested ? `Suggested: ${standing.reason}. ` : ""}Matched by {describeFdLevel(match)}
                {match.level === "name" ? " - double-check it's the same faction." : "."}
            </Forms.FormText>
            <div style={{ display: "grid", gap: 6 }}>
                {match.records.map(entry => {
                    const evidenceUrl = getEvidenceUrl(entry.record);
                    return (
                        <div key={entry.record.id} style={entry.active ? undefined : { opacity: 0.7 }}>
                            <Text variant="text-sm/normal">
                                {formatFdRecordLine(entry)}{formatExpiry(entry.record.expirationDate)}
                            </Text>
                            {entry.record.description && (
                                <Forms.FormText style={{ color: "var(--text-muted)" }}>{entry.record.description}</Forms.FormText>
                            )}
                            {evidenceUrl && (
                                <a href={evidenceUrl} target="_blank" rel="noreferrer">Evidence</a>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

function ViolationNoticeModal(props: ModalProps & { context: ViolationNoticeContext; }) {
    const { context } = props;

    const [ping, setPing] = React.useState(context.authorId ? `<@${context.authorId}>` : "");
    // Start from the faction name inside the title (fonts, emoji and "| Now Recruiting"
    // style taglines stripped) so the prior-warning search actually hits; mods can
    // still edit it.
    const [initialFaction] = React.useState(() => cleanFactionTitle(context.threadTitle ?? ""));
    const [faction, setFaction] = React.useState(initialFaction);
    const [selectedCodes, setSelectedCodes] = React.useState(() => initialSelectedCodes(context.violations));
    const [guidelines, setGuidelines] = React.useState(() => buildGuidelinesText(selectedCodes, context.violations));
    const [preview, setPreview] = React.useState("");
    const [previewKind, setPreviewKind] = React.useState<WarningKind | null>(null);
    const fdStanding = React.useMemo(() => getFdStanding(context.fdMatch), [context.fdMatch]);

    const [searching, setSearching] = React.useState(false);
    const [searchError, setSearchError] = React.useState<string | null>(null);
    const [searchResult, setSearchResult] = React.useState<SearchResult | null>(null);
    // Incremented per search so a slow earlier response can't overwrite a newer one.
    const searchRequestId = React.useRef(0);

    const handleCopy = React.useCallback((kind: WarningKind) => {
        const message = buildWarningMessage(kind, ping, faction, guidelines);
        setPreview(message);
        setPreviewKind(kind);
        copyToClipboard(message);
        showToast({ text: `Copied ${kind} warning to clipboard`, variant: "success" });
    }, [ping, faction, guidelines]);

    const toggleRuleCode = React.useCallback((code: string) => {
        // Computed outside the state updater: updaters must stay pure (React may call
        // them twice), so the guidelines text is set alongside rather than from inside.
        const next = new Set(selectedCodes);
        if (next.has(code)) next.delete(code); else next.add(code);
        setSelectedCodes(next);
        setGuidelines(buildGuidelinesText(next, context.violations));
    }, [selectedCodes, context.violations]);

    const runFactionSearch = React.useCallback(async (rawQuery: string) => {
        const query = rawQuery.trim();
        if (!query) {
            showToast({ text: "Enter a faction name first", variant: "critical" });
            return;
        }

        const requestId = ++searchRequestId.current;
        setSearching(true);
        setSearchError(null);
        try {
            const result = await searchFactionPosts(query, context.threadId);
            if (requestId !== searchRequestId.current) return;
            setSearchResult(result);
        } catch (error: any) {
            if (requestId !== searchRequestId.current) return;
            const status = error?.status;
            setSearchError(
                status === 403
                    ? "No permission to search this channel."
                    : error?.message || "Search failed."
            );
            setSearchResult(null);
        } finally {
            if (requestId === searchRequestId.current) setSearching(false);
        }
    }, [context.threadId]);

    // Auto-run the search once on open using the faction name we already have,
    // so prior posts show up without an extra click. Edits to the faction field
    // don't search on their own - that's what the "Search again" button is for.
    React.useEffect(() => {
        if (initialFaction.trim()) void runFactionSearch(initialFaction);
    }, []);

    const handleJumpToHit = React.useCallback((hit: SearchHit) => {
        ChannelRouter.transitionToChannel(hit.channelId);
        MessageActions.jumpToMessage({ channelId: hit.channelId, messageId: hit.messageId, flash: true, jumpType: "INSTANT" });
    }, []);

    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>
                    Advertisement Violation Notice
                </Text>
                <ModalCloseButton onClick={props.onClose} />
            </ModalHeader>

            <ModalContent>
                {/* minmax(0, 1fr) columns: a plain grid column grows to its widest
                    child, so one long nowrap search hit would widen the whole modal
                    past its edge and push the checkboxes off-screen. */}
                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 16, padding: "16px 0" }}>
                    <Forms.FormText style={{ color: "var(--text-muted)" }}>
                        {context.threadTitle || context.threadId}
                        {context.authorName ? ` · posted by ${context.authorName}` : ""}
                    </Forms.FormText>

                    {context.fdMatch && fdStanding && <FdRecordsSection match={context.fdMatch} standing={fdStanding} />}

                    <div>
                        <Forms.FormTitle tag="h5">Discord ID / ping</Forms.FormTitle>
                        <TextInput
                            value={ping}
                            onChange={setPing}
                            placeholder="<@user id> or paste a mention"
                        />
                    </div>

                    <div>
                        <Forms.FormTitle tag="h5">Faction name</Forms.FormTitle>
                        <TextInput
                            value={faction}
                            onChange={setFaction}
                            placeholder="Faction name"
                        />
                    </div>

                    <div>
                        <Forms.FormTitle tag="h5">Select applicable guideline(s)</Forms.FormTitle>
                        <Forms.FormText style={{ color: "var(--text-muted)", marginBottom: 8 }}>
                            Boxes already ticked were auto-detected. Tick or untick any C2 rule to regenerate the
                            text below - this works for posts with no auto-detected violations too.
                        </Forms.FormText>
                        <div style={{
                            display: "grid",
                            gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                            gap: "4px 12px",
                        }}>
                            {C2_RULE_CATALOG.map(rule => (
                                <Checkbox
                                    key={rule.code}
                                    value={selectedCodes.has(rule.code)}
                                    onChange={() => toggleRuleCode(rule.code)}
                                    size={18}
                                >
                                    <Text variant="text-sm/normal">
                                        <strong>{rule.code}</strong>: {rule.label}
                                    </Text>
                                </Checkbox>
                            ))}
                        </div>
                    </div>

                    <div>
                        <Forms.FormTitle tag="h5">Violated guideline(s)</Forms.FormTitle>
                        <Forms.FormText style={{ color: "var(--text-muted)", marginBottom: 6 }}>
                            Auto-filled from the checkboxes above. Edit freely for details this plugin can't detect,
                            like cooldown timing (e.g. "C2-2: Posting 45 minutes early from 12 hour cooldown.").
                            Ticking/unticking a box regenerates this text.
                        </Forms.FormText>
                        <TextArea
                            value={guidelines}
                            onChange={setGuidelines}
                            rows={3}
                            placeholder="C2-2: Posting 45 minutes early from 12 hour cooldown."
                        />
                    </div>

                    <div style={{
                        border: "1px solid var(--border-subtle)",
                        borderRadius: 6,
                        padding: "10px 12px",
                        background: "var(--background-base-lower)",
                    }}>
                        <Forms.FormTitle tag="h5">Check for prior warnings first</Forms.FormTitle>
                        <Forms.FormText style={{ color: "var(--text-muted)", marginBottom: 8 }}>
                            Searches #faction-discussion for "post for {faction.trim() || "(Faction name)"}".
                        </Forms.FormText>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                            <Button
                                size={Button.Sizes.SMALL}
                                color={Button.Colors.PRIMARY}
                                disabled={searching}
                                onClick={() => void runFactionSearch(faction)}
                            >
                                {searching ? "Searching…" : "Search again"}
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                color={Button.Colors.TRANSPARENT}
                                onClick={() => {
                                    const value = `in:#faction-discussion post for ${faction.trim() || "(Faction name)"}`;
                                    copyToClipboard(value);
                                    showToast({ text: "Copied search query", variant: "success" });
                                }}
                            >
                                Copy query
                            </Button>
                        </div>

                        {searchError && (
                            <Forms.FormText style={{ color: "var(--text-danger)", marginBottom: 8 }}>
                                {searchError}
                            </Forms.FormText>
                        )}

                        {!searchError && searchResult && (
                            searchResult.hits.length === 0 ? (
                                <Forms.FormText style={{ color: "var(--text-muted)" }}>
                                    No prior posts found for "{faction.trim() || "(Faction name)"}".
                                </Forms.FormText>
                            ) : (
                                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6, maxHeight: 220, overflowY: "auto" }}>
                                    <Forms.FormText style={{ color: "var(--text-muted)" }}>
                                        {searchResult.totalResults} match{searchResult.totalResults === 1 ? "" : "es"}
                                        {searchResult.hits.length < searchResult.totalResults ? ` (showing ${searchResult.hits.length})` : ""}:
                                    </Forms.FormText>
                                    {searchResult.hits.slice(0, 15).map(hit => (
                                        <div
                                            key={hit.messageId}
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 8,
                                                border: "1px solid var(--border-subtle)",
                                                borderRadius: 4,
                                                padding: "6px 8px",
                                            }}
                                        >
                                            <div style={{ flexGrow: 1, minWidth: 0 }}>
                                                <Text variant="text-sm/normal" style={{
                                                    whiteSpace: "nowrap",
                                                    overflow: "hidden",
                                                    textOverflow: "ellipsis",
                                                }}>
                                                    {hit.content || "(no text content)"}
                                                </Text>
                                                <Forms.FormText style={{ color: "var(--text-muted)" }}>
                                                    {hit.authorName} · {hit.timestamp ? new Date(hit.timestamp).toLocaleString() : "unknown time"}
                                                </Forms.FormText>
                                            </div>
                                            <Button
                                                size={Button.Sizes.MIN}
                                                color={Button.Colors.PRIMARY}
                                                onClick={() => handleJumpToHit(hit)}
                                            >Jump
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            )
                        )}
                    </div>

                    <div>
                        <Forms.FormTitle tag="h5">Send the warning</Forms.FormTitle>
                        <Forms.FormText style={{ color: "var(--text-muted)", marginBottom: 8 }}>
                            Post the copied message in #faction-discussion once you've confirmed the punishment tier.
                        </Forms.FormText>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {WARNING_KINDS.map(({ kind, label }) => (
                                <Button
                                    key={kind}
                                    size={Button.Sizes.SMALL}
                                    color={fdStanding?.suggested === kind ? Button.Colors.RED : Button.Colors.PRIMARY}
                                    onClick={() => handleCopy(kind)}
                                >
                                    {label}{fdStanding?.suggested === kind ? " (suggested)" : ""}
                                </Button>
                            ))}
                        </div>
                    </div>

                    {preview && (
                        <div>
                            <Forms.FormTitle tag="h5">
                                Preview{previewKind ? ` (${previewKind})` : ""}
                            </Forms.FormTitle>
                            <TextArea value={preview} onChange={() => { }} rows={8} />
                        </div>
                    )}
                </div>
            </ModalContent>

            <ModalFooter>
                <Button
                    color={Button.Colors.PRIMARY}
                    onClick={() => {
                        ChannelRouter.transitionToChannel(context.threadId);
                    }}
                >
                    Jump to post
                </Button>
                <Button
                    color={Button.Colors.PRIMARY}
                    onClick={() => {
                        copyToClipboard(`https://discord.com/channels/${FIXED_IDS.guildId}/${context.threadId}`);
                        showToast({ text: "Copied post link", variant: "success" });
                    }}
                >
                    Copy post link
                </Button>
                <Button color={Button.Colors.TRANSPARENT} onClick={props.onClose}>
                    Close
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

export function openViolationTextModal(context: ViolationNoticeContext) {
    openModal(props => <ViolationNoticeModal {...props} context={context} />);
}
