import { component, signal, watch, type Define } from 'sigx';
import { Button, ConfirmDialog, SelectField, StatusPill, TextField } from '@agentic/ui';
import { CONNECTOR_AUTH_OPTIONS, connectorIdOf, emptyConnectorDraft, probeConnector, validateConnectorDraft, type ConnectorAuthKind, type ConnectorDraft, type ConnectorProbe } from './connector';

export interface AddConnectorRequest {
    readonly draft: ConnectorDraft;
    /** What "Test connection" found for these exact values, when it was run. */
    readonly probe?: ConnectorProbe;
}

export type AddConnectorDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'busy', boolean>
    /** Plugin ids already in the Registry — a name that would collide is refused. */
    & Define.Prop<'taken', ReadonlySet<string>>
    /** Why the last add failed, from the page. */
    & Define.Prop<'error', string>
    /** The probe; tests hand in one over a fake server. */
    & Define.Prop<'probe', (draft: ConnectorDraft) => Promise<ConnectorProbe>>
    & Define.Event<'add', AddConnectorRequest>
    & Define.Event<'cancel'>;

/** The values a probe answered for — a test of other values says nothing about these. */
const probeKey = (d: ConnectorDraft): string => JSON.stringify([d.name.trim(), d.url.trim(), d.auth, d.header.trim(), d.secret]);

/**
 * "Add MCP server" (#241): a name, the server's Streamable HTTP URL and how
 * it takes its credential. "Test connection" connects with these values and
 * lists the tools agents would get; adding stores the plugin, the connector
 * and the credential (sealed, never shown again). Servers a machine spawns
 * over stdio need the daemon, which is not wired yet (#280).
 */
export const AddConnectorDialog = component<AddConnectorDialogProps>(({ props, emit }) => {
    const draft = signal<ConnectorDraft>(emptyConnectorDraft());
    const st = signal<{ attempted: boolean; testing: boolean; probe: ConnectorProbe | null; probedFor: string }>({ attempted: false, testing: false, probe: null, probedFor: '' });
    // Each opening starts empty: a credential typed last time does not linger.
    watch(
        () => props.model?.value === true,
        (open) => {
            if (!open) return;
            Object.assign(draft, emptyConnectorDraft());
            Object.assign(st, { attempted: false, testing: false, probe: null, probedFor: '' });
        },
        { immediate: true }
    );
    const errors = () => validateConnectorDraft(draft, props.taken ?? new Set());
    const shown = (field: keyof ReturnType<typeof errors>): string | undefined => (st.attempted ? errors()[field] : undefined);
    const probe = (): ConnectorProbe | null => (st.probe && st.probedFor === probeKey(draft) ? st.probe : null);

    const test = async (): Promise<void> => {
        const { url, header, secret } = errors();
        if (url || header || secret) {
            st.attempted = true;
            return;
        }
        st.testing = true;
        const key = probeKey(draft);
        try {
            const answer = await (props.probe ?? probeConnector)({ ...draft });
            st.probe = answer;
            st.probedFor = key;
        } finally {
            st.testing = false;
        }
    };

    return () => {
        const p = probe();
        const id = connectorIdOf(draft.name);
        return (
            <ConfirmDialog
                model={props.model}
                title="Add MCP server"
                description="Agents that pick it get its tools. Its credential is sealed in this workspace and never shown again."
                confirmLabel="Add connector"
                danger={false}
                busy={props.busy}
                onConfirm={() => {
                    if (Object.keys(errors()).length) {
                        st.attempted = true;
                        return;
                    }
                    emit('add', { draft: { ...draft }, ...(p ? { probe: p } : {}) });
                }}
                onCancel={() => emit('cancel')}
            >
                <div data-add-connector>
                    <TextField model={() => draft.name} name="connector-name" label="Name" required error={shown('name')} description={id ? `Agents pick it as ${id}; its tools are named ${id.replace(/\./g, '_')}__<tool>.` : 'What it is, like GitHub.'} />
                    <TextField model={() => draft.url} name="connector-url" label="URL" type="url" required placeholder="https://mcp.example.com/mcp" error={shown('url')} description="Streamable HTTP. Servers a machine runs over stdio need a machine — coming." />
                    <SelectField model={() => draft.auth} name="connector-auth" label="Authentication" options={CONNECTOR_AUTH_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
                    {draft.auth === 'header' ? <TextField model={() => draft.header} name="connector-header" label="Header" placeholder="X-Api-Key" error={shown('header')} /> : null}
                    {(draft.auth as ConnectorAuthKind) !== 'none' ? (
                        <TextField model={() => draft.secret} name="connector-secret" label={draft.auth === 'bearer' ? 'Token' : 'Key'} type="password" error={shown('secret')} />
                    ) : null}
                    <div data-connector-test>
                        <Button icon="wifi" loading={st.testing} disabled={st.testing} onClick={() => { void test(); }}>Test connection</Button>
                        {p ? (
                            p.ok ? (
                                <div data-connector-probe="ok" role="status">
                                    <StatusPill status="online" label={`${p.tools.length} ${p.tools.length === 1 ? 'tool' : 'tools'}`} />
                                    {p.tools.length ? <ul data-connector-tools>{p.tools.map((t) => <li key={t}><code data-mono>{t}</code></li>)}</ul> : null}
                                </div>
                            ) : (
                                <div data-connector-probe="error" role="status">
                                    <StatusPill status="error" label="FAILED" />
                                    <span data-connector-error>{p.error}</span>
                                </div>
                            )
                        ) : null}
                    </div>
                    {props.error ? <p data-chat-error role="alert">{props.error}</p> : null}
                </div>
            </ConfirmDialog>
        );
    };
}, { name: 'AddConnectorDialog' });
