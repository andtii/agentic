/**
 * Mock data for the project layout (#728): the sub-menu counts as the ProjectHome board draws them — Chats 5, Work
 * with 3 that need you. Imported only by the layout's own files; nothing shared re-exports it. A project not listed
 * here gets counts derived from the sample chats (`countsFromChats`).
 */
import type { ProjectMenuCounts } from '../../pages/projects/layout/counts';

export const MOCK_PROJECT_MENU_COUNTS: Readonly<Record<string, ProjectMenuCounts>> = {
    p_agentic: { chats: 5, work: 7, needsYou: 3 }
};
