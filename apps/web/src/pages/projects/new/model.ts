/**
 * The New project dialog's view model (#733, PRJ-18): two steps — the project (name, description, an optional folder)
 * and its project manager (a suggested name, a personality preset or custom text, skills) — and the `ProjectPatch`
 * the create sends, carrying `pm: ProjectManagerSpec` (#757) for the platform to create the manager agent (#784).
 * Pure: the mock and the live dialog render the same steps over it.
 */
import { PM_PERSONALITIES, PM_PERSONALITY_MAX, type ProjectManagerSpec, type ProjectPatch } from '@agentic/core';
import type { ProjectFolderDraft } from '../model';

export type NewProjectStep = 'project' | 'manager';

export interface NewProjectDraft {
    step: NewProjectStep;
    name: string;
    description: string;
    /** The folder by `projectFolderKey` (the machine's, `<machineId>/*`), or none: a project may run on the platform. */
    folder: { key: string; row: ProjectFolderDraft } | null;
    /** The manager's name; `''` takes the suggestion. */
    pmName: string;
    /** A preset id from `PM_PERSONALITIES`, or `'custom'` for `pmCustom`. */
    personality: string;
    pmCustom: string;
    skills: string[];
}

/** The custom personality's card value. */
export const CUSTOM_PERSONALITY = 'custom';

/** One line of how each preset talks, for its card. */
export const PERSONALITY_SAMPLES: Readonly<Record<string, string>> = {
    'calm-organiser': '"Plan is up to date. Forge has #12 next; nothing is blocked."',
    'direct-driver': '"#12 is stuck two days. Cutting the export step; ship the rest today."',
    'friendly-coach': '"Nice work on the parser! Want to split #14 into two smaller steps?"',
    'meticulous-reviewer': '"#12 misses its done-when: no test reproduces the bug yet."'
};

export const blankNewProject = (): NewProjectDraft => ({
    step: 'project',
    name: '',
    description: '',
    folder: null,
    pmName: '',
    personality: PM_PERSONALITIES[0]!.id,
    pmCustom: '',
    skills: []
});

/** The manager's suggested name: the project's, then "PM". */
export function suggestedPmName(projectName: string): string {
    const name = projectName.trim();
    return name ? `${name} PM` : 'Project manager';
}

export type NewProjectErrors = Partial<Record<'name' | 'personality', string>>;

export function validateNewProject(d: Pick<NewProjectDraft, 'step' | 'name' | 'personality' | 'pmCustom'>): NewProjectErrors {
    const errors: NewProjectErrors = {};
    if (!d.name.trim()) errors.name = 'A name is required.';
    if (d.step === 'manager' && d.personality === CUSTOM_PERSONALITY && !d.pmCustom.trim()) errors.personality = 'Describe how the project manager works, or pick a preset.';
    return errors;
}

/** The manager spec the create carries: the name (or the suggestion), the preset or custom text, the skills. */
export function pmSpecOf(d: NewProjectDraft): ProjectManagerSpec {
    const custom = d.personality === CUSTOM_PERSONALITY;
    return {
        name: d.pmName.trim() || suggestedPmName(d.name),
        personality: custom ? { custom: d.pmCustom.trim().slice(0, PM_PERSONALITY_MAX) } : { preset: d.personality },
        skills: [...new Set(d.skills.map((s) => s.trim()).filter(Boolean))].map((id) => ({ id }))
    };
}

/** The create: a new project (no id) with its name, description, folder when one was picked, and the manager spec. */
export function newProjectPatchOf(d: NewProjectDraft): ProjectPatch {
    const description = d.description.trim();
    const path = d.folder?.row.path.trim();
    return {
        name: d.name.trim(),
        ...(description ? { description } : {}),
        ...(d.folder && path ? { folders: { [d.folder.key]: path } } : {}),
        pm: pmSpecOf(d)
    };
}
