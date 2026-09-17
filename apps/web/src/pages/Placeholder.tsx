import { component, type Define } from 'sigx';
import { Page } from '../components/Page';

/**
 * A route that exists in the nav before its page does: `/chats` (#88),
 * `/history` and `/usage` (#90). Each page issue replaces its use of this.
 */
export const Placeholder = component<Define.Prop<'title', string, true> & Define.Prop<'issue', number, true>>(({ props }) => {
    return () => <Page title={props.title} subtitle={`This page lands with #${props.issue}.`} />;
});

export const Chats = component(() => () => <Placeholder title="Chats" issue={88} />);
export const History = component(() => () => <Placeholder title="History" issue={90} />);
export const Usage = component(() => () => <Placeholder title="Usage" issue={90} />);
