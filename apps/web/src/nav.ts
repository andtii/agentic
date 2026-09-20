import type { NavGroup } from '@agentic/ui';
import { inbox } from './mock/data';

/** The inbox kinds that need a person — the Home badge counts them (docs/design/HANDOFF.md → nav badge). */
export const NEEDS_YOU_KINDS: ReadonlySet<string> = new Set(['approval', 'input', 'interrupted']);

/** The Home badge of the mock workspace: open inbox items of a kind in `NEEDS_YOU_KINDS`. */
export const needsYouCount = (): number => inbox.filter(item => NEEDS_YOU_KINDS.has(item.kind)).length;

/**
 * The sidebar navigation in its two groups (`docs/design/HANDOFF.md` →
 * "Layout and shell"; routes per docs/architecture.md §10). `/pair` is
 * reached from Machines, not the nav. `badge` is Home's: the shell passes
 * the "Needs you" count it reads (#151) — the same rows Home lists.
 */
export const NAV_GROUPS = (badge: number = needsYouCount()): readonly NavGroup[] => [
    {
        label: 'Primary',
        items: [
            { href: '/', label: 'Home', icon: 'home', badge },
            { href: '/chats', label: 'Chats', icon: 'chats' },
            { href: '/projects', label: 'Projects', icon: 'folder' },
            { href: '/agents', label: 'Agents', icon: 'agents' },
            { href: '/machines', label: 'Machines', icon: 'machines' },
            { href: '/schedules', label: 'Schedules', icon: 'schedules' }
        ]
    },
    {
        label: 'Workspace',
        items: [
            { href: '/history', label: 'History', icon: 'history' },
            { href: '/usage', label: 'Usage', icon: 'usage' },
            { href: '/plugins', label: 'Plugins', icon: 'plugins' },
            { href: '/settings', label: 'Settings', icon: 'settings' }
        ]
    }
];

/** Every nav entry, flat — what the route test checks against the route table. */
export const NAV = NAV_GROUPS().flatMap(group => group.items);

/** Topbar breadcrumb roots per route name — see `crumbs.ts`, which also builds the trail. */
export { CRUMBS } from './crumbs';
