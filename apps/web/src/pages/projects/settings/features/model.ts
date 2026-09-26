/**
 * Settings › Features view model (#736, PRJ-07): the catalogue entries the page draws — `Registry.projectFeatures()`
 * joined with each manifest's `projectSettings` schema live, the mock catalogue otherwise — which of them the project
 * has on, what each adds to the project (the five slots), what a feature cannot work without here (`needs`), and the
 * `ProjectPatch` an enable, a settings save or a remove sends to `Workspace.upsertProject`. Pure.
 */
import { isProjectFeatureManifest, PROJECT_FEATURE_CATEGORIES, type ConfigSchema, type PluginManifest, type ProjectFeatureCategory, type ProjectFeatureNeed, type ProjectFeaturePlugin, type ProjectFeaturePreset, type ProjectFeatureUi, type ProjectPatch, type ProjectRecord } from '@agentic/core';
import { PROJECT_FEATURE_SLOTS, usedSlots, type ProjectFeatureSlot } from '@agentic/ui';
import type { ProjectFeatureView } from '@agentic/platform';

/** One feature as the page draws it: the Registry's view plus the settings schema and what its slots say here. */
export interface FeatureEntry {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly version: string;
    /** On in the workspace; a project can only add a feature that is. */
    readonly enabled: boolean;
    readonly ui: ProjectFeatureUi;
    readonly category?: ProjectFeatureCategory;
    readonly needs: readonly ProjectFeatureNeed[];
    readonly presets: readonly ProjectFeaturePreset[];
    /** The per-project settings schema; absent or without properties, the panel shows no form. */
    readonly projectSettings?: ConfigSchema;
    /** The plugin has `instructions()`: the agent slot is used even without `ui.tools`. */
    readonly instructions: boolean;
    /** What a slot adds, in the plugin's words; a slot without one is described from the `ui` block. */
    readonly blurbs?: Partial<Record<ProjectFeatureSlot, string>>;
}

export const CATEGORY_LABELS: Readonly<Record<ProjectFeatureCategory, string>> = { planning: 'Planning', events: 'Events', knowledge: 'Knowledge', code: 'Code', ops: 'Ops' };

export const SLOT_TITLES: Readonly<Record<ProjectFeatureSlot, string>> = {
    section: 'Section',
    overviewCard: 'Overview card',
    workStages: 'Work stages',
    chatRefPrefixes: 'Chat context',
    tools: 'Agent instructions and tools'
};

/** The legend's shorter names, in mark order. */
export const SLOT_LEGEND: readonly { readonly slot: ProjectFeatureSlot; readonly label: string }[] = PROJECT_FEATURE_SLOTS.map((slot) => ({ slot, label: slot === 'tools' ? 'Agent instructions' : SLOT_TITLES[slot] }));

/** Live: the Registry's views, each with its manifest's `projectSettings` and the build's plugin (its presets when the Registry has none, and whether it writes instructions). */
export function featureEntriesOf(
    views: readonly ProjectFeatureView[],
    plugins: readonly { readonly manifest: PluginManifest }[],
    catalogue: Readonly<Record<string, ProjectFeaturePlugin>>
): FeatureEntry[] {
    const manifests = new Map(plugins.map((p) => p.manifest).filter(isProjectFeatureManifest).map((m) => [m.id, m]));
    return views.map((v) => {
        const impl = Object.hasOwn(catalogue, v.id) ? catalogue[v.id] : undefined;
        const schema = manifests.get(v.id)?.projectSettings ?? impl?.manifest.projectSettings;
        return {
            id: v.id,
            name: v.name,
            description: v.description,
            version: v.version,
            enabled: v.enabled,
            ui: v.ui,
            ...(v.category ? { category: v.category } : {}),
            needs: v.needs,
            presets: v.presets.length ? v.presets : (impl?.presets ?? []),
            ...(schema ? { projectSettings: schema } : {}),
            instructions: typeof impl?.instructions === 'function'
        };
    });
}

/** The features the project has on, in the project's order; one the catalogue does not know is drawn by its id. */
export function enabledEntries(entries: readonly FeatureEntry[], project: Pick<ProjectRecord, 'features'>): FeatureEntry[] {
    const byId = new Map(entries.map((e) => [e.id, e]));
    return Object.keys(project.features).map((id) => byId.get(id) ?? { id, name: id, description: 'Not in this build’s catalogue.', version: '', enabled: false, ui: {}, needs: [], presets: [], instructions: false });
}

/** Whether the project has a folder on some machine: what `folder` and `machine` needs ask for. */
const hasFolder = (project: Pick<ProjectRecord, 'folders'>): boolean => Object.values(project.folders).some((path) => typeof path === 'string' && path.trim() !== '');

/** What `entry` cannot work without that the project lacks, in the entry's order. */
export function unmetNeeds(entry: Pick<FeatureEntry, 'needs'>, project: Pick<ProjectRecord, 'folders'>): ProjectFeatureNeed[] {
    return entry.needs.filter(() => !hasFolder(project));
}

/** The tile's reason in place of `Add`: `NEEDS A FOLDER`. */
export const needLabel = (need: ProjectFeatureNeed): string => `NEEDS A ${need.toUpperCase()}`;

export interface CatalogueFilter {
    readonly query: string;
    /** `'all'` or a category. */
    readonly category: string;
}

/** The Add a feature tiles: every feature the project does not have on, matching the search and the category chip. */
export function catalogueTiles(entries: readonly FeatureEntry[], project: Pick<ProjectRecord, 'features'>, filter: CatalogueFilter): FeatureEntry[] {
    const q = filter.query.trim().toLowerCase();
    return entries.filter((e) => !Object.hasOwn(project.features, e.id)
        && (filter.category === 'all' || e.category === filter.category)
        && (!q || e.name.toLowerCase().includes(q) || e.description.toLowerCase().includes(q)));
}

/** The category chips: All, then all five categories in the catalogue's canonical order, whether or not a feature is in one yet (#941). */
export function categoryChips(): { readonly value: string; readonly label: string }[] {
    return [{ value: 'all', label: 'All' }, ...PROJECT_FEATURE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))];
}

/** One "What it adds here" row: a used slot and what it does in this project. */
export interface SlotLine {
    readonly slot: ProjectFeatureSlot;
    readonly title: string;
    readonly text: string;
}

const describeSlot = (entry: FeatureEntry, slot: ProjectFeatureSlot): string => {
    const ui = entry.ui;
    switch (slot) {
        case 'section':
            return `${ui.section?.label ?? entry.name}: a page in this project’s sidebar${ui.section?.badge === 'open-items' ? ', with open items counted' : ''}.`;
        case 'overviewCard':
            return `${ui.overviewCard?.title ?? entry.name}: a card on the project overview.`;
        case 'workStages':
            return `Work items move through ${(ui.workStages ?? []).join(' → ')}.`;
        case 'chatRefPrefixes':
            return `Adds ${(ui.chatRefPrefixes ?? []).map((p) => `${p}`).join(' and ')} refs in chats.`;
        case 'tools':
            return ui.tools?.length
                ? `${entry.instructions ? 'Joins every session’s Project section, and agents' : 'Agents'} get ${ui.tools.map((t) => `${t}_*`).join(', ')} tools.`
                : 'Joins every session’s Project section.';
    }
};

/** The slots `entry` fills, each with its title and what it adds. */
export function slotLines(entry: FeatureEntry): SlotLine[] {
    return usedSlots(entry.ui, entry.instructions).map((slot) => ({ slot, title: SLOT_TITLES[slot], text: entry.blurbs?.[slot] ?? describeSlot(entry, slot) }));
}

/** Whether a settings schema has anything to show. */
export const hasSettings = (schema: ConfigSchema | undefined): schema is ConfigSchema => !!schema && Object.keys(schema.properties ?? {}).length > 0;

/** Turn a feature on (with its starting settings) or save its settings: one feature key, the rest of the project kept. */
export const featurePatch = (project: Pick<ProjectRecord, 'id'>, id: string, settings: Readonly<Record<string, unknown>>): ProjectPatch => ({ id: project.id, features: { [id]: { ...settings } } });

/** Take a feature off the project (its items are kept for 30 days). */
export const removePatch = (project: Pick<ProjectRecord, 'id'>, id: string): ProjectPatch => ({ id: project.id, features: { [id]: null } });

/** `features` after `patch.features`, as `Workspace.upsertProject` merges it: `null` removes one. The mock page's save. */
export function applyFeaturesPatch(features: ProjectRecord['features'], patch: ProjectPatch): ProjectRecord['features'] {
    const next: Record<string, Readonly<Record<string, unknown>>> = { ...features };
    for (const [id, settings] of Object.entries(patch.features ?? {})) {
        if (settings === null) delete next[id];
        else next[id] = { ...settings };
    }
    return next;
}
