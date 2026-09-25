/**
 * Project feature id → what the feature draws in the web app (#725): its section (a sub-menu item under FEATURES
 * and a page at `/projects/:id/f/<feature>`, or at its own `path`) and its card on the project's Overview. The
 * manifest's `ui` block says a feature has them (`ProjectFeatureUi`); this says which component draws them.
 *
 * One line per feature issue: each replaces its own slot line with its entry and touches nothing else here.
 */
import type { ProjectPage } from '../layout/types';

export interface ProjectFeatureViews {
    /** The sub-menu label; the manifest's `ui.section.label` when it has one, else the feature id. */
    readonly label?: string;
    /** A route of its own under the project instead of `f/<feature>` (Plan: `plan`). */
    readonly path?: string;
    /** The feature's section page. */
    readonly Section?: ProjectPage;
    /** Its card in the Overview's right column. */
    readonly OverviewCard?: ProjectPage;
}

export const PROJECT_FEATURE_VIEWS: Readonly<Record<string, ProjectFeatureViews>> = {
    // slot #746 git feature views — replace this line

    // slot #754 plan feature views — replace this line
};

/** The views of an enabled feature, or `undefined` when it draws nothing of its own. */
export const featureViewsOf = (featureId: string): ProjectFeatureViews | undefined => PROJECT_FEATURE_VIEWS[featureId];

/** Where a feature's section lives in a project. */
export const featureHref = (projectId: string, featureId: string): string =>
    `/projects/${projectId}/${featureViewsOf(featureId)?.path ?? `f/${encodeURIComponent(featureId)}`}`;
