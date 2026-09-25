/**
 * The live Requests inbox (#883): entries carry the origin chat's title and the triage time from the store, an
 * accepted request shows the open-issue choice it was accepted with, and Edit first sends that choice on resolve.
 */
import { describe, expect, it } from 'vitest';
import type { AgentId, ProjectId, Triage } from '@agentic/core';
import type { RequestView } from '@agentic/platform';
import { acceptResolution, liveEntries } from '../../src/pages/projects/requests/live';

const triage: Triage = { kind: 'bug', priority: 'normal', similar: [], proposedItem: { title: 'x', doneWhen: [] }, openIssue: false, reply: 'ok', why: '' };
const view = (over: Partial<RequestView>): RequestView => ({
    id: 'req_1', fromProject: 'p_a' as ProjectId, toProject: 'p_b' as ProjectId, sender: { kind: 'agent', agentId: 'forge' as AgentId },
    title: 't', body: 'b', refs: [], state: 'triaging', createdAt: 1, updatedAt: 1, ...over
});

describe('the live Requests inbox: origin chat, triage time, open issue (#883)', () => {
    it('carries fromChatTitle and triagedAt onto the entry', () => {
        const [withBoth, bare] = liveEntries({ incoming: [view({ fromChatTitle: 'Batch bug hunt', triagedAt: 42, triage }), view({ id: 'req_2' })], sent: [], linked: [] }, (id) => id, 'Nova');
        expect(withBoth).toMatchObject({ fromChatTitle: 'Batch bug hunt', triagedAt: 42 });
        expect(bare!.fromChatTitle).toBeUndefined();
        expect(bare!.triagedAt).toBeUndefined();
    });

    it('shows the open-issue choice an accepted request was accepted with', () => {
        const [e] = liveEntries({ incoming: [view({ state: 'accepted', triage, openIssue: true })], sent: [], linked: [] }, (id) => id, 'Nova');
        expect(e!.request.triage?.openIssue).toBe(true);
    });

    it('sends the open-issue choice with an edited accept', () => {
        const item = { title: 'y', doneWhen: [] };
        expect(acceptResolution({ item, openIssue: true })).toEqual({ action: 'accept', item, openIssue: true });
    });
});
