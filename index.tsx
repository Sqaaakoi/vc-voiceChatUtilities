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
const MediaEngineStore = findStoreLazy("MediaEngineStore");
const SoundboardStore = findStoreLazy("SoundboardStore");

const ChannelActions: {
    disconnect: () => void;
    selectVoiceChannel: (channelId: string) => void;
} = findByPropsLazy("disconnect", "selectVoiceChannel");

const ClientActions: {
    toggleSelfMute: () => void;
    toggleLocalMute: (userId: string) => void;
    toggleLocalSoundboardMute: (userId: string) => void;
} = findByPropsLazy("toggleSelfMute", "toggleLocalMute", "toggleLocalSoundboardMute");

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

function getVoiceStates(channel: Channel, includeSelf?: boolean) {
    const vcStates: any = Object.values(VoiceStateStore.getVoiceStatesForChannel(channel.id));
    const myId = UserStore.getCurrentUser().id;
    return vcStates.filter(state => includeSelf || state.userId !== myId);
}

function sendPatch(channel: Channel, body: Record<string, any>, includeSelf = false) {
    const usersVoice = getVoiceStates(channel, includeSelf);

    const promises: (() => Promise<any>)[] = [];
    Object.values(usersVoice).forEach((userVoice: any) => {
        promises.push(() => RestAPI.patch({
            url: `/guilds/${channel.guild_id}/members/${userVoice.userId}`,
            body: body
        }));
    });

    runSequential(promises).catch(error => {
        console.error("VoiceChatUtilities failed to run", error);
    });
}

const actions: Record<string, (channel: Channel, newChannel?: Channel) => void> = {
    mute: c => {
        getVoiceStates(c).forEach(({ userId }) => { MediaEngineStore.isLocalMute(userId) || ClientActions.toggleLocalMute(userId); });
        if (settings.store.includeSelfInActions && !MediaEngineStore.isSelfMute()) ClientActions.toggleSelfMute();
    },
    unmute: c => {
        getVoiceStates(c).forEach(({ userId }) => { MediaEngineStore.isLocalMute(userId) && ClientActions.toggleLocalMute(userId); });
        if (settings.store.includeSelfInActions && MediaEngineStore.isSelfMute()) ClientActions.toggleSelfMute();
    },
    muteSoundboards: c => {
        getVoiceStates(c).forEach(({ userId }) => { SoundboardStore.isLocalSoundboardMuted(userId) || ClientActions.toggleLocalSoundboardMute(userId); });
    },
    unmuteSoundboards: c => {
        getVoiceStates(c).forEach(({ userId }) => { SoundboardStore.isLocalSoundboardMuted(userId) && ClientActions.toggleLocalSoundboardMute(userId); });
    },

    serverMute: c => sendPatch(c, { mute: true }, settings.store.includeSelfInActions),
    serverUnmute: c => sendPatch(c, { mute: false }, settings.store.includeSelfInActions),
    serverDeafen: c => sendPatch(c, { deaf: true }, settings.store.includeSelfInActions),
    serverUndeafen: c => sendPatch(c, { deaf: false }, settings.store.includeSelfInActions),

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
    const userCount = getVoiceStates(channel, settings.store.includeSelfInActions).length;
    const hasOtherUsers = getVoiceStates(channel, false).length > 0;
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
    ].map(p => useStateFromStores([PermissionStore], () => PermissionStore.canWithPartialContext(p, { channelId: channel.id })));

    children.splice(
        -1,
        0,
        <Menu.MenuItem
            label="Voice Tools"
            key="voice-tools"
            id="voice-tools"
        >
            <Menu.MenuGroup
                label="Client actions"
            >
                <Menu.MenuItem
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

                {hasOtherUsers && <>
                    {/* The client doesn't expose muting your own soundboard, so even if you allow taking action on yourself, this should only be shown if other users are in VC */}
                    <Menu.MenuItem
                        key="voice-tools-soundboard-sound-mute-all"
                        id="voice-tools-soundboard-sound-mute-all"
                        label="Mute all soundboards"
                        action={() => actions.muteSoundboards(channel)}
                    />
                    <Menu.MenuItem
                        key="voice-tools-soundboard-sound-unmute-all"
                        id="voice-tools-soundboard-sound-unmute-all"
                        label="Unmute all soundboards"
                        action={() => actions.unmuteSoundboards(channel)}
                    />
                </>}
            </Menu.MenuGroup>

            <Menu.MenuGroup
                label="Server actions"
            >
                {mutePermission && <>
                    <Menu.MenuItem
                        key="voice-tools-server-mute-all"
                        id="voice-tools-server-mute-all"
                        label="Server mute all"
                        action={() => actions.serverMute(channel)}
                    />
                    <Menu.MenuItem
                        key="voice-tools-server-unmute-all"
                        id="voice-tools-server-unmute-all"
                        label="Server unmute all"
                        action={() => actions.serverUnmute(channel)}
                    />
                </>}

                {deafPermission && <>
                    <Menu.MenuItem
                        key="voice-tools-server-deafen-all"
                        id="voice-tools-server-deafen-all"
                        label="Server deafen all"
                        action={() => actions.serverDeafen(channel)}
                    />
                    <Menu.MenuItem
                        key="voice-tools-server-undeafen-all"
                        id="voice-tools-server-undeafen-all"
                        color="danger"
                        label="Server undeafen all"
                        action={() => actions.serverUndeafen(channel)}
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
                                    action={() => actions.moveTo(channel, voiceChannel)}
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
    },
    includeSelfInActions: {
        type: OptionType.BOOLEAN,
        description: "If actions like muting and deafening will include yourself. Move/disconnect all will always include yourself",
        default: false,
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


