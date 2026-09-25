/**
 * Settings › Project manager (#760, PRJ-14) on mock data: the project's own manager (name, runtime note,
 * personality with its opening lines, skills) and Change — only what changed, never another agent; who can send
 * requests, the loop, the autonomy switches and the tools; Save policy sends `pmPolicy` through `upsertProject`
 * (`mockSettingsSaves`). Plus the pure model: reading the personality back from the instructions, the patch and the
 * policy round trip. #760 owns this file.
 */
import { describe, it, expect } from 'vitest';
import { PM_PERSONALITIES, PM_POLICY_DEFAULT, type PmPolicy, type ProjectId } from '@agentic/core';
import { mockSettingsSaves } from '../../src/mock/projects/settings';
import { PERSONALITY_SAMPLES } from '../../src/pages/projects/new/model';
import {
    addSenderProject,
    managerDraftOf,
    managerPatchOf,
    openingLines,
    runtimeNote,
    personalityOfInstructions,
    policyDraftOf,
    policyOf,
    removeSenderProject,
    validatePolicyDraft,
    whoLabel,
    type PmAgent
} from '../../src/pages/projects/settings/manager/model';
import { mockManagerSaves, pmAgentOf } from '../../src/pages/projects/settings/manager/sources';
import { setText, text } from '../pages/helpers';
import { mountRoute } from '../pages/mount';

const settle = async (): Promise<void> => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)); };
const buttonIn = (root: ParentNode, label: string): HTMLButtonElement => {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label && !x.disabled);
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};
const switchOf = (root: ParentNode, name: string): HTMLInputElement => root.querySelector<HTMLInputElement>(`input[role="switch"][name="${name}"]`)!;
const flip = async (el: HTMLInputElement): Promise<void> => {
    el.click();
    await settle();
};

const NOVA: PmAgent = { id: 'a_pm', name: 'Nova', runtime: 'anthropic-api', personality: { preset: 'calm-organiser' }, skills: ['planning'] };
const PLAYBOOK = 'You are the project manager of this project. Your job:\n- Own the Plan.';

describe('Settings › Project manager (mock)', () => {
    it('shows the project\'s own manager with its runtime note, personality, opening lines and skills; Change edits only it', async () => {
        mockManagerSaves.length = 0;
        const dom = await mountRoute('/projects/p_agentic/settings/manager');
        const tab = dom.querySelector<HTMLElement>('[data-settings-tab="manager"]')!;
        const card = tab.querySelector<HTMLElement>('[data-pm-card="agent"]')!;
        // The mock project's coordinator stands in for its manager.
        expect(card.querySelector('[data-pm-agent]')!.getAttribute('data-pm-agent')).toBe('atlas');
        expect(text(card.querySelector('[data-pm-name]'))).toBe('Atlas');
        expect(text(card.querySelector('[data-pm-runtime]'))).toContain('answers with every machine off');
        expect(text(card.querySelector('[data-pm-personality-now]'))).toBe('Calm organiser');
        expect(text(card.querySelector('[data-pm-opening]'))).toBe(PERSONALITY_SAMPLES['calm-organiser']);
        expect([...card.querySelectorAll('[data-pm-skill]')].map((s) => s.getAttribute('data-pm-skill'))).toEqual(['planning', 'triage']);

        buttonIn(card, 'Change').click();
        await settle();
        expect(card.querySelector<HTMLInputElement>('input[name="pm-name"]')!.value).toBe('Atlas');
        // Saving with nothing changed writes nothing.
        buttonIn(card, 'Save manager').click();
        await settle();
        expect(mockManagerSaves).toEqual([]);

        buttonIn(card, 'Change').click();
        await settle();
        setText(card.querySelector<HTMLInputElement>('input[name="pm-name"]')!, ' Nova ');
        card.querySelector<HTMLElement>('[data-pm-personality="direct-driver"]')!.click();
        await settle();
        expect(text(card.querySelector('[data-pm-preview]'))).toContain(PERSONALITY_SAMPLES['direct-driver']!);
        buttonIn(card, 'Save manager').click();
        await settle();
        expect(mockManagerSaves).toEqual([{ projectId: 'p_agentic', patch: { name: 'Nova', personality: { preset: 'direct-driver' } } }]);
        expect(text(card.querySelector('[data-pm-name]'))).toBe('Nova');
        expect(card.querySelector('[data-pm-agent]')!.getAttribute('data-pm-agent')).toBe('atlas');
        expect(text(tab.querySelector('[data-pm-card="autonomy"] h3'))).toBe('What Nova may do without asking');

        // A custom personality needs its text.
        buttonIn(card, 'Change').click();
        await settle();
        card.querySelector<HTMLElement>('[data-pm-personality="custom"]')!.click();
        await settle();
        buttonIn(card, 'Save manager').click();
        await settle();
        expect(mockManagerSaves.length).toBe(1);
        expect(text(card)).toContain('Describe how the project manager works');
    });

    it('who can send, the loop, the autonomy switches and the tools; Save policy sends pmPolicy via upsertProject', async () => {
        mockSettingsSaves.length = 0;
        const dom = await mountRoute('/projects/p_agentic/settings/manager');
        const tab = dom.querySelector<HTMLElement>('[data-settings-tab="manager"]')!;
        // The default policy: any other project asks first.
        expect([...tab.querySelectorAll('[data-pm-sender]')].map((r) => r.getAttribute('data-pm-sender'))).toEqual(['*']);
        expect(text(tab.querySelector('[data-pm-sender="*"] [data-pm-sender-mode]'))).toBe('ask me first');
        expect([...tab.querySelectorAll('[data-pm-autonomy-row]')].map((r) => r.getAttribute('data-pm-autonomy-row'))).toEqual(['addItems', 'assign', 'priority', 'declineDuplicates', 'openIssues', 'sendRequests']);
        expect([...tab.querySelectorAll('[data-pm-tool]')].map((r) => r.getAttribute('data-pm-tool'))).toEqual(['requests_list', 'requests_triage', 'requests_resolve', 'projects_request', 'plan_add / plan_assign']);
        expect(switchOf(tab, 'pm-autonomy-addItems').checked).toBe(true);
        expect(switchOf(tab, 'pm-autonomy-openIssues').checked).toBe(false);

        await flip(switchOf(tab, 'pm-sender-other'));
        expect(text(tab.querySelector('[data-pm-sender="*"] [data-pm-sender-mode]'))).toBe('allowed');
        await flip(switchOf(tab, 'pm-autonomy-openIssues'));
        await flip(switchOf(tab, 'pm-autonomy-priority'));
        await flip(switchOf(tab, 'pm-notify-merge'));
        await flip(switchOf(tab, 'pm-weekly'));
        expect(tab.querySelector<HTMLInputElement>('input[name="pm-weekly-time"]')!.value).toBe('08:45');
        buttonIn(tab, 'Save policy').click();
        await settle();
        expect(mockSettingsSaves).toEqual([{
            id: 'p_agentic',
            pmPolicy: {
                senders: [{ project: '*', who: 'any-member', mode: 'allowed' }],
                autonomy: { addItems: true, assign: true, priorityUpTo: null, declineDuplicates: true, openIssues: true, sendRequests: false },
                weeklySummary: { day: 1, time: '08:45' },
                notifyOnMerge: false
            }
        }]);
        expect(text(tab.querySelector(':scope > [data-project-actions] [data-project-saved]'))).toBe('Saved.');

        // A bad time keeps the save back.
        setText(tab.querySelector<HTMLInputElement>('input[name="pm-weekly-time"]')!, '25:00');
        await settle();
        buttonIn(tab, 'Save policy').click();
        await settle();
        expect(mockSettingsSaves.length).toBe(1);
        expect(text(tab)).toContain('HH:MM');
    });
});

describe('Project manager model', () => {
    it('reads the personality back from the instructions: a preset by its text, else custom', () => {
        const preset = PM_PERSONALITIES[1]!;
        expect(personalityOfInstructions(`${PLAYBOOK}\n\n## Personality\n\n${preset.instructions}`)).toEqual({ preset: preset.id });
        expect(personalityOfInstructions(`${PLAYBOOK}\n\n## Personality\n\nShort and blunt.`)).toEqual({ custom: 'Short and blunt.' });
        expect(personalityOfInstructions(PLAYBOOK)).toBeUndefined();
        expect(personalityOfInstructions(undefined)).toBeUndefined();
        const agent = pmAgentOf({ id: 'a_pm' as never, config: { name: 'Nova', instructions: `${PLAYBOOK}\n\n## Personality\n\n${preset.instructions}`, skills: [{ id: 'triage' }], execution: { runtime: 'anthropic-api' } } as never });
        expect(agent).toEqual({ id: 'a_pm', name: 'Nova', runtime: 'anthropic-api', personality: { preset: preset.id }, skills: ['triage'] });
    });

    it('the manager patch names only what changed', () => {
        const d = managerDraftOf(NOVA);
        expect(managerPatchOf(d, NOVA)).toBeNull();
        expect(managerPatchOf({ ...d, skills: ['planning', ' triage ', 'planning'] }, NOVA)).toEqual({ skills: [{ id: 'planning' }, { id: 'triage' }] });
        expect(managerPatchOf({ ...d, personality: 'custom', custom: '  Blunt. ' }, NOVA)).toEqual({ personality: { custom: 'Blunt.' } });
        // An emptied name is not sent (the form refuses it).
        expect(managerPatchOf({ ...d, name: '  ' }, NOVA)).toBeNull();
        expect(openingLines({ custom: 'First. Second! Third?' })).toBe('First. Second!');
        expect(runtimeNote('—')).toBe('runtime unknown');
        expect(runtimeNote('claude-code')).toContain('runs on a machine');
    });

    it('the policy round trip: sender rules in order, the * rule last, a low cap kept, the weekly summary only when on', () => {
        const policy: PmPolicy = {
            senders: [{ project: '*', who: 'any-member', mode: 'ask' }, { project: 'p_a' as ProjectId, who: [{ kind: 'agent', agentId: 'forge' as never }, { kind: 'user', userId: 'u1' as never }], mode: 'allowed' }],
            autonomy: { ...PM_POLICY_DEFAULT.autonomy, priorityUpTo: 'low' },
            weeklySummary: { day: 5, time: '17:00' },
            notifyOnMerge: true
        };
        const d = policyDraftOf(policy);
        expect(policyOf(d)).toEqual({ ...policy, senders: [policy.senders[1], policy.senders[0]] });
        addSenderProject(d, 'p_b');
        addSenderProject(d, 'p_b');
        expect(policyOf(d).senders.map((r) => `${r.project}:${r.mode}`)).toEqual(['p_a:allowed', 'p_b:allowed', '*:ask']);
        removeSenderProject(d, 'p_a');
        removeSenderProject(d, '*');
        d.weekly = false;
        expect(policyOf(d)).toEqual({ senders: [{ project: 'p_b', who: 'any-member', mode: 'allowed' }, { project: '*', who: 'any-member', mode: 'ask' }], autonomy: policy.autonomy, notifyOnMerge: true });
        expect(validatePolicyDraft({ ...d, weekly: true, time: '7:00' })).not.toBe('');
        expect(whoLabel(policy.senders[1]!.who, (id) => (id === 'forge' ? 'Forge' : id))).toBe('Forge and you');
        expect(whoLabel('any-member', String)).toBe('any member');
    });
});
