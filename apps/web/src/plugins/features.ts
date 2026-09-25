/**
 * Project feature plugin id → its code half (#329): `detect` suggests the feature when a project folder is added,
 * `beforeSession` / `instructions` run on the router (`defineRoutingActor({ projectFeatures })`). The git feature
 * (#335, `@agentic/plugins-git`): a worktree per chat through the daemon's `worktree` op, and repo instructions.
 *
 * Its own module (#533): the project form imports it in the browser, and `./catalogue.ts` holds server code (the
 * conduit engine) that must stay out of the client bundle.
 */
import type { ProjectFeaturePlugin } from '@agentic/core';
import { GIT_FEATURE_ID, gitFeaturePlugin } from '@agentic/plugins-git';

export const projectFeatureCatalogue: Readonly<Record<string, ProjectFeaturePlugin>> = {
    [GIT_FEATURE_ID]: gitFeaturePlugin,

    // slot #753 plan project feature — replace this line
};
