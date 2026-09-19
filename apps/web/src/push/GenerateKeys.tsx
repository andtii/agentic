/**
 * "Generate keys" on Web Push's page (#244): a VAPID key pair made in this
 * browser with WebCrypto. The public half goes to `Registry.configure`, the
 * private half to `Registry.setSecret` — straight from the key pair, never
 * into page state, the DOM, a log or an error string. A new pair invalidates
 * every browser subscribed with the old one, so those subscriptions are
 * dropped from the Inbox and each browser subscribes again from Settings.
 */
import { component, signal, type Define, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import type { PluginView } from '@agentic/platform';
import { Button, Label } from '@agentic/ui';
import type { ActorDefs } from '../actors/defs';
import { inboxKeyOf, registryKeyOf } from '../actors/keys';
import { generateVapidKeys } from './browser';
import { VAPID_SECRET, canGenerateKeys } from './model';

export type GenerateKeysProps =
    & Define.Prop<'plugin', PluginView, true>
    & Define.Prop<'workspaceId', string, true>
    & Define.Prop<'hasKek', boolean, true>
    /** Whether the private key is already set (`overview().secretNames`). */
    & Define.Prop<'hasPrivateKey', boolean, true>
    & Define.Prop<'defs', Pick<ActorDefs, 'Registry' | 'Inbox'>, true>;

export const GenerateKeys = component<GenerateKeysProps>(({ props }) => {
    const st = signal({ busy: false, confirm: false, done: false, dropped: 0, error: '' });

    const generate = async (): Promise<void> => {
        const replacing = (typeof props.plugin.config.publicKey === 'string' && props.plugin.config.publicKey !== '') || props.hasPrivateKey;
        // Replacing a pair takes a second click: every subscribed browser has to subscribe again.
        if (replacing && !st.confirm) {
            st.confirm = true;
            return;
        }
        if (st.busy) return;
        st.busy = true;
        st.error = '';
        st.done = false;
        try {
            const registry = actor(props.defs.Registry, registryKeyOf(props.workspaceId));
            const keys = await generateVapidKeys();
            // The contact is required and already saved (`canGenerateKeys`), so this cannot be refused for it.
            await registry.configure(props.plugin.manifest.id, { ...props.plugin.config, publicKey: keys.publicKey });
            await registry.setSecret(VAPID_SECRET, keys.privateKey);
            let dropped = 0;
            if (replacing) {
                const inbox = actor(props.defs.Inbox, inboxKeyOf(props.workspaceId));
                // One call, one save, however many browsers there were.
                const endpoints = (await inbox.subscriptions()).map((s) => s.endpoint);
                if (endpoints.length > 0) dropped = Number(await inbox.unsubscribe(endpoints));
            }
            st.dropped = dropped;
            st.done = true;
        } catch (e) {
            // A Registry refusal names a scope or a path, never the key.
            st.error = e instanceof Error ? e.message : 'the keys could not be stored';
        } finally {
            st.busy = false;
            st.confirm = false;
        }
    };

    return (): JSXElement => {
        const can = canGenerateKeys(props.plugin, props.hasKek);
        return (
            <section data-plugin-panel="generate-keys" aria-label="Key pair">
                <Label>Key pair</Label>
                <p data-plugin-hint>
                    Makes a VAPID key pair in this browser. The public key is saved in the settings above; the private key is sealed as {VAPID_SECRET} and never shown.
                </p>
                <Button intent="primary" icon="key" confirm={st.confirm} loading={st.busy} disabled={!can.ok} onClick={() => { void generate(); }}>
                    {st.confirm ? 'Replace the keys — browsers subscribe again' : 'Generate keys'}
                </Button>
                {!can.ok ? <p data-plugin-hint>{can.why}</p> : null}
                {st.done ? <p data-plugin-saved role="status">{st.dropped ? `New keys saved. ${st.dropped} subscribed browser${st.dropped === 1 ? '' : 's'} removed — subscribe again in Settings.` : 'Keys saved. Subscribe a browser in Settings → Notifications.'}</p> : null}
                {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}
            </section>
        );
    };
}, { name: 'GenerateKeys' });
