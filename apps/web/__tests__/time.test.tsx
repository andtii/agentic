import { render } from 'sigx';
import { Age } from '../src/components/Age';
import { setDataMode } from '../src/data-mode';
import { MOCK_NOW } from '../src/mock/workspace';
import { clockNow, zoneFormat } from '../src/time';

/** The month's short name is ICU's (`Sep` or `Sept`), so the assertions take either. */
const AT = Date.UTC(2026, 8, 16, 23, 30);

afterEach(() => {
    setDataMode('mock');
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('zoneFormat', () => {
    it('prints the same instant in each zone', () => {
        expect(zoneFormat('UTC').time(AT)).toBe('23:30');
        expect(zoneFormat('Europe/Stockholm').time(AT)).toBe('01:30');
        expect(zoneFormat('UTC').dateTime(AT)).toMatch(/^16 Sept?,? 23:30$/);
        expect(zoneFormat('Europe/Stockholm').dateTime(AT)).toMatch(/^17 Sept?,? 01:30$/);
    });

    it('is built once per zone, and an unknown zone formats as UTC', () => {
        expect(zoneFormat('Europe/Stockholm')).toBe(zoneFormat('Europe/Stockholm'));
        expect(zoneFormat('Not/AZone').time(AT)).toBe('23:30');
        expect(zoneFormat().zone).toBe('UTC');
    });

    it('ages: now, minutes, hours, then the date in the zone', () => {
        const fmt = zoneFormat('Europe/Stockholm');
        expect(fmt.age(AT, AT + 20_000)).toBe('now');
        expect(fmt.age(AT, AT + 14 * 60_000)).toBe('14m');
        expect(fmt.age(AT, AT + 3 * 3_600_000)).toBe('3h');
        expect(fmt.age(AT, AT + 30 * 3_600_000)).toMatch(/^17 Sept?$/);
        expect(zoneFormat('UTC').age(AT, AT + 30 * 3_600_000)).toMatch(/^16 Sept?$/);
    });
});

describe('the clock', () => {
    it('is the mock workspace’s in mock mode and the real one on the platform', () => {
        vi.useFakeTimers({ now: AT + 5 * 60_000 });
        expect(clockNow()).toBe(MOCK_NOW);
        setDataMode('live');
        expect(clockNow()).toBe(AT + 5 * 60_000);
    });

    it('Age follows it, and the zone it is given', () => {
        const mount = (node: unknown): HTMLElement => {
            const host = document.createElement('div');
            document.body.append(host);
            render(node as never, host);
            return host.querySelector('[data-age]') as HTMLElement;
        };
        expect(mount(<Age at={MOCK_NOW - 14 * 60_000} />).textContent).toBe('14m');

        vi.useFakeTimers({ now: AT + 3 * 3_600_000 });
        setDataMode('live');
        const live = mount(<Age at={AT} zone="UTC" />);
        expect(live.textContent).toBe('3h');
        expect(live.getAttribute('title')).toMatch(/^16 Sept?,? 23:30$/);
    });
});
