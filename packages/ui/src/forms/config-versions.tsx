/**
 * `ConfigVersions` — the durable configuration history of an agent (AGT-06)
 * with a revert action per past version. Emits `revert(version)`; with an
 * `action` every row is also a real form so the revert posts without JS.
 */

import { component, type Define } from '@sigx/runtime-core';
import { Badge, Button, Table } from '@sigx/zero';
import type { AgentConfigVersion } from '@agentic/core';

export type ConfigVersionsProps = Define.Prop<'versions', readonly AgentConfigVersion[], true> &
    /** Defaults to the highest version. */
    Define.Prop<'current', number> &
    Define.Prop<'caption', string> &
    /** Pre-hydration revert: posts `version=<n>` here. */
    Define.Prop<'action', string> &
    Define.Prop<'formatAt', (at: number) => string> &
    Define.Prop<'disabled', boolean> &
    Define.Event<'revert', number>;

export const ConfigVersions = component<ConfigVersionsProps>(
    ({ props, emit }) =>
        () => {
            const rows = [...props.versions].sort((a, b) => b.version - a.version);
            const current = props.current ?? rows[0]?.version;
            const fmt = props.formatAt ?? ((at: number) => new Date(at).toISOString());
            return (
                <section data-scope="ai-form" data-part="versions">
                    <Table.Root>
                            <Table.Caption>{props.caption ?? 'Configuration versions'}</Table.Caption>
                            <Table.Head>
                                <Table.Row>
                                    <Table.HeaderCell>Version</Table.HeaderCell>
                                    <Table.HeaderCell>When</Table.HeaderCell>
                                    <Table.HeaderCell>By</Table.HeaderCell>
                                    <Table.HeaderCell>Reason</Table.HeaderCell>
                                    <Table.HeaderCell>Actions</Table.HeaderCell>
                                </Table.Row>
                            </Table.Head>
                            <Table.Body>
                                {rows.map((v) => (
                                    <Table.Row key={v.version} selected={v.version === current}>
                                        <Table.Cell>v{v.version}</Table.Cell>
                                        <Table.Cell>
                                            <time dateTime={new Date(v.at).toISOString()}>{fmt(v.at)}</time>
                                        </Table.Cell>
                                        <Table.Cell>{v.by}</Table.Cell>
                                        <Table.Cell>{v.reason}</Table.Cell>
                                        <Table.Cell>
                                            {v.version === current ? (
                                                <Badge.Root color="primary">current</Badge.Root>
                                            ) : props.action ? (
                                                <form method="post" action={props.action} data-scope="ai-form" data-part="revert" onSubmit={(e) => { e.preventDefault(); emit('revert', v.version); }}>
                                                    <input type="hidden" name="version" value={String(v.version)} />
                                                    <Button.Root type="submit" size="sm" disabled={props.disabled}>
                                                        Revert to v{v.version}
                                                    </Button.Root>
                                                </form>
                                            ) : (
                                                <Button.Root type="button" size="sm" disabled={props.disabled} onClick={() => emit('revert', v.version)}>
                                                    Revert to v{v.version}
                                                </Button.Root>
                                            )}
                                        </Table.Cell>
                                    </Table.Row>
                                ))}
                            </Table.Body>
                    </Table.Root>
                </section>
            );
        },
    { name: 'ConfigVersions' }
);
