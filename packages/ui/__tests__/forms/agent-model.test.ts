import { AGENT_FIELDS as F, CUSTOM_MODEL, agentDraftFromFormData, decodeSkill, modelChoice, defaultAgentConfig, encodeSkill, fromAgentDraft, parseAgentFormData, toAgentDraft, validateAgentDraft } from '@agentic/ui';
import { fullAgentConfig } from './helpers';

describe('AgentConfig ⇄ draft', () => {
    it('round-trips a canonical config through the draft', () => {
        const config = fullAgentConfig();
        expect(fromAgentDraft(toAgentDraft(config))).toEqual(config);
    });

    it('maps execution.onInterrupt (#368): absent reads ask, and only auto is written back', () => {
        const blank = defaultAgentConfig();
        expect(toAgentDraft(blank).onInterrupt).toBe('ask');
        const auto = { ...blank, execution: { ...blank.execution, onInterrupt: 'auto' as const } };
        expect(toAgentDraft(auto).onInterrupt).toBe('auto');
        expect(fromAgentDraft(toAgentDraft(auto)).execution.onInterrupt).toBe('auto');
        expect(fromAgentDraft({ ...toAgentDraft(auto), onInterrupt: 'ask' }).execution).not.toHaveProperty('onInterrupt');
    });

    it('round-trips the blank default', () => {
        expect(fromAgentDraft(toAgentDraft(defaultAgentConfig()))).toEqual(defaultAgentConfig());
    });

    it('splits approval rules into the category editor and the pass-through list', () => {
        const draft = toAgentDraft(fullAgentConfig());
        expect(draft.approvals).toEqual({ read: '', write: 'ask', execute: '', network: '', destructive: 'deny' });
        expect(draft.approvalExtra.map((r) => r.id)).toEqual(['rule-x']);
    });

    it('keeps a scoped or tool-matching category rule out of the editor', () => {
        const draft = toAgentDraft({
            ...defaultAgentConfig(),
            approvalPolicy: [
                { id: 'category:read', match: { categories: ['read'] }, outcome: 'ask', scope: 'once' },
                { id: 'other', match: { categories: ['read'] }, outcome: 'ask' }
            ]
        });
        expect(draft.approvals.read).toBe('');
        expect(draft.approvalExtra).toHaveLength(2);
    });

    it('encodes skills as id@version and keeps a scoped id intact', () => {
        expect(encodeSkill({ id: '@acme/security', version: '2.1' })).toBe('@acme/security@2.1');
        expect(decodeSkill('@acme/security@2.1')).toEqual({ id: '@acme/security', version: '2.1' });
        expect(decodeSkill('@acme/security')).toEqual({ id: '@acme/security' });
        expect(decodeSkill('review')).toEqual({ id: 'review' });
    });

    it('validates name, runtime and limits', () => {
        const ok = toAgentDraft(fullAgentConfig());
        expect(validateAgentDraft(ok)).toEqual({});
        expect(validateAgentDraft({ ...ok, name: '  ' }).name).toMatch(/required/);
        expect(validateAgentDraft({ ...ok, name: 'x'.repeat(81) }).name).toMatch(/at most 80/);
        expect(validateAgentDraft({ ...ok, runtime: '' }).runtime).toBeTruthy();
        expect(validateAgentDraft({ ...ok, limits: { ...ok.limits, maxTurns: 0 } })['limit:maxTurns']).toMatch(/at least 1/);
        expect(validateAgentDraft({ ...ok, limits: { ...ok.limits, maxTurns: 1.5 } })['limit:maxTurns']).toMatch(/whole number/);
        expect(validateAgentDraft({ ...ok, limits: { ...ok.limits, maxCostUsd: -1 } })['limit:maxCostUsd']).toMatch(/negative/);
        expect(validateAgentDraft({ ...ok, limits: { ...ok.limits, maxCostUsd: 0 } })).toEqual({});
    });
});

describe('agentDraftFromFormData', () => {
    function post(config = fullAgentConfig()): FormData {
        const fd = new FormData();
        const d = toAgentDraft(config);
        fd.set(F.name, d.name);
        fd.set(F.description, d.description);
        fd.set(F.role, d.role);
        fd.set(F.instructions, d.instructions);
        for (const s of d.skills) fd.append(F.skills, s);
        for (const t of d.tools) {
            fd.append(F.tools, t);
            fd.set(F.toolMode(t), d.toolModes[t]!);
        }
        for (const c of d.connectors) fd.append(F.connectors, c);
        for (const [cat, outcome] of Object.entries(d.approvals)) if (outcome) fd.set(F.approval(cat as never), outcome);
        if (d.approvalExtra.length) fd.set(F.approvalExtra, JSON.stringify(d.approvalExtra));
        for (const s of d.memoryShared) fd.append(F.memoryShared, s);
        if (d.autoLearn) fd.set(F.autoLearn, 'on');
        fd.set(F.runtime, d.runtime);
        fd.set(F.environment, d.defaultEnvironmentId);
        fd.set(F.model, d.model);
        fd.set(F.offlinePolicy, d.offlinePolicy);
        fd.set(F.onInterrupt, d.onInterrupt);
        for (const [k, v] of Object.entries(d.limits)) if (v !== null) fd.set(F.limit(k as never), String(v));
        if (d.collaborateAll) fd.set(F.collaborateAll, 'on');
        for (const a of d.collaborators) fd.append(F.collaborators, a);
        fd.set(F.reason, 'tightened limits');
        return fd;
    }

    it('reads the same config the live binding would write', () => {
        const { config, reason, errors } = parseAgentFormData(post());
        expect(config).toEqual(fullAgentConfig());
        expect(reason).toBe('tightened limits');
        expect(errors).toEqual({});
    });

    it('is strict about enums, numbers and malformed JSON', () => {
        const fd = post();
        fd.set(F.approval('write'), 'maybe');
        fd.set(F.toolMode('Bash'), 'sometimes');
        fd.set(F.limit('maxTurns'), 'lots');
        fd.set(F.offlinePolicy, 'shrug');
        fd.set(F.approvalExtra, '{not json');
        const d = agentDraftFromFormData(fd);
        expect(d.approvals.write).toBe('');
        expect(d.toolModes.Bash).toBe('allow');
        expect(d.limits.maxTurns).toBeNull();
        expect(d.offlinePolicy).toBe('queue');
        expect(d.approvalExtra).toEqual([]);
    });

    it('reads onInterrupt: auto when posted, ask for anything else (#368)', () => {
        const fd = post();
        fd.set(F.onInterrupt, 'auto');
        expect(parseAgentFormData(fd).config.execution.onInterrupt).toBe('auto');
        fd.set(F.onInterrupt, 'sometimes');
        expect(agentDraftFromFormData(fd).onInterrupt).toBe('ask');
        expect(parseAgentFormData(fd).config.execution.onInterrupt).toBeUndefined();
    });

    it('reports errors on a bad post instead of throwing', () => {
        const fd = post();
        fd.set(F.name, '');
        expect(parseAgentFormData(fd).errors.name).toBeTruthy();
    });
});

describe('the model select (#234)', () => {
    const models = ['claude-opus-5', 'claude-sonnet-5'];

    it('modelChoice: blank is the runtime default, a listed id itself, anything else custom', () => {
        expect(modelChoice('', models)).toBe('');
        expect(modelChoice('claude-sonnet-5', models)).toBe('claude-sonnet-5');
        expect(modelChoice('claude-opus-4', models)).toBe(CUSTOM_MODEL);
        expect(modelChoice('claude-opus-5', [])).toBe(CUSTOM_MODEL);
    });

    it('a post that chose Custom… carries the typed id; any other choice is the model itself', () => {
        const fd = new FormData();
        fd.set(F.name, 'A');
        fd.set(F.runtime, 'anthropic-api');
        fd.set(F.model, CUSTOM_MODEL);
        fd.set(F.modelCustom, '  claude-opus-4  ');
        expect(agentDraftFromFormData(fd).model).toBe('claude-opus-4');
        fd.set(F.model, 'claude-sonnet-5');
        expect(agentDraftFromFormData(fd).model).toBe('claude-sonnet-5');
        fd.set(F.model, '');
        expect(fromAgentDraft(agentDraftFromFormData(fd)).execution).not.toHaveProperty('model');
    });
});
