/**
 * The git feature's UI slots (#740; PRJ-06, PRJ-08): the manifest declares a Code section and overview card, the Git
 * work stages, the `pr:` chat ref prefix and a folder requirement, under the `code` category — and still validates.
 */
import { describe, expect, it } from 'vitest';
import { isProjectFeatureManifest, projectFeatureUiError, workStagesFor, WORK_STAGES_FALLBACK } from '@agentic/core';

import { GIT_FEATURE_ID, gitFeatureManifest } from '../src/index';

describe('git feature ui slots', () => {
    it('declares the Code section, overview card, Git stages, pr: refs and a folder need', () => {
        expect(gitFeatureManifest.category).toBe('code');
        expect(gitFeatureManifest.ui).toEqual({
            section: { label: 'Code', icon: 'code' },
            overviewCard: { title: 'Code' },
            workStages: ['Ready', 'Code', 'PR', 'Checks', 'Review', 'Merge'],
            chatRefPrefixes: ['pr:'],
            needs: ['folder']
        });
    });

    it('validates as a project feature manifest', () => {
        expect(projectFeatureUiError(gitFeatureManifest.ui)).toBeUndefined();
        expect(isProjectFeatureManifest(gitFeatureManifest)).toBe(true);
    });

    it('supplies the work stages when Git is enabled, the fallback otherwise', () => {
        const uiOf = (id: string) => (id === GIT_FEATURE_ID ? gitFeatureManifest.ui : undefined);
        expect(workStagesFor([GIT_FEATURE_ID], uiOf)).toEqual(['Ready', 'Code', 'PR', 'Checks', 'Review', 'Merge']);
        expect(workStagesFor([], uiOf)).toEqual(WORK_STAGES_FALLBACK);
    });
});
