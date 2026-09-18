/**
 * `src/host-scope.ts` (#137): the `__SIGX_ACTOR_HOST__` seam as an accessor —
 * a read inside `runWithHost` answers that scope's host, a read outside it
 * answers what `@sigx/actors` last stamped, and a `clearHost` (which deletes
 * the property) does not strand the isolate on the old data property.
 */
import type { Host } from '@sigx/actors';
import { peekHost } from '@sigx/actors';
import { currentScopedHost, installHostScope, runWithHost } from '../src/host-scope';

const SEAM = '__SIGX_ACTOR_HOST__';
const g = globalThis as Record<string, unknown>;
const host = (name: string): Host => ({ name }) as unknown as Host;

afterEach(() => {
    delete g[SEAM];
});

describe('host scope', () => {
    it('keeps what a host stamped before the accessor went in, and what one stamps after', () => {
        g[SEAM] = host('early');
        installHostScope();
        expect(peekHost()).toBe(g[SEAM]);
        expect(currentScopedHost()).toMatchObject({ name: 'early' });
        g[SEAM] = host('later');
        expect(peekHost()).toMatchObject({ name: 'later' });
        expect(Object.getOwnPropertyDescriptor(g, SEAM)?.get).toBeTypeOf('function');
    });

    it('a read inside runWithHost answers the scope, nested scopes shadow, and the fallback is the stamped host', async () => {
        g[SEAM] = host('stamped');
        const a = host('a');
        const b = host('b');
        await runWithHost(a, async () => {
            expect(peekHost()).toBe(a);
            await Promise.resolve();
            expect(peekHost()).toBe(a);
            await runWithHost(b, async () => {
                await Promise.resolve();
                expect(peekHost()).toBe(b);
            });
            expect(peekHost()).toBe(a);
            // A background continuation started inside the scope keeps it.
            await new Promise<void>((resolve) => setTimeout(() => (expect(peekHost()).toBe(a), resolve()), 0));
        });
        expect(peekHost()).toMatchObject({ name: 'stamped' });
    });

    it('a thunk store resolves at read time — the Worker enters its scope before its host has booted', async () => {
        let booted: Host | undefined;
        await runWithHost(
            () => booted,
            async () => {
                expect(peekHost()).toBeUndefined();
                booted = host('worker');
                expect(peekHost()).toBe(booted);
            }
        );
    });

    it('re-installs after a clearHost deleted the property, and forgets the cleared host', () => {
        installHostScope();
        g[SEAM] = host('stamped');
        delete g[SEAM]; // what `host.stop()` does
        expect(Object.getOwnPropertyDescriptor(g, SEAM)).toBeUndefined();
        runWithHost(host('scoped'), () => {
            expect(peekHost()).toMatchObject({ name: 'scoped' });
        });
        expect(peekHost()).toBeUndefined();
    });
});
