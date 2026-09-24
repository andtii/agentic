/**
 * The connectors a workspace can add (#630; PLG-01, PLG-04): a typed, static list in the build that the Add
 * connector page (`/plugins/connectors/add`, #639) browses by category and search. A listing only describes what
 * connecting would do; it installs and grants nothing by itself — connecting runs the existing flows (conduit
 * sign-in for a `pluginCatalogue` connector, the MCP form prefilled from `mcpPreset` for a remote MCP server).
 *
 * Rule: never list a connector that cannot be connected. Every entry is either backed by a `pluginCatalogue` plugin
 * (`pluginId`) or is a remote MCP server whose public URL takes a credential the MCP form can send (none, a bearer
 * token, or one header) — OAuth-only servers stay out until the form can sign in to them.
 *
 * Browser-safe on purpose: plain data, no imports of the catalogue's server code (conduit). The test checks the
 * Gmail entry against its manifest instead.
 */
import type { ConnectorAuthKind } from '../pages/plugins/connector';

export type ConnectorCategory = 'email-calendar' | 'files-docs' | 'chat' | 'dev-tools' | 'project-tracking' | 'data';

export interface ConnectorCategoryInfo {
    readonly id: ConnectorCategory;
    readonly label: string;
}

/** The Add connector page's categories, in menu order. */
export const CONNECTOR_CATEGORIES: readonly ConnectorCategoryInfo[] = [
    { id: 'email-calendar', label: 'Email & calendar' },
    { id: 'files-docs', label: 'Files & docs' },
    { id: 'chat', label: 'Chat' },
    { id: 'dev-tools', label: 'Dev tools' },
    { id: 'project-tracking', label: 'Project tracking' },
    { id: 'data', label: 'Data' }
];

export type ConnectorTransport = 'conduit' | 'mcp' | 'mcp-stdio';

export interface ConnectorListing {
    /** The plugin id it installs as (for an MCP server, what `connectorIdOf(name)` gives). */
    readonly id: string;
    readonly name: string;
    /** Who runs the service ("Google", "Atlassian"): searched, so "atlassian" finds Jira. */
    readonly service: string;
    readonly category: ConnectorCategory;
    readonly transport: ConnectorTransport;
    readonly publisher: string;
    readonly version: string;
    /** One line, for the tile. */
    readonly description: string;
    /** What it lets an agent do, in words: searched, so "send email" finds Gmail. */
    readonly does: readonly string[];
    /**
     * The tools it adds, and the ones that ask before running by default. Empty for an MCP server: it lists its
     * own tools, and the connection test shows them before anything is saved.
     */
    readonly tools: readonly { readonly name: string; readonly askByDefault?: boolean }[];
    /** What connecting asks for: the sign-in method, the network scopes it gets, the secrets the owner provides. */
    readonly asks: { readonly signIn?: string; readonly scopes: readonly string[]; readonly secrets: readonly string[] };
    readonly runsOn: 'platform' | 'machine';
    /** The `pluginCatalogue` plugin a conduit connector is. */
    readonly pluginId?: string;
    /** What the MCP form is prefilled with: the server's URL and how it takes its credential. */
    readonly mcpPreset?: { readonly url: string; readonly auth?: ConnectorAuthKind; readonly header?: string };
}

/** A hosted MCP server: its URL's host is the one network scope it gets, like `mcpConnector`'s manifest. */
function remoteMcp(
    l: Omit<ConnectorListing, 'transport' | 'tools' | 'asks' | 'runsOn' | 'version' | 'mcpPreset'> & {
        readonly url: string;
        readonly auth: ConnectorAuthKind;
        readonly header?: string;
        readonly secret?: string;
    }
): ConnectorListing {
    const { url, auth, header, secret, ...rest } = l;
    return {
        ...rest,
        transport: 'mcp',
        version: 'hosted',
        tools: [],
        asks: { scopes: [`network:${new URL(url).host}`], secrets: secret ? [secret] : [] },
        runsOn: 'platform',
        mcpPreset: { url, auth, ...(header ? { header } : {}) }
    };
}

export const CONNECTOR_LISTINGS: readonly ConnectorListing[] = [
    // The one conduit connector the build ships (`gmailConnectorPlugin`, #533). Outlook, Google Calendar, Google
    // Drive and OneDrive join once `@aigntiq/conduit-connectors` ships their specs.
    {
        id: 'gmail',
        name: 'Gmail',
        service: 'Google',
        category: 'email-calendar',
        transport: 'conduit',
        publisher: 'Built in',
        version: '1.0.0',
        description: 'Send, draft, search and label email.',
        does: ['Send email', 'Draft and reply to email', 'Search and read messages, threads and attachments', 'Label and trash messages', 'Start work when new email arrives'],
        tools: [
            { name: 'send-email', askByDefault: true },
            { name: 'create-draft' },
            { name: 'reply-to-message', askByDefault: true },
            { name: 'search-messages' },
            { name: 'get-message' },
            { name: 'get-thread' },
            { name: 'get-attachment' },
            { name: 'modify-labels' },
            { name: 'trash-message', askByDefault: true }
        ],
        asks: { signIn: 'Sign in with Google', scopes: ['network:gmail.googleapis.com', 'network:oauth2.googleapis.com'], secrets: ['Your own OAuth client ID', 'Your own OAuth client secret'] },
        runsOn: 'platform',
        pluginId: 'gmail'
    },
    remoteMcp({
        id: 'context7',
        name: 'Context7',
        service: 'Upstash',
        category: 'files-docs',
        publisher: 'Upstash',
        description: 'Current docs and code examples for libraries.',
        does: ['Look up library and framework documentation', 'Find code examples for an API'],
        url: 'https://mcp.context7.com/mcp',
        auth: 'none'
    }),
    remoteMcp({
        id: 'deepwiki',
        name: 'DeepWiki',
        service: 'Cognition',
        category: 'files-docs',
        publisher: 'Cognition',
        description: 'Ask about any public GitHub repository.',
        does: ['Read the generated docs of a public repository', 'Answer questions about a codebase'],
        url: 'https://mcp.deepwiki.com/mcp',
        auth: 'none'
    }),
    remoteMcp({
        id: 'cloudflare-docs',
        name: 'Cloudflare Docs',
        service: 'Cloudflare',
        category: 'files-docs',
        publisher: 'Cloudflare',
        description: 'Search the Cloudflare developer docs.',
        does: ['Search Cloudflare documentation', 'Look up Workers, Durable Objects and other product docs'],
        url: 'https://docs.mcp.cloudflare.com/mcp',
        auth: 'none'
    }),
    remoteMcp({
        id: 'intercom',
        name: 'Intercom',
        service: 'Intercom',
        category: 'chat',
        publisher: 'Intercom',
        description: 'Search customer conversations and contacts.',
        does: ['Search customer conversations', 'Read conversations and contacts'],
        url: 'https://mcp.intercom.com/mcp',
        auth: 'bearer',
        secret: 'Intercom access token'
    }),
    remoteMcp({
        id: 'github',
        name: 'GitHub',
        service: 'GitHub',
        category: 'dev-tools',
        publisher: 'GitHub',
        description: 'Issues and pull requests as tools.',
        does: ['Read and create issues', 'Review and open pull requests', 'Search code and repositories', 'Read files in a repository'],
        url: 'https://api.githubcopilot.com/mcp/',
        auth: 'bearer',
        secret: 'GitHub personal access token'
    }),
    remoteMcp({
        id: 'sentry',
        name: 'Sentry',
        service: 'Sentry',
        category: 'dev-tools',
        publisher: 'Sentry',
        description: 'Errors and releases for a project.',
        does: ['Search errors and issues', 'Read events and stack traces', 'Check releases'],
        url: 'https://mcp.sentry.dev/mcp',
        // Sentry takes an API token as `Authorization: Sentry-Bearer <token>`; plain `Bearer` is kept for its OAuth.
        auth: 'header',
        header: 'Authorization',
        secret: 'Sentry user auth token, entered as "Sentry-Bearer <token>"'
    }),
    remoteMcp({
        id: 'hugging-face',
        name: 'Hugging Face',
        service: 'Hugging Face',
        category: 'dev-tools',
        publisher: 'Hugging Face',
        description: 'Search models, datasets and Spaces.',
        does: ['Search models and datasets', 'Read model cards and papers', 'Run Spaces'],
        url: 'https://huggingface.co/mcp',
        auth: 'bearer',
        secret: 'Hugging Face access token'
    }),
    remoteMcp({
        id: 'linear',
        name: 'Linear',
        service: 'Linear',
        category: 'project-tracking',
        publisher: 'Linear',
        description: 'Issues, projects and cycles.',
        does: ['Find, create and update issues', 'Comment on issues', 'Read projects and cycles'],
        url: 'https://mcp.linear.app/mcp',
        auth: 'bearer',
        secret: 'Linear API key'
    }),
    remoteMcp({
        id: 'jira',
        name: 'Jira',
        service: 'Atlassian',
        category: 'project-tracking',
        publisher: 'Atlassian',
        description: 'Issues, sprints and boards, plus Confluence.',
        does: ['Find, create and update Jira issues', 'Read sprints and boards', 'Search and read Confluence pages'],
        url: 'https://mcp.atlassian.com/v1/mcp',
        // A service account API key; the org admin turns API token sign-in on for the Rovo MCP server first.
        auth: 'bearer',
        secret: 'Atlassian service account API key'
    }),
    remoteMcp({
        id: 'monday',
        name: 'monday.com',
        service: 'monday.com',
        category: 'project-tracking',
        publisher: 'monday.com',
        description: 'Boards, items and updates.',
        does: ['Read and update boards', 'Create and move items', 'Post updates'],
        url: 'https://mcp.monday.com/mcp',
        auth: 'bearer',
        secret: 'monday.com personal API token'
    }),
    remoteMcp({
        id: 'airtable',
        name: 'Airtable',
        service: 'Airtable',
        category: 'data',
        publisher: 'Airtable',
        description: 'Bases, tables and records.',
        does: ['Search and read records', 'Create and update records', 'Read base schemas'],
        url: 'https://mcp.airtable.com/mcp',
        auth: 'bearer',
        secret: 'Airtable personal access token'
    }),
    remoteMcp({
        id: 'supabase',
        name: 'Supabase',
        service: 'Supabase',
        category: 'data',
        publisher: 'Supabase',
        description: 'Postgres databases, tables and logs.',
        does: ['Run SQL against a project database', 'List tables and migrations', 'Read logs'],
        url: 'https://mcp.supabase.com/mcp',
        auth: 'bearer',
        secret: 'Supabase personal access token'
    }),
    remoteMcp({
        id: 'neon',
        name: 'Neon',
        service: 'Neon',
        category: 'data',
        publisher: 'Neon',
        description: 'Serverless Postgres projects and branches.',
        does: ['Run SQL queries', 'Create and manage database branches', 'List projects'],
        url: 'https://mcp.neon.tech/mcp',
        auth: 'bearer',
        secret: 'Neon API key'
    }),
    remoteMcp({
        id: 'posthog',
        name: 'PostHog',
        service: 'PostHog',
        category: 'data',
        publisher: 'PostHog',
        description: 'Product analytics, insights and feature flags.',
        does: ['Query product analytics', 'Read insights and dashboards', 'Manage feature flags'],
        url: 'https://mcp.posthog.com/mcp',
        auth: 'bearer',
        secret: 'PostHog personal API key'
    }),
    remoteMcp({
        id: 'stripe',
        name: 'Stripe',
        service: 'Stripe',
        category: 'data',
        publisher: 'Stripe',
        description: 'Customers, payments and subscriptions.',
        does: ['Look up customers and payments', 'Create invoices and payment links', 'Manage subscriptions'],
        url: 'https://mcp.stripe.com',
        auth: 'bearer',
        secret: 'Stripe restricted API key'
    })
];

/** The plugin id a listing installs as — what a workspace's connected ids are compared with. */
export const listingPluginId = (listing: ConnectorListing): string => listing.pluginId ?? listing.id;

/**
 * Search: every word of `q` appears, case-insensitive, in the listing's name, service, description or what it does
 * — so "send email" finds Gmail, and "atlassian" finds Jira. A blank query matches everything.
 */
export function matchListing(listing: ConnectorListing, q: string): boolean {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const text = [listing.name, listing.service, listing.description, ...listing.does].join('\n').toLowerCase();
    return words.every((w) => text.includes(w));
}

export interface ConnectorCategorySection {
    readonly category: ConnectorCategoryInfo;
    readonly listings: readonly ConnectorListing[];
}

/** One section per category, in `CONNECTOR_CATEGORIES` order — empty ones included, the page decides whether to draw them. */
export function listingsByCategory(listings: readonly ConnectorListing[]): ConnectorCategorySection[] {
    return CONNECTOR_CATEGORIES.map((category) => ({ category, listings: listings.filter((l) => l.category === category.id) }));
}

/** The category menu's counts, `all` included; with `show: 'not-connected'` the ones already connected are left out. */
export function categoryCounts(
    listings: readonly ConnectorListing[],
    connectedIds: Iterable<string>,
    show: 'everything' | 'not-connected'
): Record<ConnectorCategory | 'all', number> {
    const connected = new Set(connectedIds);
    const counts = { all: 0 } as Record<ConnectorCategory | 'all', number>;
    for (const c of CONNECTOR_CATEGORIES) counts[c.id] = 0;
    for (const l of listings) {
        if (show === 'not-connected' && connected.has(listingPluginId(l))) continue;
        counts.all++;
        counts[l.category]++;
    }
    return counts;
}
