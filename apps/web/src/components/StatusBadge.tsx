import { component, type Define } from 'sigx';
import { Badge } from '@sigx/zero-daisyui/components';

type Role = 'primary' | 'secondary' | 'accent' | 'neutral' | 'info' | 'success' | 'warning' | 'error';

const ROLE: Record<string, Role> = {
    idle: 'neutral', busy: 'info', offline: 'warning',
    queued: 'neutral', running: 'info', done: 'success', failed: 'error', blocked: 'warning',
    interrupted: 'warning', error: 'error',
    approval: 'warning', mention: 'info'
};

/** A status word as a coloured badge — one mapping, every page. */
export const StatusBadge = component<Define.Prop<'status', string, true>>(({ props }) => {
    return () => <Badge color={ROLE[props.status] ?? 'neutral'} size="sm">{props.status}</Badge>;
});
