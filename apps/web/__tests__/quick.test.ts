import { describe, expect, it } from 'vitest';
import { canSend, initialAgent, readRemembered, remember, sendsOnKey, QUICK_AGENT_KEY } from '../src/pages/quick/model';
import { desktopHost } from '../src/desktop';

describe('quick ask', () => {
    const agents = [{ id: 'a1' }, { id: 'a2' }];

    it('starts on the agent asked last, while it exists', () => {
        expect(initialAgent(agents, 'a2')).toBe('a2');
        expect(initialAgent(agents, 'gone')).toBe('a1');
        expect(initialAgent(agents, null)).toBe('a1');
        expect(initialAgent([], 'a1')).toBe('');
    });

    it('sends with an agent and some text, once', () => {
        expect(canSend('a1', 'do it', false)).toBe(true);
        expect(canSend('a1', '   ', false)).toBe(false);
        expect(canSend('', 'do it', false)).toBe(false);
        expect(canSend('a1', 'do it', true)).toBe(false);
    });

    it('Enter sends; Shift+Enter and an IME composition do not', () => {
        expect(sendsOnKey({ key: 'Enter', shiftKey: false, isComposing: false })).toBe(true);
        expect(sendsOnKey({ key: 'Enter', shiftKey: true, isComposing: false })).toBe(false);
        expect(sendsOnKey({ key: 'Enter', shiftKey: false, isComposing: true })).toBe(false);
        expect(sendsOnKey({ key: 'a', shiftKey: false, isComposing: false })).toBe(false);
    });

    it('remembers the agent, and survives storage that throws', () => {
        const map = new Map<string, string>();
        const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); } };
        remember(storage, 'a2');
        expect(map.get(QUICK_AGENT_KEY)).toBe('a2');
        expect(readRemembered(storage)).toBe('a2');
        const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
        expect(readRemembered(broken)).toBeNull();
        expect(() => remember(broken, 'a1')).not.toThrow();
        expect(readRemembered(undefined)).toBeNull();
    });

    it('asks the shell to open the chat in the main window, and to hide', async () => {
        const calls: unknown[] = [];
        const host = desktopHost({ __TAURI_INTERNALS__: { invoke: async (...a: unknown[]) => { calls.push(a); } } } as unknown as typeof globalThis)!;
        await host.openMain('/chats/c1');
        await host.hideQuick();
        expect(calls).toEqual([['open_main', { path: '/chats/c1' }], ['hide_quick']]);
    });
});
