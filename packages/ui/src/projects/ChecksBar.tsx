/**
 * `ChecksBar` — a pull request's checks as one bar: passed, running, failed, in proportion, with the count
 * (#725 stub; #726 draws it). Props are final.
 */
import { component, type Define } from '@sigx/runtime-core';
import type { PullCheck } from '@agentic/core';

export type ChecksBarProps =
    & Define.Prop<'checks', readonly PullCheck[], true>
    & Define.Prop<'class', string>;

export const ChecksBar = component<ChecksBarProps>(({ props }) => () => {
    const passed = props.checks.filter((c) => c.state === 'passed').length;
    return <span data-ag-project="checks-bar" class={props.class}>{`${passed}/${props.checks.length}`}</span>;
}, { name: 'ChecksBar' });
