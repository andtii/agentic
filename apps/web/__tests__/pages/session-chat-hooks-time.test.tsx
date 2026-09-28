/**
 * "Edited by … at HH:MM" on a live session (#580): the platform stamps each event with when it received it, and the
 * Changes header prints the writing call's time in the workspace's zone. An event logged before events carried a
 * time shows the tool alone.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { defineApp, type JSXElement } from 'sigx';
import '@sigx/runtime-dom';
import { createServerRouter } from '../../src/router';
import { liveEditedBy } from '../../src/pages/session/chat-hooks';
import { zoneFormat } from '../../src/time';
import { tick } from './mount';

const closers: (() => void)[] = [];
afterEach(() => {
    for (const close of closers.splice(0).reverse()) close();
});

async function mount(el: JSXElement): Promise<HTMLDivElement> {
    const router = createServerRouter('/sessions/s1/changes');
    await router.isReady();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const app = defineApp(el);
    app.use(router);
    app.mount(container);
    await tick();
    closers.push(() => {
        app.unmount();
        container.remove();
    });
    return container;
}

/** 2026-09-28 12:34:56 UTC. */
const AT = Date.UTC(2026, 8, 28, 12, 34, 56);
const edit = (path: string, at?: number) => ({ type: 'tool-call', callId: `c-${path}`, name: 'Edit', input: { file_path: `/repo/${path}` }, sessionId: 's1', epoch: 0, seq: 1, ...(at !== undefined ? { at } : {}) });

describe('"Edited by … at" on a live session (#580)', () => {
    it('prints the writing call’s time in the workspace zone, and only the tool for an event from before events carried one', async () => {
        const actions = liveEditedBy({
            id: 's1',
            root: '/repo',
            runtime: 'claude-code',
            events: [edit('a.ts', AT), edit('old.ts')],
            agent: { name: 'Ada' },
            time: zoneFormat('Europe/Stockholm').time
        })!;
        expect(actions).toBeTypeOf('function');
        const stamped = await mount(actions('a.ts')!);
        expect(stamped.querySelector('[data-file-edited] a')!.textContent).toBe('Edit at 14:34');
        const old = await mount(actions('old.ts')!);
        expect(old.querySelector('[data-file-edited] a')!.textContent).toBe('Edit');
    });

    it('another zone, another clock time; no formatter, no time', async () => {
        const tokyo = liveEditedBy({ id: 's1', root: '/repo', runtime: 'claude-code', events: [edit('a.ts', AT)], agent: { name: 'Ada' }, time: zoneFormat('Asia/Tokyo').time })!;
        expect((await mount(tokyo('a.ts')!)).querySelector('[data-file-edited] a')!.textContent).toBe('Edit at 21:34');
        const plain = liveEditedBy({ id: 's1', root: '/repo', runtime: 'claude-code', events: [edit('a.ts', AT)], agent: { name: 'Ada' } })!;
        expect((await mount(plain('a.ts')!)).querySelector('[data-file-edited] a')!.textContent).toBe('Edit');
    });
});
