/**
 * The markdown viewer (#490): `@sigx/markdown`'s parts inside the
 * `ag-markdown` surface — headings, lists and task boxes, tables, code
 * blocks (plain with `highlighter={false}`, highlighted through a
 * highlighter otherwise), links that open in a new tab unless `onLink`
 * takes them; `compact` is a modifier.
 */
import { describe, it, expect } from 'vitest';
import { expectAnatomy } from '@sigx/zero/testing';
import type { CodeHighlighter } from '@sigx/markdown/shiki';
import { MarkdownViewer, agMarkdownAnatomy } from '@agentic/ui';
import { mount, one, all, waitFor } from '../helpers';

const doc = [
    '# Plan',
    '',
    'Read the card, then:',
    '',
    '1. Add the listbox',
    '2. Wire `setOptions`',
    '',
    '- [x] read',
    '- [ ] edit',
    '',
    '> Why: the member picks its mode.',
    '',
    '| file | change |',
    '| --- | --- |',
    '| card.tsx | the button |',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    'See [the issue](https://example.com/490).'
].join('\n');

const part = (root: ParentNode, name: string) => all(root, 'markdown', name);

describe('MarkdownViewer', () => {
    it('renders the document as markdown parts inside its surface; holds the anatomy', () => {
        const dom = mount(<MarkdownViewer value={doc} highlighter={false} />);
        expectAnatomy(dom, agMarkdownAnatomy);
        const root = one(dom, 'ag-markdown', 'root')!;
        expect(root.hasAttribute('data-mod-compact')).toBe(false);
        expect(part(root, 'heading').map((h) => [h.tagName, h.getAttribute('data-depth'), h.textContent])).toEqual([['H1', '1', 'Plan']]);
        expect(part(root, 'list').map((l) => l.tagName)).toEqual(['OL', 'UL']);
        expect(part(root, 'list-item').map((li) => li.textContent)).toEqual(['Add the listbox', 'Wire setOptions', 'read', 'edit']);
        expect(part(root, 'checkbox').map((c) => (c as HTMLInputElement).checked)).toEqual([true, false]);
        expect(part(root, 'blockquote')[0]!.textContent).toBe('Why: the member picks its mode.');
        expect(part(root, 'table-cell').map((c) => c.tagName)).toEqual(['TH', 'TH', 'TD', 'TD']);
        expect(part(root, 'inline-code')[0]!.textContent).toBe('setOptions');
    });

    it('keeps code plain with highlighter={false}: a pre/code well with the language in its header', () => {
        const dom = mount(<MarkdownViewer value={doc} highlighter={false} />);
        const code = part(dom, 'code')[0]!;
        expect(code.getAttribute('data-lang')).toBe('ts');
        expect(part(code, 'code-lang')[0]!.textContent).toBe('ts');
        const body = part(code, 'code-body')[0]!;
        expect(body.closest('pre')).not.toBeNull();
        expect(body.textContent).toBe('const x = 1;');
        expect(body.querySelector('span')).toBeNull();
    });

    it('highlights code through the highlighter it is given', async () => {
        const highlighter: CodeHighlighter = {
            peek: () => null,
            highlight: async (code) => code.split('\n').map((line) => [{ content: line, color: '#f00', style: { '--shiki-dark': '#0f0' } }])
        };
        const dom = mount(<MarkdownViewer value={doc} highlighter={highlighter} />);
        await waitFor(() => part(dom, 'code-body')[0]!.querySelector('span[style]') !== null);
        const token = part(dom, 'code-body')[0]!.querySelector<HTMLElement>('span[style]')!;
        expect(token.textContent).toBe('const x = 1;');
        expect(token.getAttribute('style')).toContain('--shiki-dark');
    });

    it('opens links in a new tab, or hands them to onLink', () => {
        const dom = mount(<MarkdownViewer value={doc} highlighter={false} />);
        const link = part(dom, 'link')[0] as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('https://example.com/490');
        expect(link.getAttribute('target')).toBe('_blank');

        const seen: string[] = [];
        const routed = mount(<MarkdownViewer value={doc} highlighter={false} onLink={(url) => seen.push(url)} />);
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        part(routed, 'link')[0]!.dispatchEvent(event);
        expect(seen).toEqual(['https://example.com/490']);
        expect(event.defaultPrevented).toBe(true);
    });

    it('is a modifier away from the card-well size', () => {
        const dom = mount(<MarkdownViewer value="hi" compact highlighter={false} />);
        expect(one(dom, 'ag-markdown', 'root')!.hasAttribute('data-mod-compact')).toBe(true);
    });
});
