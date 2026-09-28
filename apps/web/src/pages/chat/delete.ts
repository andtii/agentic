import type { ProjectRecord } from '@agentic/core';
import { GIT_FEATURE_ID } from '@agentic/plugins-git';

/**
 * What "Delete chat" says will happen (#674, `Workspace.deleteChat`): the thread and its attachments go, and — for a
 * chat in a project that gives each chat its own worktree — what the project's cleanup policy does with it. Pure, so
 * the wording is tested without a dialog.
 */
export function deleteChatText(project: Pick<ProjectRecord, 'name' | 'features'> | undefined): string {
    const gone = 'The thread, its members’ sessions and its attachments are deleted. This cannot be undone.';
    const git = project?.features[GIT_FEATURE_ID];
    if (!project || !git || git['worktreePerChat'] !== true) return gone;
    if (git['worktreeCleanup'] === 'on-chat-leave' || git['worktreeCleanup'] === 'on-merge') return `${gone} Its worktree in ${project.name} is removed on every machine that is online — unless it has uncommitted changes, then it is kept.`;
    return `${gone} Its worktree in ${project.name} stays: the project keeps chat worktrees until you remove them.`;
}
