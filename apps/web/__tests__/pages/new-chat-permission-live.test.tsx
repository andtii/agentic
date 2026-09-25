/**
 * New chat's permission mode on the live platform (#698): `createChatWith` sets it on the picked Claude Code
 * members through `Chat.setOptions`, so each one's next turn opens in it; nothing picked leaves the options empty.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AgentId, EnvironmentId } from '@agentic/core';
import { AgentActor, Chat, agentKey } from '@agentic/platform';
import { clientDefs } from '../../src/actors/client';
import { chatKeyOf } from '../../src/actors/keys';
import { createChatWith } from '../../src/pages/chat/LiveChats';
import { USER, WS, owner, startLive, type LiveHarness } from './live-harness';

let h: LiveHarness;
beforeEach(async () => {
    h = await startLive();
});
afterEach(async () => {
    await h.stop();
});

async function claudeAgent(name: string): Promise<AgentId> {
    const id = await h.agent(name, 'Builds things');
    await h.app.as(owner).actor(AgentActor, agentKey(WS, id)).update({ name, instructions: 'Be brief.', execution: { runtime: 'claude-code', defaultEnvironmentId: 'env_x' as EnvironmentId, offlinePolicy: 'queue' } }, 'environment');
    return id;
}

describe('New chat permission mode, live (#698)', () => {
    it('sets the mode on the members it names and on nobody else', async () => {
        const forge = await claudeAgent('Forge');
        const lint = await claudeAgent('Lint');
        const defs = clientDefs();
        const chatId = await createChatWith(defs, USER, [forge, lint], null, null, null, { mode: 'bypassPermissions', agentIds: [forge] });
        const { members } = await h.app.as(owner).actor(Chat, chatKeyOf(USER, chatId)).get();
        expect(members[forge]!.options).toEqual({ permissionMode: 'bypassPermissions' });
        expect(members[lint]!.options).toBeUndefined();
        const plain = await createChatWith(defs, USER, [forge], null);
        expect((await h.app.as(owner).actor(Chat, chatKeyOf(USER, plain)).get()).members[forge]!.options).toBeUndefined();
    });
});
