import { render } from '@sigx/runtime-dom';
import { Stack, Row, Col, Spacer, layoutAttrs, isLayoutKey } from '../src/index';

function mount(el: Parameters<typeof render>[0]): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(el, host);
    return host;
}

describe('layoutAttrs', () => {
    it('renders each layout prop under the data-l- prefix', () => {
        expect(layoutAttrs({ gap: 'md', pad: 'lg', align: 'center', justify: 'between' })).toEqual({
            'data-l-gap': 'md',
            'data-l-pad': 'lg',
            'data-l-align': 'center',
            'data-l-justify': 'between'
        });
    });

    it('renders booleans presence-only and drops false/undefined', () => {
        expect(layoutAttrs({ wrap: true, grow: false, gap: undefined })).toEqual({ 'data-l-wrap': '' });
    });

    it('puts the breakpoint in prefix position', () => {
        expect(layoutAttrs({ gap: 'sm', at: { md: { gap: 'lg', wrap: true }, lg: { justify: 'end' } } })).toEqual({
            'data-l-gap': 'sm',
            'data-l-md-gap': 'lg',
            'data-l-md-wrap': '',
            'data-l-lg-justify': 'end'
        });
    });

    it('knows which keys it consumes', () => {
        expect(isLayoutKey('gap')).toBe(true);
        expect(isLayoutKey('at')).toBe(true);
        expect(isLayoutKey('class')).toBe(false);
    });
});

describe('Stack / Row / Col', () => {
    it('Stack is a vertical stack carrying its layout attributes', () => {
        const host = mount(<Stack gap="md" pad="xl" at={{ md: { gap: 'xl' } }}><span>a</span><span>b</span></Stack>);
        const root = host.querySelector('[data-scope="stack"][data-part="root"]')!;
        expect(root.tagName).toBe('DIV');
        expect(root.getAttribute('data-orientation')).toBe('vertical');
        expect(root.getAttribute('data-l-gap')).toBe('md');
        expect(root.getAttribute('data-l-pad')).toBe('xl');
        expect(root.getAttribute('data-l-md-gap')).toBe('xl');
        expect(root.textContent).toBe('ab');
    });

    it('Row and Col are the same scope with a different default orientation', () => {
        const host = mount(<><Row>r</Row><Col>c</Col></>);
        const [row, col] = Array.from(host.querySelectorAll('[data-scope="stack"]'));
        expect(row.getAttribute('data-orientation')).toBe('horizontal');
        expect(col.getAttribute('data-orientation')).toBe('vertical');
    });

    it('takes an explicit orientation, tag and aria-label', () => {
        const host = mount(<Row orientation="vertical" as="nav" aria-label="Primary" class="x">n</Row>);
        const el = host.querySelector('nav')!;
        expect(el.getAttribute('data-orientation')).toBe('vertical');
        expect(el.getAttribute('aria-label')).toBe('Primary');
        expect(el.className).toBe('x');
    });

    it('omits every layout attribute it was not given', () => {
        const host = mount(<Stack>plain</Stack>);
        const root = host.querySelector('[data-scope="stack"]')!;
        const dataL = Array.from(root.attributes).filter(a => a.name.startsWith('data-l-'));
        expect(dataL).toHaveLength(0);
    });
});

describe('Spacer', () => {
    it('is an empty, aria-hidden spacer part', () => {
        const host = mount(<Row><span>a</span><Spacer /><span>b</span></Row>);
        const spacer = host.querySelector('[data-scope="spacer"][data-part="root"]')!;
        expect(spacer.getAttribute('aria-hidden')).toBe('true');
        expect(spacer.textContent).toBe('');
    });
});
