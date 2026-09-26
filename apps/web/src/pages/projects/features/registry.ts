/**
 * Project feature id → what the feature draws in the web app (#725): its section page (at `/projects/:id/f/<feature>`,
 * or at its own `path`) and its card on the project's Overview. The manifest's `ui` block says a feature has them
 * (`ProjectFeatureUi`) and is the one source of the sidebar item's label, icon and badge (#941, `featureSectionOf`);
 * this says which component draws them.
 *
 * One line per feature issue: each replaces its own slot line with its entry and touches nothing else here.
 */
import type { ProjectFeatureUi } from '@agentic/core';
import { ICON_NAMES, type IconName } from '@agentic/ui';
import { projectFeatureCatalogue } from '../../../plugins/features';
import type { ProjectPage } from '../layout/types';
import { GitOverviewCard, GitSection } from './git/GitSection';
import { PlanList } from './plan/list/PlanList';
import { PlanOverviewCard } from './plan/shared/parts';

export interface ProjectFeatureViews {
    /** The section's name: the manifest's `ui.section.label`, filled in by `featureViewsOf`. */
    readonly label?: string;
    /** A route of its own under the project instead of `f/<feature>` (Plan: `plan`, Git: `code`). */
    readonly path?: string;
    /** The feature's section page. */
    readonly Section?: ProjectPage;
    /** Its card in the Overview's right column. */
    readonly OverviewCard?: ProjectPage;
}

export const PROJECT_FEATURE_VIEWS: Readonly<Record<string, ProjectFeatureViews>> = {
    'agentic.feature.git': { path: 'code', Section: GitSection, OverviewCard: GitOverviewCard },

    'agentic.feature.plan': { path: 'plan', Section: PlanList, OverviewCard: PlanOverviewCard },
};

/** Manifest icon names the kit spells differently. */
const ICON_ALIASES: Readonly<Record<string, IconName>> = { code: 'terminal', 'git-branch': 'branch', calendar: 'schedules' };

/** A manifest's icon name as a kit glyph: itself, its alias, or the plugin glyph for one the kit does not draw. */
export function featureIcon(icon: string | undefined): IconName {
    if (!icon) return 'plugins';
    return (ICON_NAMES as readonly string[]).includes(icon) ? (icon as IconName) : (ICON_ALIASES[icon] ?? 'plugins');
}

/** A feature's sidebar item as its manifest declares it: `ui.section`, the icon as a kit glyph. */
export interface FeatureSectionItem {
    readonly label: string;
    readonly icon: IconName;
    /** `open-items`: the item carries the feature's count; `none` (the default): no count. */
    readonly badge: 'open-items' | 'none';
}

/** The `ui` block of the build's manifest for `featureId` (`plugins/features.ts`), or `undefined` for one it lacks. */
export const featureUiOf = (featureId: string): ProjectFeatureUi | undefined =>
    (Object.hasOwn(projectFeatureCatalogue, featureId) ? projectFeatureCatalogue[featureId]!.manifest.ui : undefined);

/** The sidebar item a feature's manifest declares (`ui.section`), or `undefined` when it declares none. */
export function featureSectionOf(featureId: string, ui: ProjectFeatureUi | undefined = featureUiOf(featureId)): FeatureSectionItem | undefined {
    const section = ui?.section;
    return section ? { label: section.label, icon: featureIcon(section.icon), badge: section.badge ?? 'none' } : undefined;
}

/** The views of an enabled feature, `label` from its manifest's section, or `undefined` when it draws nothing of its own. */
export const featureViewsOf = (featureId: string): ProjectFeatureViews | undefined => {
    const views = Object.hasOwn(PROJECT_FEATURE_VIEWS, featureId) ? PROJECT_FEATURE_VIEWS[featureId] : undefined;
    if (!views) return undefined;
    const label = featureSectionOf(featureId)?.label;
    return label ? { ...views, label } : views;
};

/** Where a feature's section lives in a project. */
export const featureHref = (projectId: string, featureId: string): string =>
    `/projects/${projectId}/${featureViewsOf(featureId)?.path ?? `f/${encodeURIComponent(featureId)}`}`;
