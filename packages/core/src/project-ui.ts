/**
 * Project feature slots (#724, projects redesign #722): what a project feature plugin adds to the UI and to sessions,
 * declared on its manifest so the web lights it up without special-casing any plugin
 * (docs/design/projects/HANDOFF.md, "Features"). Every slot is optional.
 */

/** The catalogue groups of the Add a feature browser. */
export const PROJECT_FEATURE_CATEGORIES = ['planning', 'events', 'knowledge', 'code', 'ops'] as const;
export type ProjectFeatureCategory = (typeof PROJECT_FEATURE_CATEGORIES)[number];

/** What a feature cannot work without: Git needs a folder. */
export type ProjectFeatureNeed = 'folder' | 'machine';

export interface ProjectFeatureUi {
    /** A sidebar item under the project's FEATURES block, and a route `/projects/:id/f/<feature>`. */
    readonly section?: { readonly label: string; readonly icon: string; readonly badge?: 'open-items' | 'none' };
    /** A card in the project home's right column. */
    readonly overviewCard?: { readonly title: string };
    /** The stages a work item moves through (the first enabled feature that declares them wins). */
    readonly workStages?: readonly string[];
    /** Ref prefixes it adds in chats (`#` items, `pr:`). */
    readonly chatRefPrefixes?: readonly string[];
    /** Tool families it adds to every session of the project. */
    readonly tools?: readonly string[];
    readonly needs?: readonly ProjectFeatureNeed[];
}

const isText = (v: unknown): boolean => typeof v === 'string' && v.length > 0;
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every(isText);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why a manifest's `ui` block is malformed, or `undefined` when it is well formed. */
export function projectFeatureUiError(ui: unknown): string | undefined {
    if (!isObject(ui)) return 'ui must be an object';
    const { section, overviewCard, workStages, chatRefPrefixes, tools, needs } = ui;
    if (section !== undefined && (!isObject(section) || !isText(section.label) || !isText(section.icon) || (section.badge !== undefined && section.badge !== 'open-items' && section.badge !== 'none')))
        return 'ui.section needs a label and an icon';
    if (overviewCard !== undefined && (!isObject(overviewCard) || !isText(overviewCard.title))) return 'ui.overviewCard needs a title';
    if (workStages !== undefined && (!isStrings(workStages) || (workStages as unknown[]).length < 2)) return 'ui.workStages needs at least two stage names';
    if (chatRefPrefixes !== undefined && !isStrings(chatRefPrefixes)) return 'ui.chatRefPrefixes must be strings';
    if (tools !== undefined && !isStrings(tools)) return 'ui.tools must be tool family names';
    if (needs !== undefined && (!Array.isArray(needs) || !needs.every((n) => n === 'folder' || n === 'machine'))) return 'ui.needs must be folder or machine';
    return undefined;
}
