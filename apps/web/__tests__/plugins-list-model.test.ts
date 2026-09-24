/**
 * The `/plugins` list's view model (#637): the category menu, search, status
 * counts, needs attention with its fixes, and the rows' kind tags — over the
 * mock workspace's plugins and readiness.
 */
import type { PluginReadiness } from '@agentic/core';
import type { PluginView } from '@agentic/platform';
import { listPlugins } from '../src/mock/plugins-list';
import { mockPluginFacts } from '../src/pages/plugins/PluginsList';
import { readinessById } from '../src/pages/plugins/readiness';
import { KEK_DOCS_HREF, filterPlugins, matchPlugin, memoryConsequence, menuCurrent, needsAttention, pluginMenu, pluginsHref, previewConnectors, rowKind, statusCounts, statusFilterOf } from '../src/pages/plugins/list-model';

const readiness = readinessById(listPlugins, mockPluginFacts());
const plugin = (id: string): PluginView => listPlugins.find((p) => p.manifest.id === id)!;
const ids = (rows: readonly PluginView[]): string[] => rows.map((p) => p.manifest.id);

describe('pluginMenu', () => {
    it('All and Needs attention, then Runtimes, Reach, Keep and Projects with counts; empty kinds stay at 0', () => {
        const menu = pluginMenu(listPlugins, readiness);
        expect(menu.map((g) => g.label)).toEqual([undefined, 'Runtimes', 'Reach', 'Keep', 'Projects']);
        expect(menu.map((g) => g.items.map((i) => `${i.label} ${i.count}`))).toEqual([
            [`All plugins ${listPlugins.length}`, 'Needs attention 2'],
            ['Harness 3', 'Model 1', 'Remote agents 0'],
            ['Connectors 4', 'Notifications 0', 'Triggers 0', 'A2A 1'],
            ['Memory 2', 'Learning 1'],
            ['Project features 1']
        ]);
        expect(menu[0]!.items[1]!.badge).toBe(true);
        expect(menu[1]!.items.map((i) => i.href)).toEqual(['/plugins?kind=harness', '/plugins?kind=model', '/plugins?kind=remote']);
        expect(menu[0]!.items[0]!.href).toBe('/plugins');
    });

    it('its links keep the search and the status', () => {
        const menu = pluginMenu(listPlugins, readiness, { q: 'flat', status: 'on' });
        expect(menu[3]!.items[0]!.href).toBe('/plugins?kind=memory&status=on&q=flat');
    });

    it('`?kind=` picks the item; none is All plugins', () => {
        expect(menuCurrent(undefined)).toBe('all');
        expect(menuCurrent('memory')).toBe('memory');
    });
});

describe('matchPlugin', () => {
    it('matches name, description, id, tool names and permission scopes; every word must match', () => {
        expect(matchPlugin(plugin('gmail'), 'googleapis')).toBe(true);
        expect(matchPlugin(plugin('anthropic-api'), 'secret:anthropic')).toBe(true);
        expect(matchPlugin(plugin('agentic.memory.flat'), 'FLAT')).toBe(true);
        expect(matchPlugin(plugin('claude-code'), 'paired machine')).toBe(true);
        expect(matchPlugin(plugin('claude-code'), 'paired googleapis')).toBe(false);
        expect(matchPlugin(plugin('gmail'), '')).toBe(true);
        const withTools = { manifest: { ...plugin('slack').manifest, tools: [{ name: 'slack__post-message', title: 'Post a message' }] } };
        expect(matchPlugin(withTools, 'post-message')).toBe(true);
        expect(matchPlugin(withTools, 'post a message')).toBe(true);
    });
});

describe('filters and counts', () => {
    it('`?kind=memory&q=flat` is only Flat memory', () => {
        expect(ids(filterPlugins(listPlugins, readiness, { kind: 'memory', q: 'flat' }))).toEqual(['agentic.memory.flat']);
    });

    it('a runtime kind, attention and a status combine with the search', () => {
        expect(ids(filterPlugins(listPlugins, readiness, { kind: 'harness' }))).toEqual(['claude-code', 'copilot-cli', 'codex-cli']);
        expect(ids(filterPlugins(listPlugins, readiness, { kind: 'attention' }))).toEqual(['anthropic-api', 'linear']);
        expect(ids(filterPlugins(listPlugins, readiness, { status: 'off' }))).toEqual(['a2a']);
        expect(ids(filterPlugins(listPlugins, readiness, { kind: 'connector', status: 'needs-setup' }))).toEqual(['linear']);
    });

    it('statusCounts: All, On, Off and Needs setup (a subset of On)', () => {
        expect(statusCounts(listPlugins, readiness)).toEqual({ all: listPlugins.length, on: listPlugins.length - 1, off: 1, 'needs-setup': 2 });
        expect(statusFilterOf('off')).toBe('off');
        expect(statusFilterOf('nonsense')).toBe('all');
        expect(pluginsHref({ kind: 'all', status: 'all', q: '  ' })).toBe('/plugins');
    });
});

describe('needsAttention', () => {
    it('lists each enabled plugin that is not ready, with what it needs and its fix', () => {
        const items = needsAttention(listPlugins, readiness);
        expect(items.map((a) => [a.plugin.manifest.id, a.status, a.text, a.fix.label, a.fix.href])).toEqual([
            ['anthropic-api', 'needs-secret', 'needs the anthropic-api-key secret', 'Add key', '/plugins/anthropic-api#secrets'],
            ['linear', 'needs-sign-in', 'its sign-in expired', 'Sign in', '/plugins/linear#account']
        ]);
    });

    it('has a fix for every status that needs one, and none for ready or off', () => {
        const p = plugin('gmail');
        const fixOf = (r: PluginReadiness) => needsAttention([p], { gmail: r })[0]?.fix;
        expect(fixOf({ status: 'needs-machine', missing: ['claude-code'] })).toEqual({ label: 'Pair a machine', href: '/pair' });
        expect(fixOf({ status: 'needs-config', missing: ['url'] })).toEqual({ label: 'Configure', href: '/plugins/gmail#settings' });
        expect(fixOf({ status: 'needs-grant', missing: ['network:x'] })).toEqual({ label: 'Grant', href: '/plugins/gmail#granted' });
        expect(fixOf({ status: 'no-kek' })).toEqual({ label: 'Deployment docs', href: KEK_DOCS_HREF, external: true });
        expect(fixOf({ status: 'ready' })).toBeUndefined();
        expect(needsAttention([{ ...p, enabled: false }], { gmail: { status: 'needs-secret' } })).toEqual([]);
    });
});

describe('rows', () => {
    it('kind tags: runtime kind, a connector\'s transport, else the kind in words', () => {
        expect(['claude-code', 'anthropic-api', 'gmail', 'github-mcp', 'agentic.memory.default', 'a2a'].map((id) => rowKind(plugin(id).manifest))).toEqual(['harness', 'model', 'conduit', 'mcp', 'memory', 'a2a']);
        expect(rowKind({ ...plugin('gmail').manifest, kind: 'project-feature' })).toBe('project feature');
    });

    it('the memory rows say what switching drops; the active one says nothing', () => {
        expect(memoryConsequence(plugin('agentic.memory.flat'))).toBe('switching into it drops conditions, evidence, superseding and expiry');
        expect(memoryConsequence(plugin('agentic.memory.default'))).toBeUndefined();
        expect(memoryConsequence(plugin('agentic.learning.default'))).toBeUndefined();
    });

    it('the Connectors group shows two and counts the rest', () => {
        expect(previewConnectors(['a', 'b', 'c', 'd'])).toEqual({ shown: ['a', 'b'], more: 2 });
        expect(previewConnectors(['a'])).toEqual({ shown: ['a'], more: 0 });
    });
});
