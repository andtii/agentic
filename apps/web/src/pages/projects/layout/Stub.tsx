import { component, type Define } from 'sigx';

/**
 * What a project page says until its issue lands (#725): "Coming in #N." Each page issue replaces its stub page and
 * this goes when the last one has (#767).
 */
export const Stub = component<Define.Prop<'issue', number, true>>(({ props }) => () => (
    <p data-stub={String(props.issue)} data-panel-note="">{`Coming in #${props.issue}.`}</p>
), { name: 'ProjectStub' });
