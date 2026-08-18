/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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
import { Button, ChannelRouter, ChannelStore, Forms, React, Text } from "@webpack/common";

import { FIXED_IDS } from "./constants";
import {
    duplicateHistory,
    formatDuration,
    subscribeDuplicateHistory,
} from "./index"; // or adjust if you put the exports in a shared module
import { openViolationTextModal } from "./ViolationModal";

function DuplicateHistoryModal(props: ModalProps) {
    const [, setVersion] = React.useState(0);

    React.useEffect(
        () => subscribeDuplicateHistory(() => setVersion(v => v + 1)),
        []
    );

    const items = duplicateHistory.slice(0, 40);

    return (
        <ModalRoot {...props} size={ModalSize.LARGE}>
            <ModalHeader>
                <Text variant="heading-lg/semibold" style={{ flexGrow: 1 }}>
                    Recent duplicate matches
                </Text>
                <ModalCloseButton onClick={props.onClose} />
            </ModalHeader>

            <ModalContent>
                {!items.length ? (
                    <Forms.FormText style={{
                        textAlign: "center",
                        padding: 32,
                        color: "var(--text-muted)",
                    }}>
                        No duplicate history yet.
                    </Forms.FormText>
                ) : (
                    <div style={{
                        display: "grid",
                        gap: 10,
                        maxHeight: 520,
                        overflowY: "auto",
                        paddingRight: 4,
                    }}>
                        {items.map(item => {
                            const reasonText = item.reasons
                                .map(r => r.toUpperCase())
                                .join(", ") || "NONE";

                            const similarityText = item.contentSimilarity == null
                                ? ""
                                : ` (${Math.round(item.contentSimilarity * 100)}%)`;

                            const windowMs = /* you can import getDuplicateWindowMs if you export it */
                                720 * 60 * 1000; // or better: export getDuplicateWindowMs

                            const timeUntilUnique = Math.max(0, windowMs - item.deltaMs);

                            return (
                                <div
                                    key={`${item.threadId}:${item.sourceThreadId}`}
                                    style={{
                                        border: "1px solid var(--border-subtle)",
                                        borderLeft: "4px solid var(--status-danger)",
                                        borderRadius: 6,
                                        padding: "12px 14px",
                                        background: "var(--background-base-lower)",
                                    }}
                                >
                                    {/* Header */}
                                    <div style={{ marginBottom: 6 }}>
                                        <Text variant="text-md/semibold">
                                            {item.threadTitle || item.threadId}
                                        </Text>
                                        <Forms.FormText style={{ color: "var(--text-muted)", marginTop: 2 }}>
                                            by {item.authorName}
                                            {item.authorId ? ` (${item.authorId})` : ""}
                                            {" · "}
                                            {new Date(item.createdAt).toLocaleString()}
                                        </Forms.FormText>
                                    </div>

                                    {/* Match info */}
                                    <Forms.FormText style={{ marginBottom: 4 }}>
                                        Matches <strong>{item.sourceTitle || item.sourceThreadId}</strong>
                                    </Forms.FormText>

                                    <Forms.FormText style={{ color: "var(--text-muted)", marginBottom: 6 }}>
                                        {formatDuration(item.deltaMs)} apart · {reasonText}{similarityText}
                                        {timeUntilUnique > 0
                                            ? ` · unique in ${formatDuration(timeUntilUnique)}`
                                            : " · unique now"}
                                    </Forms.FormText>

                                    {/* Content snippet */}
                                    {item.contentSnippet && (
                                        <Text
                                            variant="text-sm/normal"
                                            style={{
                                                whiteSpace: "pre-wrap",
                                                wordBreak: "break-word",
                                                marginBottom: 8,
                                                opacity: 0.9,
                                            }}
                                        >
                                            {item.contentSnippet.length > 180
                                                ? item.contentSnippet.slice(0, 180) + "…"
                                                : item.contentSnippet}
                                        </Text>
                                    )}

                                    {/* Extra flags */}
                                    {(item.excludedByPattern || item.violations.length > 0 || item.inviteCode) && (
                                        <div style={{
                                            display: "flex",
                                            flexWrap: "wrap",
                                            gap: 6,
                                            marginBottom: 8,
                                        }}>
                                            {item.excludedByPattern && (
                                                <span style={{
                                                    fontSize: 11,
                                                    padding: "2px 6px",
                                                    borderRadius: 4,
                                                    background: "var(--background-modifier-accent)",
                                                }}>
                                                    Excluded by regex
                                                </span>
                                            )}
                                            {item.inviteCode && (
                                                <span style={{
                                                    fontSize: 11,
                                                    padding: "2px 6px",
                                                    borderRadius: 4,
                                                    background: "var(--background-modifier-accent)",
                                                    fontFamily: "var(--font-code)",
                                                }}>
                                                    invite: {item.inviteCode}
                                                </span>
                                            )}
                                            {item.violations.map(v => (
                                                <span
                                                    key={v.code}
                                                    style={{
                                                        fontSize: 11,
                                                        padding: "2px 6px",
                                                        borderRadius: 4,
                                                        background: "rgba(0, 229, 255, 0.2)",
                                                        color: "#00e5ff",
                                                    }}
                                                >
                                                    {v.code}
                                                </span>
                                            ))}
                                        </div>
                                    )}

                                    {/* Actions */}
                                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                        <Button
                                            size={Button.Sizes.SMALL}
                                            onClick={() => {
                                                const channel = ChannelStore.getChannel(item.threadId);
                                                if (channel) ChannelRouter.transitionToThread(channel);
                                            }}
                                        >
                                            Jump to post
                                        </Button>

                                        <Button
                                            size={Button.Sizes.SMALL}
                                            color={Button.Colors.PRIMARY}
                                            onClick={() => {
                                                const channel = ChannelStore.getChannel(item.sourceThreadId);
                                                if (channel) ChannelRouter.transitionToThread(channel);
                                            }}
                                        >
                                            Jump to source
                                        </Button>

                                        <Button
                                            size={Button.Sizes.SMALL}
                                            color={Button.Colors.PRIMARY}
                                            onClick={() => {
                                                navigator.clipboard.writeText(
                                                    `https://discord.com/channels/${FIXED_IDS.guildId}/${item.threadId}`
                                                );
                                            }}
                                        >
                                            Copy link
                                        </Button>

                                        {item.violations.length > 0 && (
                                            <Button
                                                size={Button.Sizes.SMALL}
                                                color={Button.Colors.RED}
                                                onClick={() => openViolationTextModal({
                                                    threadId: item.threadId,
                                                    threadTitle: item.threadTitle,
                                                    authorId: item.authorId,
                                                    authorName: item.authorName,
                                                    violations: item.violations,
                                                })}
                                            >
                                                Copy violation notice…
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </ModalContent>

            <ModalFooter>
                <Button color={Button.Colors.PRIMARY} onClick={props.onClose}>
                    Close
                </Button>
            </ModalFooter>
        </ModalRoot>
    );
}

export function openDuplicateHistoryModal() {
    openModal(props => <DuplicateHistoryModal {...props} />);
}
