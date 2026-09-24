/**
 * The installable connector listings (#630): search, categories and counts, and that every listing can be connected.
 */
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { gmailConnectorPlugin } from '@agentic/connectors';
import { mcpConnectorSetup } from '@agentic/mcp';
import { pluginCatalogue } from '../src/plugins/catalogue';
import { CONNECTOR_CATEGORIES, CONNECTOR_LISTINGS, categoryCounts, listingsByCategory, matchListing, type ConnectorListing } from '../src/plugins/listings';
import { connectorOptions, validateConnectorDraft } from '../src/pages/plugins/connector';

const byId = (id: string): ConnectorListing => {
    const l = CONNECTOR_LISTINGS.find((x) => x.id === id);
    if (!l) throw new Error(`no listing ${id}`);
    return l;
};
const search = (q: string): string[] => CONNECTOR_LISTINGS.filter((l) => matchListing(l, q)).map((l) => l.id);
const catalogueIds = new Set(pluginCatalogue.map((e) => ('manifest' in e ? e.manifest.id : e.id)));

describe('matchListing', () => {
    it('finds a connector by name, case-insensitive', () => {
        expect(search('gmail')).toEqual(['gmail']);
        expect(search('  LiNeAr ')).toEqual(['linear']);
    });

    it('finds a connector by its service', () => {
        expect(search('atlassian')).toEqual(['jira']);
        expect(search('google')).toContain('gmail');
    });

    it('finds a connector by what it does', () => {
        expect(search('send email')).toEqual(['gmail']);
        expect(search('confluence')).toEqual(['jira']);
        expect(search('pull requests')).toEqual(['github']);
    });

    it('matches everything on a blank query and nothing on a stranger one', () => {
        expect(search('')).toHaveLength(CONNECTOR_LISTINGS.length);
        expect(search('   ')).toHaveLength(CONNECTOR_LISTINGS.length);
        expect(search('zzz-no-such-thing')).toEqual([]);
    });
});

describe('categories', () => {
    it('are the six the design names, in order, with ids and labels', () => {
        expect(CONNECTOR_CATEGORIES.map((c) => c.label)).toEqual(['Email & calendar', 'Files & docs', 'Chat', 'Dev tools', 'Project tracking', 'Data']);
        expect(new Set(CONNECTOR_CATEGORIES.map((c) => c.id)).size).toBe(6);
    });

    it('listingsByCategory gives one section per category, in order, holding every listing once', () => {
        const sections = listingsByCategory(CONNECTOR_LISTINGS);
        expect(sections.map((s) => s.category.id)).toEqual(CONNECTOR_CATEGORIES.map((c) => c.id));
        expect(sections.flatMap((s) => s.listings)).toHaveLength(CONNECTOR_LISTINGS.length);
        for (const s of sections) for (const l of s.listings) expect(l.category).toBe(s.category.id);
        expect(sections[0]!.listings.map((l) => l.id)).toContain('gmail');
    });

    it('categoryCounts counts everything, or only what is not connected yet', () => {
        const listings = [byId('gmail'), byId('github'), byId('sentry'), byId('linear')];
        const everything = categoryCounts(listings, ['gmail', 'github'], 'everything');
        expect(everything).toEqual({ all: 4, 'email-calendar': 1, 'files-docs': 0, chat: 0, 'dev-tools': 2, 'project-tracking': 1, data: 0 });
        const notConnected = categoryCounts(listings, new Set(['gmail', 'github']), 'not-connected');
        expect(notConnected).toEqual({ all: 2, 'email-calendar': 0, 'files-docs': 0, chat: 0, 'dev-tools': 1, 'project-tracking': 1, data: 0 });
        expect(categoryCounts(listings, [], 'not-connected')).toEqual(everything);
    });

    it('the counts over the full list add up to it', () => {
        const counts = categoryCounts(CONNECTOR_LISTINGS, [], 'everything');
        expect(counts.all).toBe(CONNECTOR_LISTINGS.length);
        expect(CONNECTOR_CATEGORIES.reduce((n, c) => n + counts[c.id], 0)).toBe(CONNECTOR_LISTINGS.length);
    });
});

describe('every listing can be connected', () => {
    it('has a unique id', () => {
        expect(new Set(CONNECTOR_LISTINGS.map((l) => l.id)).size).toBe(CONNECTOR_LISTINGS.length);
    });

    it.each(CONNECTOR_LISTINGS.map((l) => [l.id, l] as const))('%s is backed by a pluginCatalogue plugin or has an mcpPreset', (_id, l) => {
        expect(l.pluginId !== undefined || l.mcpPreset !== undefined).toBe(true);
        if (l.pluginId !== undefined) {
            expect(catalogueIds.has(l.pluginId)).toBe(true);
            expect(l.transport).toBe('conduit');
        }
    });

    it.each(CONNECTOR_LISTINGS.filter((l) => l.mcpPreset).map((l) => [l.id, l] as const))('%s: its preset fills a valid MCP form whose manifest asks for what the listing says', (_id, l) => {
        const preset = l.mcpPreset!;
        expect(l.transport).toBe('mcp');
        expect(new URL(preset.url).protocol).toBe('https:');
        const draft = { name: l.id, url: preset.url, auth: preset.auth ?? 'none', header: preset.header ?? '', secret: preset.auth && preset.auth !== 'none' ? 'token' : '' };
        expect(validateConnectorDraft(draft, new Set())).toEqual({});
        const { manifest } = mcpConnectorSetup(connectorOptions(draft));
        expect(manifest.id).toBe(l.id);
        const network = manifest.permissions.map((p) => p.scope).filter((s) => s.startsWith('network:'));
        expect(network).toEqual([...l.asks.scopes]);
        expect(l.asks.secrets.length).toBe((manifest.secrets ?? []).length);
    });

    it('the Gmail listing matches its manifest: id, version, tools and scopes', () => {
        const gmail = byId('gmail');
        expect(gmail.pluginId).toBe(gmailConnectorPlugin.id);
        expect(gmail.version).toBe(gmailConnectorPlugin.version);
        const operations = gmailConnectorPlugin.capabilities.filter((c) => c.startsWith('operation:')).map((c) => c.slice('operation:'.length));
        expect(gmail.tools.map((t) => t.name).sort()).toEqual([...operations].sort());
        const scopes = gmailConnectorPlugin.permissions.map((p) => p.scope);
        for (const s of gmail.asks.scopes) expect(scopes).toContain(s);
        expect(gmail.tools.filter((t) => t.askByDefault).map((t) => t.name)).toEqual(['send-email', 'reply-to-message', 'trash-message']);
    });
});
