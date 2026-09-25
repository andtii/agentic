/**
 * Mock data for the project Chats (#731) — imported only by its own page; nothing shared re-exports it.
 * The sample workspace's `agentic` project as board `ProjectChats` draws it, a few archived chats, one `docs-site`
 * chat, and the chats outside every project that "Review and move" lists — two of them mention agentic.
 */
import { MOCK_NOW } from '../workspace';
import type { ProjectChatRow } from '../../pages/projects/chats/groups';

const min = (n: number): number => MOCK_NOW - n * 60_000;

export const MOCK_PROJECT_CHATS: readonly ProjectChatRow[] = [
    { id: 'pc1', title: 'Release notes for 0.4', speaker: 'Forge', lastLine: 'Should the plugin kind rename go under Breaking? It changes manifests.', agentIds: ['atlas', 'forge'], waiting: true, working: false, updatedAt: min(12), projectId: 'p_agentic', work: [{ kind: 'task', id: 't_9a31' }] },
    { id: 'pc2', title: 'Usage rings on the member card', speaker: 'Forge', lastLine: 'size-limit failed, trimming the ring SVG and pushing again', agentIds: ['forge'], waiting: false, working: true, updatedAt: min(4), projectId: 'p_agentic', work: [{ kind: 'pull', number: 603 }, { kind: 'task', id: 't_91a0' }] },
    { id: 'pc3', title: 'Plan the Projects restructure', speaker: 'Atlas', lastLine: 'Split into 4 tasks, Forge takes the nav, Lint the tests', agentIds: ['atlas', 'forge', 'lint'], waiting: false, working: true, updatedAt: min(9), projectId: 'p_agentic', work: [{ kind: 'tasks', count: 4 }] },
    { id: 'pc4', title: 'Drawer behaviour on tablets', speaker: 'You', lastLine: 'ok ship it as long as the spec covers 768', agentIds: ['forge', 'lint'], waiting: false, working: false, updatedAt: min(120), projectId: 'p_agentic', work: [{ kind: 'pull', number: 602 }, { kind: 'pull', number: 598 }] },
    { id: 'pc5', title: 'Why is nuc-lab offline?', speaker: 'Atlas', lastLine: 'Daemon lost its token after the reboot. Re-pair when you are home.', agentIds: ['atlas'], waiting: false, working: false, updatedAt: min(180), projectId: 'p_agentic', work: [] },
    { id: 'pc6', title: 'Size budget for the shell', speaker: 'Lint', lastLine: 'Budget raised to 42 kB, noted in the PR.', agentIds: ['lint'], waiting: false, working: false, archived: true, updatedAt: min(60 * 24 * 3), projectId: 'p_agentic', work: [{ kind: 'pull', number: 571 }] },
    { id: 'pc7', title: 'Worktree per chat', speaker: 'Forge', lastLine: 'Merged. Worktrees now park on release.', agentIds: ['forge'], waiting: false, working: false, archived: true, updatedAt: min(60 * 24 * 5), projectId: 'p_agentic', work: [] },
    { id: 'pc8', title: 'Blog post outline', speaker: 'Scout', lastLine: 'Three sections, draft by Friday.', agentIds: ['scout'], waiting: false, working: false, updatedAt: min(300), projectId: 'p_docs', work: [] },
    { id: 'pc9', title: 'Try the new MCP inspector', speaker: 'Forge', lastLine: 'It lists every tool agentic serves, with scopes.', agentIds: ['forge'], waiting: false, working: false, updatedAt: min(45), work: [] },
    { id: 'pc10', title: 'Compare A2A clients', speaker: 'Scout', lastLine: 'Two of them talk to agentic out of the box.', agentIds: ['scout'], waiting: false, working: false, updatedAt: min(200), work: [] },
    { id: 'pc11', title: 'Lunch spots near the office', speaker: 'Atlas', lastLine: 'The ramen place opens at 11.', agentIds: ['atlas'], waiting: false, working: false, updatedAt: min(400), work: [] }
];
