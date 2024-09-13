/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import { makeRange } from "@components/PluginSettings/components";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { GuildChannelStore, Menu, PermissionsBits, PermissionStore, React, RestAPI, SelectedChannelStore, UserStore, useStateFromStores } from "@webpack/common";
import type { Channel } from "discord-types/general";

const VoiceStateStore = findStoreLazy("VoiceStateStore");

const ChannelActions: {
    disconnect: () => void;
    selectVoiceChannel: (channelId: string) => void;
} = findByPropsLazy("disconnect", "selectVoiceChannel");

async function runSequential<T>(promises: (() => Promise<T>)[]): Promise<T[]> {
    const results: T[] = [];

    for (let i = 0; i < promises.length; i++) {
        const promise = promises[i]();
        const result = await promise;
        results.push(result);

        if (i % settings.store.waitAfter === 0) {
            await new Promise(resolve => setTimeout(resolve, settings.store.waitSeconds * 1000));
        }
    }

    return results;
}

function sendPatch(channel: Channel, body: Record<string, any>, bypass = false) {
    const usersVoice = VoiceStateStore.getVoiceStatesForChannel(channel.id); // Get voice states by channel id
    const myId = UserStore.getCurrentUser().id; // Get my user id

    const promises: (() => Promise<any>)[] = [];
    Object.values(usersVoice).forEach((userVoice: any) => {
        if (bypass || userVoice.userId !== myId) {
            promises.push(() => RestAPI.patch({
                url: `/guilds/${channel.guild_id}/members/${userVoice.userId}`,
                body: body
            }));
        }
    });

    runSequential(promises).catch(error => {
        console.error("VoiceChatUtilities failed to run", error);
    });
}

const actions: Record<string, (channel: Channel, newChannel?: Channel) => void> = {
    serverMute: c => sendPatch(c, { mute: true }),
    serverUnmute: c => sendPatch(c, { mute: false }),
    serverDeafen: c => sendPatch(c, { deaf: true }),
    serverUndeafen: c => sendPatch(c, { deaf: false }),

    disconnect: channel => {
        if (SelectedChannelStore.getVoiceChannelId() === channel.id) ChannelActions.disconnect();
        sendPatch(channel, { channel_id: null });
    },
    moveTo: (channel, newChannel) => {
        if (SelectedChannelStore.getVoiceChannelId() === channel.id) ChannelActions.selectVoiceChannel(newChannel!.id);
        sendPatch(channel, { channel_id: newChannel!.id });
    }
};

interface VoiceChannelContextProps {
    channel: Channel;
}

const VoiceChannelContext: NavContextMenuPatchCallback = (children, { channel }: VoiceChannelContextProps) => {
    // only for voice and stage channels
    if (!channel || (channel.type !== 2 && channel.type !== 13)) return;
    const userCount = Object.keys(VoiceStateStore.getVoiceStatesForChannel(channel.id)).length;
    if (userCount === 0) return;

    const guildChannels: { VOCAL: { channel: Channel, comparator: number; }[]; } = GuildChannelStore.getChannels(channel.guild_id);
    const voiceChannels = guildChannels.VOCAL.map(({ channel }) => channel).filter(({ id }) => id !== channel.id);

    const [
        movePermission,
        mutePermission,
        deafPermission,
    ] = [
        PermissionsBits.MOVE_MEMBERS,
        PermissionsBits.MUTE_MEMBERS,
        PermissionsBits.DEAFEN_MEMBERS,
    ].map(p => useStateFromStores([PermissionStore], () => true));//PermissionStore.canWithPartialContext(p, { channelId: channel.id })));

    children.splice(
        -1,
        0,
        <Menu.MenuItem
            label="Voice Tools"
            key="voice-tools"
            id="voice-tools"
        >
            <Menu.MenuGroup
                label="Client"
            >
                {/* <Menu.MenuItem
                    key="voice-tools-mute-all"
                    id="voice-tools-mute-all"
                    label="Mute all locally"
                    action={() => actions.mute(channel)}
                />
                <Menu.MenuItem
                    key="voice-tools-unmute-all"
                    id="voice-tools-unmute-all"
                    label="Unmute all locally"
                    action={() => actions.unmute(channel)}
                />

                <Menu.MenuItem
                    key="voice-tools-soundboard-sound-mute-all"
                    id="voice-tools-soundboard-sound-mute-all"
                    label="Mute all soundboards"
                    action={() => actions.mute(channel)}
                />
                <Menu.MenuItem
                    key="voice-tools-soundboard-sound-unmute-all"
                    id="voice-tools-soundboard-sound-unmute-all"
                    label="Unmute all soundboards"
                    action={() => actions.unmute(channel)}
                /> */}
            </Menu.MenuGroup>

            <Menu.MenuGroup
                label="Server"
            >
                {mutePermission && <>
                    <Menu.MenuItem
                        key="voice-tools-server-mute-all"
                        id="voice-tools-server-mute-all"
                        label="Server mute all"
                        action={() => actions.mute(channel)}
                    />
                    <Menu.MenuItem
                        key="voice-tools-server-unmute-all"
                        id="voice-tools-server-unmute-all"
                        label="Server unmute all"
                        action={() => actions.unmute(channel)}
                    />
                </>}

                {deafPermission && <>
                    <Menu.MenuItem
                        key="voice-tools-server-deafen-all"
                        id="voice-tools-server-deafen-all"
                        label="Server deafen all"
                        action={() => actions.deafen(channel)}
                    />
                    <Menu.MenuItem
                        key="voice-tools-server-undeafen-all"
                        id="voice-tools-server-undeafen-all"
                        color="danger"
                        label="Server undeafen all"
                        action={() => actions.undeafen(channel)}
                    />
                </>}

                {movePermission && <>
                    <Menu.MenuItem
                        key="voice-tools-disconnect-all"
                        id="voice-tools-disconnect-all"
                        color="danger"
                        label="Disconnect all"
                        action={() => actions.disconnect(channel)}
                    />
                    <Menu.MenuItem
                        label="Move all"
                        key="voice-tools-move-all"
                        id="voice-tools-move-all"
                    >
                        {voiceChannels.map(voiceChannel => {
                            return (
                                <Menu.MenuItem
                                    key={voiceChannel.id}
                                    id={voiceChannel.id}
                                    label={voiceChannel.name}
                                    action={() => actions.move(channel, voiceChannel)}
                                />
                            );
                        })}
                    </Menu.MenuItem>
                </>}
            </Menu.MenuGroup>

        </Menu.MenuItem>
    );
};

const settings = definePluginSettings({
    waitAfter: {
        type: OptionType.SLIDER,
        description: "Amount of API actions to perform before waiting (to avoid rate limits)",
        default: 5,
        markers: makeRange(1, 20),
    },
    waitSeconds: {
        type: OptionType.SLIDER,
        description: "Time to wait between each action (in seconds)",
        default: 2,
        markers: makeRange(1, 10, .5),
    }
});

export default definePlugin({
    name: "VoiceChatUtilities",
    description: "This plugin allows you to perform multiple actions on an entire channel (move, mute, disconnect, etc.) (originally by dutake)",
    authors: [Devs.D3SOX],

    settings,

    contextMenus: {
        "channel-context": VoiceChannelContext,
        "rtc-channel": VoiceChannelContext,
    },
});


