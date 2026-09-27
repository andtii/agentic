/**
 * Mock data for the project Chats (#731) — imported only by its own page; nothing shared re-exports it.
 * The sample workspace's `agentic` project as board `ProjectChats` draws it, a few archived chats, one `docs-site`
 * chat, and the chats outside every project that "Review and move" lists — two of them mention agentic.
 *
 * #963: each row is a chat of the mock workspace (`PROJECT_CHATS`), so opening it loads the chat.
 */
import { PROJECT_CHATS, agentNamed } from '../workspace';
import type { ProjectChatRow, WorkChip } from '../../pages/projects/chats/groups';

/** What the rows show beyond the chat itself: the work chips. */
const WORK: Readonly<Record<string, readonly WorkChip[]>> = {
    pc1: [{ kind: 'task', id: 't_9a31' }],
    pc2: [{ kind: 'pull', number: 603 }, { kind: 'task', id: 't_91a0' }],
    pc3: [{ kind: 'tasks', count: 4 }],
    pc4: [{ kind: 'pull', number: 602 }, { kind: 'pull', number: 598 }],
    pc6: [{ kind: 'pull', number: 571 }]
};

export const MOCK_PROJECT_CHATS: readonly ProjectChatRow[] = PROJECT_CHATS.map((c) => ({
    id: c.id,
    title: c.title,
    speaker: c.speaker === 'you' ? 'You' : agentNamed(c.speaker).name,
    lastLine: c.lastLine,
    agentIds: c.members.map((m) => m.agentId),
    waiting: c.waiting,
    working: c.members.some((m) => m.status === 'active'),
    ...(c.archived ? { archived: true } : {}),
    updatedAt: c.updatedAt,
    ...(c.projectId ? { projectId: c.projectId } : {}),
    work: WORK[c.id] ?? []
}));
