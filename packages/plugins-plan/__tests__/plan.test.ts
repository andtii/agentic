/**
 * The plan feature (#753; PRJ-06, PRJ-11): the manifest validates with the Plan slots, the presets fill valid settings,
 * and `instructions()` explains the plan tools, the ref syntax and the project's limits.
 */
import { describe, expect, it } from 'vitest';
import { applyProjectFeaturePreset, configDefaults, isProjectFeatureManifest, PLAN_TOOLS, projectFeatureUiError, validateConfig, workStagesFor, type ProjectRecord } from '@agentic/core';

import { EVENT_DAY_TEMPLATE, PLAN_FEATURE_ID, PLAN_PRESETS, PLAN_TEMPLATES, planFeatureManifest, planFeaturePlugin, planInstructions, planSettingsErrors, planTemplateItemCount, previewPlanSettings } from '../src/index';

const project = { name: 'Summer party' } as ProjectRecord;
const defaults = () => configDefaults(planFeatureManifest.projectSettings);

describe('plan feature manifest', () => {
    it('declares the Plan section, overview card, stages, # refs and plan tools under planning', () => {
        expect(planFeatureManifest.id).toBe(PLAN_FEATURE_ID);
        expect(planFeatureManifest.category).toBe('planning');
        expect(planFeatureManifest.ui).toEqual({
            section: { label: 'Plan', icon: 'check', badge: 'open-items' },
            overviewCard: { title: 'Plan' },
            workStages: ['Ready', 'Do', 'Review', 'Done'],
            chatRefPrefixes: ['#'],
            tools: ['plan']
        });
    });

    it('validates as a project feature manifest', () => {
        expect(projectFeatureUiError(planFeatureManifest.ui)).toBeUndefined();
        expect(isProjectFeatureManifest(planFeatureManifest)).toBe(true);
    });

    it('supplies the work stages when Plan is the enabled feature', () => {
        expect(workStagesFor([PLAN_FEATURE_ID], (id) => (id === PLAN_FEATURE_ID ? planFeatureManifest.ui : undefined))).toEqual(['Ready', 'Do', 'Review', 'Done']);
    });

    it('has defaults that validate: agents may tick, one claim, a 30 minute lease, no starter', () => {
        const settings = defaults();
        expect(settings).toMatchObject({ agentsMayTick: true, claimLimit: 1, leaseMinutes: 30, starter: 'none' });
        expect(validateConfig(planFeatureManifest.projectSettings, settings).ok).toBe(true);
    });
});

describe('plan presets', () => {
    it('offers an Event day preset with its 20 items', () => {
        expect(planTemplateItemCount(EVENT_DAY_TEMPLATE)).toBe(20);
        expect(PLAN_PRESETS.find((p) => p.id === 'event-day')?.label).toBe('Event day (20 items)');
    });

    it('fill settings that validate, with a known starter', () => {
        for (const preset of PLAN_PRESETS) {
            const settings = applyProjectFeaturePreset(defaults(), preset);
            const merged = { ...defaults(), ...settings };
            expect(validateConfig(planFeatureManifest.projectSettings, merged).ok, preset.id).toBe(true);
            expect(planSettingsErrors(merged), preset.id).toEqual({});
        }
    });

    it('every preset label counts the items of its starter plan', () => {
        for (const preset of PLAN_PRESETS) {
            const starter = preset.settings['starter'];
            if (typeof starter !== 'string') continue;
            expect(preset.label).toContain(`(${planTemplateItemCount(PLAN_TEMPLATES[starter]!)} items)`);
        }
    });

    it('flags an unknown starter plan', () => {
        expect(planSettingsErrors({ starter: 'wedding' })).toEqual({ starter: 'no starter plan called "wedding"' });
    });

    it('previews the starter, the claim rules and who ticks', () => {
        const settings = applyProjectFeaturePreset(defaults(), PLAN_PRESETS.find((p) => p.id === 'event-day')!);
        expect(previewPlanSettings({ project, settings: { ...defaults(), ...settings } })).toEqual([
            { label: 'New plan', value: 'Event day: 5 phases, 20 items' },
            { label: 'Claims', value: '3 per agent, 30 min lease' },
            { label: 'Done-when', value: 'people tick' }
        ]);
    });
});

describe('plan instructions', () => {
    it('names every plan tool and the ref syntax', () => {
        const text = planInstructions({ project, settings: defaults() });
        for (const tool of PLAN_TOOLS) expect(text).toContain(`\`${tool}\``);
        for (const ref of ['#9', 'signalx#14', '@lint', 'path/file.ts:38-41', 'pr:604', 'chat:msg-42', 'doc:architecture.md#7']) expect(text).toContain(ref);
    });

    it("carries the project's limits and who ticks", () => {
        const text = planInstructions({ project, settings: { ...defaults(), claimLimit: 2, leaseMinutes: 45, agentsMayTick: false } });
        expect(text).toContain('at most 2 at once');
        expect(text).toContain('lasts 45 minutes');
        expect(text).toContain('Do not tick done-when lines yourself');
    });

    it("appends the project's own instructions", () => {
        const text = planInstructions({ project, settings: { ...defaults(), instructions: '  Ask Ana before booking.  ' } });
        expect(text.endsWith('\n\nAsk Ana before booking.')).toBe(true);
    });

    it('is the plugin instructions hook', () => {
        expect(planFeaturePlugin.instructions?.({ project, settings: defaults() })).toBe(planInstructions({ project, settings: defaults() }));
    });
});
