/**
 * The live session view without literals (#154): opened-at from what the
 * platform recorded, the working dir from the machine's environment, no tool
 * duration (agent events carry no timestamps) and no Revoke on a grant
 * (session grants are listed, never revocable).
 */
import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@sigx/ai-agent';
import type { MachineView, SessionInfo } from '@agentic/platform';
import { loadSession } from '../../src/mock/workspace';
import { SessionView } from '../../src/pages/Session';
import { liveSessionView } from '../../src/pages/session/live';
import { zoneFormat } from '../../src/time';
import type { AgentIdentity } from '../../src/pages/chat/live';
import { mountAt, text } from './helpers';

const OPENED = Date.UTC(2026, 8, 16, 23, 30);
const forge: AgentIdentity = { id: 'a_forge', name: 'Forge', role: 'Builder', hue: 2, environment: { machine: 'alien01', runtime: 'claude-code', account: 'work' }, configVersion: 3 };

const stamp = (seq: number) => ({ sessionId: 's_live', epoch: 1, seq, turnId: 't1' });
/** A turn that granted `Bash` for the session and is now inside a second call. */
const EVENTS = [
    { ...stamp(1), type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'pnpm test' }, category: 'execute' },
    { ...stamp(2), type: 'request', requestId: 'r1', kind: 'permission', callId: 'c1', toolName: 'Bash', permissionKey: 'Bash:pnpm test *' },
    { ...stamp(3), type: 'request-resolved', requestId: 'r1', outcome: 'allow', scope: 'session', by: 'client', at: OPENED + 1_000 },
    { ...stamp(4), type: 'tool-update', callId: 'c1', status: 'completed', output: 'ok' },
    { ...stamp(5), type: 'tool-call', callId: 'c2', name: 'Bash', input: { command: 'pnpm build' }, category: 'execute' }
] as unknown as AgentEvent[];

const info = (spec: Record<string, unknown>): SessionInfo => ({
    key: 'u:session:s_live',
    opened: true,
    status: 'running',
    head: { epoch: 1, seq: 5 },
    openRequests: [],
    eventCount: EVENTS.length,
    corrections: [],
    grants: [],
    spec: { agentId: 'a_forge', runtime: 'claude-code', config: { configVersion: 3, execution: { runtime: 'claude-code' } }, ...spec }
}) as unknown as SessionInfo;

const machine = { id: 'm1', name: 'alien01', os: 'Windows 11', online: true, environments: [{ id: 'env_work', cwdRoots: ['C:\\Dev\\agentic', 'D:\\scratch'], account: { label: 'work', authStatus: 'ok' } }] } as unknown as MachineView;

describe('liveSessionView', () => {
    it('opened-at is when the platform opened the session (`spec.retrieval.at`); absent, the header falls back to "Opened from"', () => {
        expect(liveSessionView('s_live', info({ retrieval: { text: '', scopes: [], skipped: [], at: OPENED } }), [], forge).openedAt).toBe(OPENED);
        expect(liveSessionView('s_live', info({}), [], forge).openedAt).toBe(0);
    });

    it('the working dir is the folder the router opened the session in (#193); a platform session has none', () => {
        expect(liveSessionView('s_live', info({ machineId: 'm1', environmentId: 'env_work', cwd: 'D:/scratch/branches/47-drawer' }), [], forge, machine).cwd).toBe('D:/scratch/branches/47-drawer');
        // A record opened before #190 carries no cwd: it ran in the first root.
        const daemon = liveSessionView('s_live', info({ machineId: 'm1', environmentId: 'env_work' }), [], forge, machine);
        expect(daemon.cwd).toBe('C:\\Dev\\agentic');
        expect(liveSessionView('s_live', info({ machineId: 'm1', environmentId: 'env_other' }), [], forge, machine).cwd).toBe('');
        expect(liveSessionView('s_live', info({}), [], forge).cwd).toBe('');
    });

    it('carries no tool duration: agent events have no timestamps', () => {
        const v = liveSessionView('s_live', info({}), EVENTS, forge);
        expect(v.current).toBeDefined();
        expect(v.current?.meta).toBeUndefined();
        expect(v.grants.map((g) => g.key)).toEqual(['Bash:pnpm test *']);
    });
});

describe('the session page over a live view', () => {
    it('prints the open time in the workspace zone, the working dir, no tool duration and no Revoke', async () => {
        const v = liveSessionView('s_live', info({ machineId: 'm1', environmentId: 'env_work', retrieval: { text: '', scopes: [], skipped: [], at: OPENED } }), EVENTS, forge, machine);
        const dom = await mountAt('/sessions/s_live', <SessionView v={v} agent={forge} time={zoneFormat('Europe/Stockholm').time} />);
        expect(text(dom.querySelector('[data-session-sub]'))).toBe('Opened 01:30 from the platform');
        expect(text(dom.querySelector('[data-session-rail]'))).toContain('Working dirC:\\Dev\\agentic');
        expect(dom.querySelector('[data-scope="ai-tool-call"][data-part="root"]')).not.toBeNull();
        expect(dom.textContent).not.toContain('3.4s');
        expect(dom.querySelectorAll('[data-grant]')).toHaveLength(1);
        expect(dom.querySelectorAll('[data-grant] button')).toHaveLength(0);
        expect(text(dom.querySelector('[data-grants-note]'))).toBe('Grants end with the session.');
    });

    it('omits the working dir row for a platform session', async () => {
        const dom = await mountAt('/sessions/s_live', <SessionView v={liveSessionView('s_live', info({}), [], forge)} agent={forge} />);
        expect(text(dom.querySelector('[data-session-rail]'))).not.toContain('Working dir');
        expect(text(dom.querySelector('[data-session-sub]'))).toBe('Opened from the platform');
    });

    it('draws Revoke only for a caller that can revoke', async () => {
        const revoked: string[] = [];
        const dom = await mountAt('/sessions/s1', <SessionView v={loadSession('s1')!} agent={forge} onRevoke={(key: string) => { revoked.push(key); }} />);
        const buttons = [...dom.querySelectorAll<HTMLButtonElement>('[data-grant] button')];
        expect(buttons).toHaveLength(2);
        buttons[0]!.click();
        expect(revoked).toHaveLength(1);
    });
});
