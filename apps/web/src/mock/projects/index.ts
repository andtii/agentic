/**
 * Mock data for the projects index (#729) — imported only by its own page; nothing shared re-exports it. The cards
 * are the sample workspace's projects (so each links to a project the mock pages know) with what needs you there;
 * the open-links strip and the unassigned strip carry what the Links page (L1) and the Work index would count.
 */
import type { OpenLinksData, ProjectCardData, UnassignedData } from '../../pages/projects/index/model';
import { CHATS, PROJECTS } from '../workspace';

/** What needs you per sample project, by id. */
const NEEDS: Readonly<Record<string, Omit<ProjectCardData, 'project'>>> = {
    p_agentic: { yourMove: 3, agentsOnIt: 4, next: 'Next: merge #602 · review #598 · decide #605' },
    p_docs: { yourMove: 0, agentsOnIt: 0, next: 'Nothing in flight · next reminder Fri 09:00' }
};

export const MOCK_PROJECT_CARDS: readonly ProjectCardData[] = PROJECTS.map((project) => ({ project, ...NEEDS[project.id] }));

export const MOCK_OPEN_LINKS: OpenLinksData = { count: 2, summary: 'agentic 0.5 waits on docs-site#12 · docs-site waits on agentic#598' };

/** The sample chats in no project, and one task. */
export const MOCK_UNASSIGNED: UnassignedData = { chats: CHATS.filter((c) => !c.projectId).length, tasks: 1 };
