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
    Forms,
    React,
    showToast,
    Text,
    TextArea,
    TextInput,
    Toasts,
} from "@webpack/common";

import { FIXED_IDS } from "./constants";
import type { RuleViolation } from "./rules";
import type { ViolationNoticeContext } from "./types";

const PL5_EMOJI = "<:PL5:646268257384398848>";

type WarningKind = "verbal" | "minor" | "major" | "blacklist";

const WARNING_KINDS: Array<{ kind: WarningKind; label: string; color: any; }> = [
    { kind: "verbal", label: "Copy Verbal Warning", color: undefined },
    { kind: "minor", label: "Copy Minor Warning", color: undefined },
    { kind: "major", label: "Copy Major Warning", color: undefined },
    { kind: "blacklist", label: "Copy Blacklist Notice", color: undefined },
];

function formatViolationLines(violations: RuleViolation[]) {
    if (!violations.length) return "";
    return violations.map(violation => `${violation.code}: ${violation.summary}`).join("\n");
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
    const [guidelines, setGuidelines] = React.useState(formatViolationLines(context.violations));
    const [preview, setPreview] = React.useState("");
    const [previewKind, setPreviewKind] = React.useState<WarningKind | null>(null);

    const handleCopy = React.useCallback((kind: WarningKind) => {
        const message = buildWarningMessage(kind, ping, faction, guidelines);
        setPreview(message);
        setPreviewKind(kind);
        copyToClipboard(message);
        showToast(`Copied ${kind} warning to clipboard`, Toasts.Type.SUCCESS);
    }, [ping, faction, guidelines]);

    const searchQuery = `in:#faction-discussion post for ${faction.trim() || "(Faction name)"}`;
    const mentionsQuery = `mentions ${context.authorName || "(advertiser name)"}`;
    const factionWarningQuery = `${faction.trim() || "(Faction name)"} warning`;

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
                        <Forms.FormTitle tag="h5">Violated guideline(s)</Forms.FormTitle>
                        <Forms.FormText style={{ color: "var(--text-muted)", marginBottom: 6 }}>
                            Auto-filled from detected violations. Edit freely for things this plugin can't detect,
                            like cooldown timing (e.g. "C2-2: Posting 45 minutes early from 12 hour cooldown.").
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
                            Search for previous infractions before picking a punishment tier.
                        </Forms.FormText>
                        <div style={{ display: "grid", gap: 6 }}>
                            {[
                                { label: "Post history search", value: searchQuery },
                                { label: "\"mentions (name)\" search", value: mentionsQuery },
                                { label: "\"(Faction name) warning\" search", value: factionWarningQuery },
                            ].map(({ label, value }) => (
                                <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <Text variant="text-sm/normal" style={{ fontFamily: "var(--font-code)", flexGrow: 1, opacity: 0.9 }}>
                                        {value}
                                    </Text>
                                    <Button
                                        size={Button.Sizes.MIN}
                                        color={Button.Colors.PRIMARY}
                                        onClick={() => {
                                            copyToClipboard(value);
                                            showToast(`Copied: ${label}`, Toasts.Type.SUCCESS);
                                        }}
                                    >
                                        Copy
                                    </Button>
                                </div>
                            ))}
                        </div>
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
