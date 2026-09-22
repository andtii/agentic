/**
 * Elevation on the Machine page (#355): a Machine whose `revoke` asks for it
 * the way #480 will — 403 `elevation-required: …` for a plain owner — makes
 * the page open "Confirm with GitHub to continue" instead of failing; Continue
 * keeps the change in `sessionStorage` and goes to `/auth/elevate`; back on the
 * page the dialog reopens in its resume shape and ONE click sends it — nothing
 * runs on its own. Plus the pure half: recognising the refusal, the pending
 * store's ten-minute age, the URL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ELEVATION_REQUIRED, ELEVATION_TTL_MS, isElevated } from '@agentic/core';
import { defineActor } from '@sigx/actors';
import { ServerFnError } from '@sigx/server';
import { Workspace, defineMachineActor, machineKey, workspaceKey } from '@agentic/platform';
import { machineHead } from '../../src/pages/machines/head';
import { describePending, elevateUrl, isElevationRequired, pendingKey, savePending, takePending, type PendingStore } from '../../src/pages/machines/elevate';
import { WS, mountLive, owner, startLive, tick, until, type LiveHarness } from './live-harness';

/** The real Machine, with `revoke` gated on elevation (what #480 adds for good). */
const Base = defineMachineActor({ socket: { send: () => true, close: () => undefined } });
const Machine = defineActor({
    ...Base.__sigxActor,
    methods: (ctx) => {
        const m = Base.__sigxActor.methods(ctx) as Record<string, (...args: unknown[]) => unknown>;
        return {
            ...m,
            async revoke() {
                if (!isElevated(ctx.principal as never)) throw new ServerFnError(403, `${ELEVATION_REQUIRED}: confirm with your login provider to revoke this machine`);
                return m.revoke!();
            }
        };
    }
}) as unknown as typeof Base;

let h: LiveHarness;
beforeEach(() => {
    sessionStorage.clear();
});
afterEach(async () => {
    machineHead.value = null;
    sessionStorage.clear();
    await h.stop();
});

async function pairMachine(name: string) {
    const ws = h.app.as(owner).actor(Workspace, workspaceKey(WS));
    const { machineId, pairingCode } = await ws.registerMachinePending({ name });
    const daemon = h.app.as({ kind: 'machine', workspaceId: WS, machineId }).actor(Machine, machineKey(WS, machineId));
    await daemon.pair(pairingCode, { name, os: 'windows', daemonVersion: '0.1.0-test' });
    return { machineId, user: h.app.as(owner).actor(Machine, machineKey(WS, machineId)) };
}

const popup = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-scope="dialog"][data-part="popup"][data-state="open"]');
const button = (root: ParentNode, label: string): HTMLButtonElement => {
    const b = [...root.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label && (root instanceof HTMLElement && root.matches('[data-part="popup"]') ? true : !x.closest('[data-part="popup"]')));
    if (!b) throw new Error(`no button "${label}"`);
    return b;
};

describe('/machines/:id — confirm with GitHub before revoking (#355)', () => {
    it('a refused revoke opens the dialog; Continue keeps the change and leaves for /auth/elevate; nothing was revoked', { timeout: 15_000 }, async () => {
        h = await startLive(undefined, { actors: [Machine] });
        const m = await pairMachine('alien01');
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-machine-hero]') !== null, 'the page');
        button(dom, 'Revoke alien01').click();
        await tick();
        // The page's own revoke confirm first, then the platform's refusal turns into the elevate dialog.
        expect(popup()?.textContent).toContain('Revoke alien01?');
        button(popup()!, 'Revoke alien01').click();
        await until(() => popup()?.textContent?.includes('Confirm with GitHub to continue') === true, 'the elevate dialog');
        expect(popup()!.textContent).toContain('To revoke alien01, sign in with GitHub once more');
        expect((await m.user.get()).revoked).toBe(false);
        expect(dom.querySelector('[data-machine-error]')).toBeNull();

        // Continue: the change waits in sessionStorage for the way back.
        button(popup()!, 'Continue to GitHub').click();
        await tick();
        const kept = JSON.parse(sessionStorage.getItem(pendingKey(m.machineId))!) as { kind: string; at: number };
        expect(kept.kind).toBe('revoke');
        expect((await m.user.get()).revoked).toBe(false);
    });

    it('back from GitHub: the dialog reopens in its resume shape and one Confirm sends the change', { timeout: 15_000 }, async () => {
        // The tab is elevated on the way back, as the cookie would make it.
        h = await startLive(undefined, { actors: [Machine], elevated: true });
        const m = await pairMachine('alien02');
        savePending(sessionStorage, m.machineId, { kind: 'revoke' });
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => popup()?.textContent?.includes('Confirmed — apply the change?') === true, 'the resume dialog');
        expect(popup()!.textContent).toContain('Confirm to revoke alien02 now');
        expect(sessionStorage.getItem(pendingKey(m.machineId))).toBeNull();
        expect((await m.user.get()).revoked).toBe(false);
        button(popup()!, 'Confirm').click();
        await until(async () => (await m.user.get()).revoked, 'revoked after the click');
        await until(() => dom.textContent?.includes('REVOKED') === true, 'the page says so');
    });

    it('a stale or cancelled pending change never runs', { timeout: 15_000 }, async () => {
        h = await startLive(undefined, { actors: [Machine], elevated: true });
        const m = await pairMachine('alien03');
        savePending(sessionStorage, m.machineId, { kind: 'revoke' }, Date.now() - ELEVATION_TTL_MS - 1);
        const dom = await mountLive(`/machines/${m.machineId}`, h);
        await until(() => dom.querySelector('[data-machine-hero]') !== null, 'the page');
        await tick(20);
        expect(popup()).toBeNull();
        expect((await m.user.get()).revoked).toBe(false);
    });
});

describe('the elevate model', () => {
    it('recognises the platform’s refusal and nothing else', () => {
        expect(isElevationRequired(new ServerFnError(403, `${ELEVATION_REQUIRED}: confirm with your login provider to change this machine`))).toBe(true);
        expect(isElevationRequired(new ServerFnError(403, 'machine: only the owner'))).toBe(false);
        expect(isElevationRequired(new ServerFnError(401, `${ELEVATION_REQUIRED}: x`))).toBe(false);
        expect(isElevationRequired(new Error(ELEVATION_REQUIRED))).toBe(false);
        expect(isElevationRequired(null)).toBe(false);
    });

    it('keeps a pending change per machine for as long as an elevation lasts, and hands it back once', () => {
        const map = new Map<string, string>();
        const store: PendingStore = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
        const at = 1_800_000_000_000;
        savePending(store, 'm1', { kind: 'policy', draft: { roots: ['~'] } }, at);
        savePending(store, 'm2', { kind: 'remove' }, at);
        expect(takePending(store, 'm1', at + 1000)).toEqual({ kind: 'policy', draft: { roots: ['~'] }, at });
        expect(takePending(store, 'm1', at + 1000)).toBeNull();
        expect(takePending(store, 'm2', at + ELEVATION_TTL_MS + 1)).toBeNull();
        expect(takePending(null, 'm2')).toBeNull();
        map.set(pendingKey('m3'), '{nope');
        expect(takePending(store, 'm3')).toBeNull();
        map.set(pendingKey('m4'), JSON.stringify({ kind: 'revoke' }));
        expect(takePending(store, 'm4')).toBeNull();
        const throwing: PendingStore = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => undefined };
        expect(() => savePending(throwing, 'm5', { kind: 'revoke' })).not.toThrow();
        expect(takePending(throwing, 'm5')).toBeNull();
    });

    it('builds the way back and the words per kind', () => {
        expect(elevateUrl('/machines/m1#folders')).toBe('/auth/elevate?returnTo=%2Fmachines%2Fm1%23folders');
        expect(describePending('revoke', 'box').what).toBe('revoke box');
        expect(describePending('remove', 'box').what).toBe('remove box from this workspace');
        expect(describePending('policy', 'box').what).toBe('change the folders the web may use on box');
        expect(describePending('environment', 'box').what).toBe('change an environment on box');
        expect(describePending('policy', 'box').confirmLabel).toBe('Continue to GitHub');
    });
});
