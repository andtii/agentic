/**
 * Mock data for Settings › Features: the add-a-feature catalogue (#722) — owned by #736, imported only by its own page;
 * nothing shared re-exports it. The ProjectFeatures board's features (Calendar, Plan and Budget on an event project;
 * Guest list, Milestones, Docs, Incidents, Git and Timesheets to add), Git from its real manifest.
 */
import type { ConfigSchema } from '@agentic/core';
import { projectFeatureCatalogue } from '../../plugins/features';
import { GIT_FEATURE_ID } from '@agentic/plugins-git';
import type { FeatureEntry } from '../../pages/projects/settings/features/model';

const NONE: ConfigSchema = { type: 'object', properties: {} };

const entry = (e: Omit<FeatureEntry, 'version' | 'enabled' | 'needs' | 'presets' | 'instructions'> & Partial<FeatureEntry>): FeatureEntry => ({
    version: '0.1.0',
    enabled: true,
    needs: [],
    presets: [],
    instructions: false,
    projectSettings: NONE,
    ...e
});

const git = projectFeatureCatalogue[GIT_FEATURE_ID]!;

export const MOCK_FEATURE_CATALOGUE: readonly FeatureEntry[] = [
    entry({
        id: 'mock.feature.calendar',
        name: 'Calendar',
        description: 'Event dates and holds; agents read free/busy through Google Calendar',
        category: 'events',
        ui: { section: { label: 'Calendar', icon: 'schedules' }, overviewCard: { title: 'Next dates' }, chatRefPrefixes: ['date:'], tools: ['calendar'] },
        instructions: true
    }),
    entry({
        id: 'mock.feature.plan',
        name: 'Plan',
        version: '0.3.0',
        description: 'Shared plan for people and agents: claims, dependencies, refs',
        category: 'planning',
        ui: { section: { label: 'Plan', icon: 'menu', badge: 'open-items' }, overviewCard: { title: 'Plan' }, workStages: ['Ready', 'Do', 'Review', 'Done'], chatRefPrefixes: ['#'], tools: ['plan'] },
        instructions: true,
        projectSettings: {
            type: 'object',
            properties: {
                template: { type: 'string', title: 'Template', enum: ['blank', 'event-day', 'sprint'], default: 'blank' },
                agentsMayTick: { type: 'boolean', title: 'Agents may tick items', description: 'Off: they ask you first', default: false }
            }
        },
        presets: [
            { id: 'event-day', label: 'Event day (20 items)', settings: { template: 'event-day', agentsMayTick: false } },
            { id: 'sprint', label: 'Two-week sprint', settings: { template: 'sprint', agentsMayTick: true } }
        ],
        blurbs: {
            section: 'A Plan page in this project’s sidebar, with open items counted.',
            overviewCard: 'Progress and the next three open items.',
            workStages: 'An item an agent picks up becomes a work item: Ready → Do → Review → Done.',
            chatRefPrefixes: 'Type # in a chat to link an item; agents ask before ticking one.',
            tools: 'Open items join every session’s Project section, and agents get plan_* tools to claim, update and hand off.'
        }
    }),
    entry({
        id: 'mock.feature.budget',
        name: 'Budget',
        description: 'Limits, quotes and spend in SEK',
        category: 'ops',
        ui: { section: { label: 'Budget', icon: 'usage' }, overviewCard: { title: 'Budget' }, chatRefPrefixes: ['quote:'], tools: ['budget'] },
        projectSettings: { type: 'object', properties: { currency: { type: 'string', title: 'Currency', enum: ['SEK', 'EUR', 'USD'], default: 'SEK' }, limit: { type: 'number', title: 'Limit', minimum: 0 } } }
    }),
    entry({ id: 'mock.feature.guests', name: 'Guest list', description: 'Invitees, RSVPs and dietary notes; agents chase replies by email.', category: 'events', ui: { section: { label: 'Guests', icon: 'agents' }, tools: ['guests'] } }),
    entry({ id: 'mock.feature.milestones', name: 'Milestones', description: 'Dates the project works toward; work items group under them.', category: 'planning', ui: { overviewCard: { title: 'Milestones' }, chatRefPrefixes: ['ms:'] } }),
    entry({ id: 'mock.feature.docs', name: 'Docs', description: 'A shared folder of notes agents read before each session.', category: 'knowledge', ui: { section: { label: 'Docs', icon: 'file' } }, instructions: true }),
    entry({ id: 'mock.feature.incidents', name: 'Incidents', description: 'Alerts become work with Triage, Fix and Review stages.', category: 'ops', ui: { section: { label: 'Incidents', icon: 'warning' }, workStages: ['Triage', 'Fix', 'Review'] } }),
    entry({
        id: git.manifest.id,
        name: git.manifest.name,
        version: git.manifest.version,
        description: 'Branch per task, pull requests, checks and merge stages.',
        ui: git.manifest.ui ?? {},
        ...(git.manifest.category ? { category: git.manifest.category } : {}),
        needs: git.manifest.ui?.needs ?? [],
        presets: git.presets ?? [],
        projectSettings: git.manifest.projectSettings,
        instructions: typeof git.instructions === 'function'
    }),
    entry({ id: 'mock.feature.timesheets', name: 'Timesheets', description: 'Hours per person and task, summed weekly.', category: 'ops', ui: { overviewCard: { title: 'Hours this week' } } })
];
