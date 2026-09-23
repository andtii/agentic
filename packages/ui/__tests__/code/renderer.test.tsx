/**
 * The code surface seam (#563): the plain renderer's grid, line selection and
 * widget; `CodeRendererProvider` swapping the renderer; the Monaco renderer
 * drawing the plain grid until its engine reports ready (the engine is
 * stubbed here — happy-dom has no Monaco).
 */
import { describe, expect, it, vi } from 'vitest';
import { component, type Define } from '@sigx/runtime-core';
import { all, buttonNamed, mount, one, tick, waitFor } from '../helpers';
import { CodeDiff, CodeRendererProvider, CodeViewer, PlainDiff, PlainViewer, monacoCodeRenderer, plainCodeRenderer, useCodeRenderer, type CodeRenderer, type LineRef } from '../../src';

vi.mock('../../src/code/monaco/engine.js', async () => {
    const { component: c } = await import('@sigx/runtime-core');
    const stub = (label: string) => c<{ onEngineReady?: () => void }>(({ props }) => {
        queueMicrotask(() => props.onEngineReady?.());
        return () => <div data-stub-engine={label} />;
    });
    return { MonacoViewerEngine: stub('viewer'), MonacoDiffEngine: stub('diff') };
});

const SHELL_HEAD = '.shell {\n  display: grid;\n  grid-template-columns: 232px 1fr;\n  min-height: 100dvh;\n}\n';
const SHELL_NOW = '.shell {\n  display: grid;\n  grid-template-columns: var(--drawer-w, 232px) minmax(0, 1fr);\n  min-height: 100dvh;\n}\n\n[data-l-drawer="closed"] { --drawer-w: 0px; }\n';

const rows = (root: ParentNode) => all(root, 'ag-code', 'row');

describe('the plain renderer', () => {
    it('draws a viewer row per line with the number, the change stripe and the text', () => {
        const root = mount(<PlainViewer text={SHELL_NOW} path="packages/ui/src/shell/shell.css" lineMarks={[{ line: 3, tone: 'working' }]} />);
        const r = rows(root);
        expect(r).toHaveLength(7);
        expect(r[2]!.querySelector('[data-part="num"]')!.textContent).toBe('3');
        expect(r[2]!.querySelector('[data-part="stripe"]')!.getAttribute('data-tone')).toBe('working');
        expect(r[0]!.querySelector('[data-part="stripe"]')!.hasAttribute('data-tone')).toBe(false);
        expect(one(root, 'ag-code', 'root')!.getAttribute('aria-label')).toBe('packages/ui/src/shell/shell.css');
        // No listener: numbers are text, not buttons.
        expect(root.querySelectorAll('button')).toHaveLength(0);
    });

    it('makes numbers buttons when asked, and draws the widget under the selected line', async () => {
        const picked: number[] = [];
        const st = { selected: undefined as number | undefined };
        const Host = component(({ signal }) => {
            const s = signal(st);
            return () => <PlainViewer text={SHELL_NOW} path="shell.css" selected={s.selected} onLineSelect={(line) => { picked.push(line); s.selected = line; }} lineWidget={() => <p data-probe="">ask</p>} />;
        });
        const root = mount(<Host />);
        buttonNamed(root, 'Line 4').click();
        await tick();
        expect(picked).toEqual([4]);
        const selected = root.querySelector('[data-selected]')!;
        expect(selected.getAttribute('data-line')).toBe('4');
        expect(selected.nextElementSibling!.getAttribute('data-part')).toBe('widget');
        expect(root.querySelector('[data-probe]')).not.toBeNull();
    });

    it('draws a unified diff: a hunk header, both numbers, tinted removed and added rows', () => {
        const root = mount(<PlainDiff original={SHELL_HEAD} modified={SHELL_NOW} path="shell.css" mode="unified" />);
        const r = rows(root);
        expect(r[0]!.hasAttribute('data-hunk')).toBe(true);
        expect(r[0]!.textContent).toContain('@@ -1,5 +1,7 @@');
        const removed = r.find((row) => row.getAttribute('data-tone') === 'failed')!;
        const added = r.filter((row) => row.getAttribute('data-tone') === 'live');
        expect(removed.querySelector('[data-part="marker"]')!.textContent).toBe('-');
        expect([...removed.querySelectorAll('[data-part="num"]')].map((n) => n.textContent)).toEqual(['3', '']);
        expect(added).toHaveLength(3);
        expect([...added[0]!.querySelectorAll('[data-part="num"]')].map((n) => n.textContent)).toEqual(['', '3']);
        expect(root.querySelectorAll('[data-context]').length).toBeGreaterThan(0);
    });

    it('reports which side a clicked number belongs to, and pairs lines in split mode', async () => {
        const picked: LineRef[] = [];
        const root = mount(<PlainDiff original={SHELL_HEAD} modified={SHELL_NOW} path="shell.css" mode="unified" onLineSelect={(ref) => picked.push(ref)} />);
        buttonNamed(root, 'Line 3 before').click();
        buttonNamed(root, 'Line 7 after').click();
        expect(picked).toEqual([{ side: 'original', line: 3 }, { side: 'modified', line: 7 }]);

        const split = mount(<PlainDiff original={SHELL_HEAD} modified={SHELL_NOW} path="shell.css" mode="split" />);
        expect(one(split, 'ag-code', 'root')!.getAttribute('data-mode')).toBe('split');
        const changed = rows(split).find((row) => row.querySelector('[data-tone="failed"]'))!;
        // The removed line and its replacement share a row.
        expect(changed.querySelector('[data-part="text"][data-tone="live"]')!.textContent).toContain('var(--drawer-w');
    });

    it('says so when the two texts are the same', () => {
        const root = mount(<PlainDiff original="a\n" modified="a\n" path="a.txt" mode="unified" />);
        expect(one(root, 'ag-code', 'notice')!.textContent).toBe('No differences.');
    });
});

describe('choosing the renderer', () => {
    it('defaults to Monaco, and a provider swaps it for its subtree', () => {
        const seen: string[] = [];
        const Probe = component(() => {
            seen.push(useCodeRenderer().id);
            return () => null;
        });
        mount(<Probe />);
        mount(<CodeRendererProvider renderer={plainCodeRenderer}><Probe /></CodeRendererProvider>);
        expect(seen).toEqual(['monaco', 'plain']);
    });

    it('lets any component pair stand in as a renderer', () => {
        type P = Define.Prop<'path', string, true>;
        const Viewer = component<P>(({ props }) => () => <p data-custom-viewer="">{props.path}</p>);
        const Diff = component<P>(({ props }) => () => <p data-custom-diff="">{props.path}</p>);
        const custom = { id: 'custom', Viewer, Diff } as unknown as CodeRenderer;
        const root = mount(
            <CodeRendererProvider renderer={custom}>
                <CodeViewer text="x" path="a.ts" />
                <CodeDiff original="x" modified="y" path="b.ts" mode="unified" />
            </CodeRendererProvider>
        );
        expect(root.querySelector('[data-custom-viewer]')!.textContent).toBe('a.ts');
        expect(root.querySelector('[data-custom-diff]')!.textContent).toBe('b.ts');
    });

    it('Monaco draws the plain grid first, then shows its engine once ready', async () => {
        const root = mount(<monacoCodeRenderer.Viewer text={SHELL_NOW} path="shell.css" />);
        const surface = root.querySelector('[data-engine="monaco"]')!;
        // What the server sends and what stays without JavaScript: the plain rows.
        expect(surface.querySelector('[data-plain] [data-engine="plain"]')).not.toBeNull();
        expect(surface.hasAttribute('data-ready')).toBe(false);
        await waitFor(() => surface.hasAttribute('data-ready'));
        expect(surface.querySelector('[data-stub-engine="viewer"]')).not.toBeNull();

        const diff = mount(<monacoCodeRenderer.Diff original={SHELL_HEAD} modified={SHELL_NOW} path="shell.css" mode="split" />);
        await waitFor(() => diff.querySelector('[data-engine="monaco"]')!.hasAttribute('data-ready'));
        expect(diff.querySelector('[data-stub-engine="diff"]')).not.toBeNull();
    });
});
