/**
 * `EnvironmentCard` — one execution environment as the user must be able
 * to see it (EXE-06): runtime, account (and its auth status), machine (and
 * whether it is online), concurrency and isolation. `environmentStatus`
 * folds those signals into one state the card stamps as `data-state`.
 */

import { component, type Define } from '@sigx/runtime-core';
import { Badge, Button, Card, Status } from '@sigx/zero';
import type { EnvironmentDescriptor, EnvironmentId, MachineInfo } from '@agentic/core';

export type EnvironmentState = 'ready' | 'busy' | 'offline' | 'auth-missing' | 'auth-expired' | 'auth-unknown';

export interface EnvironmentStatus {
    readonly state: EnvironmentState;
    readonly label: string;
    readonly color: 'success' | 'warning' | 'error' | 'neutral';
}

/** Machine offline beats auth, auth beats capacity: the first thing the user has to fix comes first. */
export function environmentStatus(env: EnvironmentDescriptor, machine?: MachineInfo): EnvironmentStatus {
    if (machine && !machine.online) return { state: 'offline', label: 'Machine offline', color: 'neutral' };
    switch (env.account.authStatus) {
        case 'missing':
            return { state: 'auth-missing', label: 'Not signed in', color: 'error' };
        case 'expired':
            return { state: 'auth-expired', label: 'Sign-in expired', color: 'error' };
        case 'unknown':
            return { state: 'auth-unknown', label: 'Sign-in status unknown', color: 'warning' };
        default:
            break;
    }
    const { active, max } = env.concurrency;
    if (active >= max) return { state: 'busy', label: `Busy (${active}/${max})`, color: 'warning' };
    return { state: 'ready', label: 'Ready', color: 'success' };
}

export type EnvironmentCardProps = Define.Prop<'environment', EnvironmentDescriptor, true> &
    Define.Prop<'machine', MachineInfo> &
    Define.Prop<'selected', boolean> &
    /** Renders a select button with this text; `select` fires with the environment id. */
    Define.Prop<'selectLabel', string> &
    Define.Prop<'disabled', boolean> &
    Define.Event<'select', EnvironmentId>;

export const EnvironmentCard = component<EnvironmentCardProps>(
    ({ props, emit }) =>
        () => {
            const env = props.environment;
            const machine = props.machine;
            const status = environmentStatus(env, machine);
            return (
                <article data-scope="ai-form" data-part="environment" data-state={status.state} data-selected={props.selected ? '' : undefined}>
                    <Card.Root>
                        <Card.Header>
                            <Card.Title>{env.name}</Card.Title>
                            <span data-scope="ai-form" data-part="environment-status">
                                <Status.Root color={status.color} />
                                <span>{status.label}</span>
                            </span>
                        </Card.Header>
                        <Card.Body>
                            <dl data-scope="ai-form" data-part="facts">
                                <dt>Runtime</dt>
                                <dd>{env.runtime}</dd>
                                <dt>Account</dt>
                                <dd>
                                    {env.account.label}
                                    {env.account.identity ? ` (${env.account.identity})` : ''} <Badge.Root color={status.color}>{env.account.authStatus}</Badge.Root>
                                </dd>
                                <dt>Machine</dt>
                                <dd>
                                    {machine?.name ?? env.machineId}
                                    {machine ? (machine.online ? ' — online' : ' — offline') : ''}
                                </dd>
                                <dt>Concurrency</dt>
                                <dd>
                                    {env.concurrency.active} of {env.concurrency.max}
                                </dd>
                                <dt>Isolation</dt>
                                <dd>{env.isolation}</dd>
                                {env.cwdRoots.length ? (
                                    <>
                                        <dt>Working roots</dt>
                                        <dd>{env.cwdRoots.join(', ')}</dd>
                                    </>
                                ) : null}
                            </dl>
                        </Card.Body>
                        {props.selectLabel ? (
                            <Card.Footer>
                                <Button.Root type="button" size="sm" disabled={props.disabled || props.selected} onClick={() => emit('select', env.id)}>
                                    {props.selectLabel}
                                </Button.Root>
                            </Card.Footer>
                        ) : null}
                    </Card.Root>
                </article>
            );
        },
    { name: 'EnvironmentCard' }
);
