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
    ChannelStore,
    Checkbox,
    Forms,
    MessageActions,
    React,
    RestAPI,
    showToast,
    Text,
    TextArea,
    TextInput,
    Toasts,
} from "@webpack/common";

import { FIXED_IDS } from "./constants";
import { C2_RULE_CATALOG, type RuleViolation } from "./rules";
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

// Builds the guideline text from whichever catalog checkboxes are selected,
// preferring a matching auto-detected violation's specific summary (e.g. the
// actual AI-signal list) over the catalog's generic rule text.
function buildGuidelinesText(selected: ReadonlySet<string>, detected: RuleViolation[]): string {
    const usedDetected = new Set<RuleViolation>();
    const lines: string[] = [];

    for (const rule of C2_RULE_CATALOG) {
        if (!selected.has(rule.code)) continue;
        const match = detected.find(
            violation => !usedDetected.has(violation) && ruleCodesFromViolationCode(violation.code).includes(rule.code)
        );
        if (match) {
            usedDetected.add(match);
            lines.push(`${match.code}: ${match.summary}`);
        } else {
            lines.push(`${rule.code}: ${rule.label}`);
        }
    }

    return lines.join("\n");
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
        // https://discord.com/api/v9/guilds/553917324340625424/messages/search?channel_id=594055247282831360&content=post%20for%20blackout%20pmc&sort_by=timestamp&sort_order=desc&offset=0
        // https://discord.com/api/v9/channels/594055247282831360/messages/search?content=post%20for%20BLACKOUT%20PMC&include_nsfw=true
        url: "/guilds/553917324340625424/messages/search",
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

function ViolationNoticeModal(props: ModalProps & { context: ViolationNoticeContext; }) {
    const { context } = props;

    const [ping, setPing] = React.useState(context.authorId ? `<@${context.authorId}>` : "");
    const [faction, setFaction] = React.useState(context.threadTitle ?? "");
    const [selectedCodes, setSelectedCodes] = React.useState(() => initialSelectedCodes(context.violations));
    const [guidelines, setGuidelines] = React.useState(() => buildGuidelinesText(selectedCodes, context.violations));
    const [preview, setPreview] = React.useState("");
    const [previewKind, setPreviewKind] = React.useState<WarningKind | null>(null);

    const [searching, setSearching] = React.useState(false);
    const [searchError, setSearchError] = React.useState<string | null>(null);
    const [searchResult, setSearchResult] = React.useState<SearchResult | null>(null);

    const handleCopy = React.useCallback((kind: WarningKind) => {
        const message = buildWarningMessage(kind, ping, faction, guidelines);
        setPreview(message);
        setPreviewKind(kind);
        copyToClipboard(message);
        showToast(`Copied ${kind} warning to clipboard`, Toasts.Type.SUCCESS);
    }, [ping, faction, guidelines]);

    const toggleRuleCode = React.useCallback((code: string) => {
        setSelectedCodes(prev => {
            const next = new Set(prev);
            if (next.has(code)) next.delete(code); else next.add(code);
            setGuidelines(buildGuidelinesText(next, context.violations));
            return next;
        });
    }, [context.violations]);

    const runFactionSearch = React.useCallback(async () => {
        const query = faction.trim();
        if (!query) {
            showToast("Enter a faction name first", Toasts.Type.FAILURE);
            return;
        }

        setSearching(true);
        setSearchError(null);
        try {
            const result = await searchFactionPosts(query, context.threadId);
            setSearchResult(result);
        } catch (error: any) {
            const status = error?.status;
            setSearchError(
                status === 403
                    ? "No permission to search this channel."
                    : error?.message || "Search failed."
            );
            setSearchResult(null);
        } finally {
            setSearching(false);
        }
    }, [faction, context.threadId]);

    // Auto-run the search once on open using the faction name we already have,
    // so prior posts show up without an extra click. Further edits to the
    // faction field just need the "Search" button.
    React.useEffect(() => {
        void runFactionSearch();
    }, []);

    const handleJumpToHit = React.useCallback((hit: SearchHit) => {
        const channel = ChannelStore.getChannel(hit.channelId);
        if (channel) ChannelRouter.transitionToThread(channel);
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
                <div style={{ display: "grid", gap: 16, padding: "16px 0" }}>
                    <Forms.FormText style={{ color: "var(--text-muted)" }}>
                        {context.threadTitle || context.threadId}
                        {context.authorName ? ` · posted by ${context.authorName}` : ""}
                    </Forms.FormText>

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
                            gridTemplateColumns: "1fr 1fr",
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
                                onClick={() => void runFactionSearch()}
                            >
                                {searching ? "Searching…" : "Search again"}
                            </Button>
                            <Button
                                size={Button.Sizes.SMALL}
                                color={Button.Colors.TRANSPARENT}
                                onClick={() => {
                                    const value = `in:#faction-discussion post for ${faction.trim() || "(Faction name)"}`;
                                    copyToClipboard(value);
                                    showToast("Copied search query", Toasts.Type.SUCCESS);
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
                                <div style={{ display: "grid", gap: 6, maxHeight: 220, overflowY: "auto" }}>
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
                                    color={Button.Colors.PRIMARY}
                                    onClick={() => handleCopy(kind)}
                                >
                                    {label}
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
                        const channel = ChannelStore.getChannel(context.threadId);
                        if (channel) ChannelRouter.transitionToThread(channel);
                    }}
                >
                    Jump to post
                </Button>
                <Button
                    color={Button.Colors.PRIMARY}
                    onClick={() => {
                        copyToClipboard(`https://discord.com/channels/${FIXED_IDS.guildId}/${context.threadId}`);
                        showToast("Copied post link", Toasts.Type.SUCCESS);
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
