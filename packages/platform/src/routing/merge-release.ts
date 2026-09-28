/**
 * A merged pull request releases its chat (#675; PLG-01/02, decisions 2026-09-28): the project's Pulls actor sees a
 * PR merged — GitHub's own state, so squash merges count — and, when the PR names a chat, the router is told
 * `chatReleased(chatId, projectId, 'merged')` one-way, as the workspace user (a poll hop carries no principal). The
 * router checks the chat is still in the project and runs every feature plugin's `onChatReleased`, audited
 * `project.chat-released`; the git plugin removes the chat's clean worktree under `worktreeCleanup: 'on-merge'`.
 * Best effort: a failure is logged and never stops the merge's other notices (`then`).
 */
import { actor, type AnyActorDefinition } from '@sigx/actors';
import type { ChatId, ProjectFeatureReleaseReason, ProjectId } from '@agentic/core';
import { asPrincipal, userPrincipal } from '../auth/index.js';
import type { PullMergedPort } from '../pulls/actor.js';
import { routingKey } from './key.js';

export interface PullMergeReleaseOptions {
    /** The Routing actor definition (`defineRoutingActor`), as a thunk like `ChatOptions.routing`. */
    readonly routing: () => AnyActorDefinition;
    /** The merge hook that runs after the release is sent (production: `pullMergeNotices()`). */
    readonly then?: PullMergedPort;
}

interface ReleaseClient {
    chatReleased(chatId: ChatId, projectId: ProjectId, reason: ProjectFeatureReleaseReason): Promise<void>;
}

export function pullMergeRelease(options: PullMergeReleaseOptions): PullMergedPort {
    return {
        async merged(hop, event) {
            const { workspaceId, projectId, pr } = event;
            if (pr.chatId !== undefined) {
                try {
                    const router = actor(options.routing(), routingKey(workspaceId)).with({ context: asPrincipal(userPrincipal(workspaceId, workspaceId)), oneWay: true }) as unknown as ReleaseClient;
                    await router.chatReleased(pr.chatId, projectId, 'merged');
                } catch (error) {
                    console.warn(`[pulls] releasing chat ${pr.chatId} after #${pr.number} merged failed:`, error);
                }
            }
            await options.then?.merged(hop, event);
        }
    };
}
