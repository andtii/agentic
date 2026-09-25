/**
 * Mock data for Settings: General, Members, Folders, Connectors and New project (#722) — owned by #733, imported only
 * by its own pages; nothing shared re-exports it.
 */
import type { ProjectPatch } from '@agentic/core';

/** The skills the New project dialog offers its project manager on mock data; any other can be typed. */
export const MOCK_PM_SKILLS: readonly { readonly value: string; readonly label: string }[] = [
    { value: 'planning', label: 'Planning' },
    { value: 'triage', label: 'Triage' },
    { value: 'git-worktree', label: 'Git worktrees' },
    { value: 'release-notes', label: 'Release notes' }
];

/** Every patch a settings tab saved on mock data, newest last: the sample workspace is read-only, so a save lands here. */
export const mockSettingsSaves: ProjectPatch[] = [];
