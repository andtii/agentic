/**
 * Image and file parts in the thread: an image renders a lazy thumbnail that
 * opens full size, a file a download chip with its name and size.
 */
import { describe, it, expect } from 'vitest';
import type { AgentMessage, AgentPart } from '@sigx/ai-agent/app';
import { expectAnatomy } from '@sigx/zero/testing';
import { Message, aiMessageAnatomy } from '../src/thread';
import { mediaSize, mediaSrc } from '../src/thread/Message';
import { mount, one } from './helpers';

const row = (...parts: AgentPart[]): AgentMessage => ({ id: 'm1', role: 'user', parts });

describe('media parts', () => {
    it('an image part with a url renders a lazy thumbnail that opens full size in a new tab', () => {
        const dom = mount(<Message message={row({ type: 'image', mediaType: 'image/png', url: 'https://files.test/a.png', name: 'diagram.png' } as AgentPart)} />);
        const link = one(dom, 'ai-message', 'image') as HTMLAnchorElement;
        expect(link.getAttribute('href')).toBe('https://files.test/a.png');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toContain('noopener');
        const img = link.querySelector('img')!;
        expect(img.getAttribute('src')).toBe('https://files.test/a.png');
        expect(img.getAttribute('alt')).toBe('diagram.png');
        expect(img.getAttribute('loading')).toBe('lazy');
        expectAnatomy(dom, aiMessageAnatomy);
    });

    it('an image part with base64 data renders it as a data URL', () => {
        const dom = mount(<Message message={row({ type: 'image', mediaType: 'image/png', data: 'iVBORw==' })} />);
        const img = dom.querySelector('img')!;
        expect(img.getAttribute('src')).toBe('data:image/png;base64,iVBORw==');
        expect(img.getAttribute('alt')).toBe('image');
    });

    it('a file part renders a download chip: icon, name and size', () => {
        const dom = mount(<Message message={row({ type: 'file', mediaType: 'application/pdf', url: 'https://files.test/r.pdf', filename: 'report.pdf', size: 2048 } as AgentPart)} />);
        const link = one(dom, 'ai-message', 'file') as HTMLAnchorElement;
        expect(link.tagName).toBe('A');
        expect(link.getAttribute('href')).toBe('https://files.test/r.pdf');
        expect(link.getAttribute('download')).toBe('report.pdf');
        expect(link.querySelector('[data-icon="file"]')).not.toBeNull();
        expect(one(link, 'ai-message', 'file-name')!.textContent).toBe('report.pdf');
        expect(one(link, 'ai-message', 'file-size')!.textContent).toBe('2 kB');
        expectAnatomy(dom, aiMessageAnatomy);
    });

    it('a file part with no bytes to link says what it was', () => {
        const dom = mount(<Message message={row({ type: 'file', mediaType: 'text/plain', filename: 'gone.txt' })} />);
        expect(one(dom, 'ai-message', 'file')).toBeNull();
        expect(dom.querySelector('code')!.textContent).toBe('gone.txt');
    });

    it('sizes a base64 payload by its decoded length', () => {
        expect(mediaSize({ mediaType: 'x', data: 'QUJD' })).toBe(3);
        expect(mediaSize({ mediaType: 'x', data: 'QUI=' })).toBe(2);
        expect(mediaSize({ mediaType: 'x', data: 'QQ==' })).toBe(1);
        expect(mediaSize({ mediaType: 'x', url: 'u' })).toBeUndefined();
        expect(mediaSrc({ mediaType: 'x' })).toBeUndefined();
    });
});
