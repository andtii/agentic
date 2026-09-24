/**
 * The Connectors view's model (#638; PLG-03, OPS-04): pure, over the reads
 * the page already has — the Registry's plugins and connector records, the
 * workspace's connector account summaries (never a credential) and each
 * plugin's readiness. It lists only the connectors the workspace has added,
 * one row each with the account or endpoint line, the transport tag and what
 * Sign in does; the chips count them. No hook, no DOM.
 */
import type { PluginReadiness } from '@agentic/core';
import type { ConnectorAccountSummary, ConnectorRecord, PluginView } from '@agentic/platform';
import { connectorStartPath } from '../../connectors/paths';
import { connectionOf } from './conduit';
import type { ConnectorAuthKind, ConnectorDraft } from './connector';
import { isAuthError } from './readiness';

/** The transport tag a row shows. */
export type ConnectorTransportTag = 'conduit' | 'mcp' | 'mcp stdio';

/** A record's transport as the row tags it: conduit, MCP over Streamable HTTP, MCP a machine spawns. */
export function connectorTransport(record: Pick<ConnectorRecord, 'transport'>): ConnectorTransportTag {
    return record.transport === 'conduit' ? 'conduit' : record.transport === 'stdio' ? 'mcp stdio' : 'mcp';
}

/** What Sign in does for a row: a conduit connector goes to its sign-in route, an MCP connector opens the MCP sign-in form. */
export type ConnectorSignIn =
    | { readonly kind: 'conduit'; readonly href: string }
    | { readonly kind: 'mcp' };

export interface ConnectorRow {
    readonly id: string;
    readonly name: string;
    readonly plugin: PluginView;
    readonly record: ConnectorRecord;
    /** The account or endpoint line, mono under the name (`mcp.linear.app · token expired`). */
    readonly line: string;
    readonly transport: ConnectorTransportTag;
    /** `undefined` while the readiness facts load. */
    readonly readiness: PluginReadiness | undefined;
    /** Set when the row needs signing in again (`needs-sign-in`). */
    readonly signIn: ConnectorSignIn | undefined;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * `12 Sep`, in `zone` (UTC by default: the mock and the tests render the same
 * day everywhere). The month is spelled here: ICU's `en-GB` short month for
 * September is `Sept` in some runtimes and `Sep` in others.
 */
export function dayMonth(ms: number, zone = 'UTC'): string {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, day: 'numeric', month: 'numeric' }).formatToParts(ms);
    const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    return `${part('day')} ${MONTHS[part('month') - 1] ?? ''}`;
}

/** An endpoint without its scheme or trailing slash: `https://mcp.linear.app/` → `mcp.linear.app`. */
export function endpointOf(url: string): string {
    return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * The account or endpoint line: who a conduit connector is signed in as and
 * since when, where an MCP server is and what its last check said, which
 * machine runs a stdio server. `accounts` still loading (`undefined`) says
 * nothing about the account yet.
 */
export function connectorLine(
    record: ConnectorRecord,
    accounts: readonly ConnectorAccountSummary[] | undefined,
    date: (ms: number) => string = (ms) => dayMonth(ms)
): string {
    if (record.transport === 'conduit') {
        const c = connectionOf(record, accounts);
        if (!c) return `${record.connector ?? record.id} account`;
        switch (c.state) {
            case 'active':
                return `${c.account.displayName ?? `${record.connector ?? record.id} account`} · connected ${date(c.account.createdAt)}`;
            case 'needs-reauth':
                return `${c.account.displayName ?? `${record.connector ?? record.id} account`} · sign-in expired`;
            case 'missing':
                return 'account gone · sign in again';
            default:
                return 'not connected';
        }
    }
    if (record.transport === 'stdio') return `${record.machine ?? record.command ?? 'a machine'} · runs on the daemon`;
    const where = record.url ? endpointOf(record.url) : 'mcp';
    if (record.status.state === 'ok') return `${where} · ${plural(record.tools.length, 'tool')}`;
    if (record.status.state === 'error') return `${where} · ${isAuthError(record.status.error) ? 'token expired' : 'check failed'}`;
    return `${where} · not checked yet`;
}

/**
 * A connector the workspace has: an MCP record (http or stdio), or a conduit
 * record that names an account. A conduit connector nobody connected yet is
 * one to add, not one you have: it belongs on the Add connector page.
 */
export const isConnected = (record: Pick<ConnectorRecord, 'transport' | 'account'>): boolean => record.transport !== 'conduit' || record.account !== undefined;

/**
 * One row per connected connector, in the Registry's plugin order: its
 * plugin, its record, the line, the transport tag, its readiness, and — when
 * the sign-in lapsed — what Sign in does.
 */
export function connectorRows(
    plugins: readonly PluginView[],
    records: readonly ConnectorRecord[],
    accounts: readonly ConnectorAccountSummary[] | undefined,
    readiness: Readonly<Record<string, PluginReadiness>>,
    options: { readonly date?: (ms: number) => string } = {}
): ConnectorRow[] {
    const rows: ConnectorRow[] = [];
    for (const plugin of plugins) {
        if (plugin.manifest.kind !== 'connector') continue;
        const id = plugin.manifest.id;
        const record = records.find((r) => r.pluginId === id);
        if (!record || !isConnected(record)) continue;
        const r = readiness[id];
        const signIn: ConnectorSignIn | undefined = r?.status !== 'needs-sign-in' ? undefined : record.transport === 'conduit' ? { kind: 'conduit', href: connectorStartPath(id) } : { kind: 'mcp' };
        rows.push({ id, name: plugin.manifest.name, plugin, record, line: connectorLine(record, accounts, options.date), transport: connectorTransport(record), readiness: r, signIn });
    }
    return rows;
}

export type ConnectorFilter = 'all' | 'ready' | 'needs-sign-in';

export interface ConnectorChip {
    readonly id: ConnectorFilter;
    readonly label: string;
    readonly count: number;
}

/** The chips over the list: All, Ready and Needs sign-in, with their counts. */
export function connectorChips(rows: readonly Pick<ConnectorRow, 'readiness'>[]): ConnectorChip[] {
    return [
        { id: 'all', label: 'All', count: rows.length },
        { id: 'ready', label: 'Ready', count: rows.filter((r) => r.readiness?.status === 'ready').length },
        { id: 'needs-sign-in', label: 'Needs sign-in', count: rows.filter((r) => r.readiness?.status === 'needs-sign-in').length }
    ];
}

/** The rows a chip and the filter box leave: the query matches the name, the id, the line and the transport, ignoring case. */
export function filterConnectorRows<R extends Pick<ConnectorRow, 'id' | 'name' | 'line' | 'transport' | 'readiness'>>(rows: readonly R[], filter: ConnectorFilter, query: string): R[] {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
        if (filter !== 'all' && r.readiness?.status !== filter) return false;
        return !q || [r.name, r.id, r.line, r.transport].some((s) => s.toLowerCase().includes(q));
    });
}

/** How an MCP record takes its credential: the secret it reads and, for a header, which one. */
export interface McpCredential {
    readonly auth: ConnectorAuthKind;
    /** The Registry secret the new credential is sealed under; absent when the server takes none. */
    readonly secret?: string;
    readonly header?: string;
}

export function mcpCredentialOf(record: Pick<ConnectorRecord, 'auth' | 'secrets'>): McpCredential {
    if (record.auth?.bearer) return { auth: 'bearer', secret: record.auth.bearer };
    const [header, secret] = Object.entries(record.auth?.headers ?? {})[0] ?? [];
    if (header && secret) return { auth: 'header', header, secret };
    // A stdio server reads it from its environment: one value, like a token.
    const env = Object.values(record.auth?.env ?? {})[0];
    if (env) return { auth: 'bearer', secret: env };
    // A record from before #240: its first secret is the bearer token.
    const first = record.secrets?.[0];
    return first ? { auth: 'bearer', secret: first } : { auth: 'none' };
}

/** The draft the MCP sign-in re-checks the server with: the record's own URL and auth, the credential just typed. */
export function mcpSignInDraft(record: Pick<ConnectorRecord, 'id' | 'url' | 'auth' | 'secrets'>, value: string): ConnectorDraft {
    const c = mcpCredentialOf(record);
    return { name: record.id, url: record.url ?? '', auth: c.auth, header: c.header ?? '', secret: value };
}
