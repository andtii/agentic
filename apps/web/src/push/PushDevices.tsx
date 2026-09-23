/**
 * Settings → Notifications, the push half (#244): whether Web Push is set up
 * for the workspace, this browser's subscription (subscribe asks for the
 * browser's permission, then `Inbox.subscribe`; stop is the reverse), and
 * every subscribed browser with a Remove. Subscribing a browser is what turns
 * push on for it; the workspace's plugin page holds the keys.
 *
 * "Turn on push notifications" (#543) does the whole setup in one click:
 * enables the plugin, makes the key pair when there is none (a contact
 * defaults to the app's address) and subscribes this browser. A second
 * browser reuses the pair, so the ones already subscribed keep their pushes.
 */
import { component, onMounted, signal, type JSXElement } from 'sigx';
import { Link } from '@sigx/router';
import { actor } from '@sigx/actors';
import { useActorState } from '@sigx/actors/app';
import { Button, Icon } from '@agentic/ui';
import { useActorDefs, useViewer } from '../actors/defs';
import { inboxKeyOf, registryKeyOf } from '../actors/keys';
import { formatAge } from '../mock/workspace';
import { pluginHref } from '../pages/plugins/model';
import { currentEndpoint, pushSupport, subscribeBrowser, unsubscribeBrowser, type PushSupport } from './browser';
import { VAPID_SECRET, WEB_PUSH_PLUGIN, canGenerateKeys, deviceRows, pushSetup } from './model';
import { ensurePushKeys } from './setup';

export const PushDevices = component(() => {
    const defs = useActorDefs();
    const viewer = useViewer()();
    const overview = useActorState(defs.Registry, () => (viewer.workspaceId ? ([registryKeyOf(viewer.workspaceId), 'overview'] as const) : null), { live: true });
    const subscriptions = useActorState(defs.Inbox, () => (viewer.workspaceId ? ([inboxKeyOf(viewer.workspaceId), 'subscriptions'] as const) : null), { live: true });
    // Client only: the server render knows nothing of this browser.
    const st = signal<{ support: PushSupport | null; here: string | null; busy: boolean; error: string }>({ support: null, here: null, busy: false, error: '' });
    onMounted(() => {
        st.support = pushSupport();
        void currentEndpoint().then((e) => { st.here = e; }, () => {});
    });

    const inbox = () => (viewer.workspaceId ? actor(defs.Inbox, inboxKeyOf(viewer.workspaceId)) : null);
    const run = async (step: () => Promise<void>): Promise<void> => {
        if (st.busy) return;
        st.busy = true;
        st.error = '';
        try {
            await step();
        } catch (e) {
            st.error = e instanceof Error ? e.message : String(e);
        } finally {
            st.busy = false;
        }
    };
    const subscribe = (publicKey: string) => run(async () => {
        const box = inbox();
        if (!box) return;
        const sub = await subscribeBrowser(publicKey);
        await box.subscribe(sub);
        st.here = sub.endpoint;
    });
    const stopHere = () => run(async () => {
        const endpoint = await unsubscribeBrowser();
        if (endpoint) await inbox()?.unsubscribe(endpoint);
        st.here = null;
    });
    /** Everything push still needs, then this browser — when it can take push at all. */
    const turnOn = () => run(async () => {
        const o = overview.value;
        const workspaceId = viewer.workspaceId;
        if (!o || !workspaceId) return;
        const plugin = o.plugins.find((p) => p.manifest.id === WEB_PUSH_PLUGIN);
        if (!plugin) return;
        const registry = actor(defs.Registry, registryKeyOf(workspaceId));
        const publicKey = await ensurePushKeys(registry, plugin, o.secretNames.includes(VAPID_SECRET), location.origin);
        if (!plugin.enabled) await registry.enable(WEB_PUSH_PLUGIN);
        if (st.support !== 'supported') return;
        const sub = await subscribeBrowser(publicKey);
        await actor(defs.Inbox, inboxKeyOf(workspaceId)).subscribe(sub);
        st.here = sub.endpoint;
    });
    const remove = (endpoint: string) => run(async () => {
        if (endpoint === st.here) await unsubscribeBrowser();
        await inbox()?.unsubscribe(endpoint);
        if (endpoint === st.here) st.here = null;
    });

    return (): JSXElement => {
        const o = overview.value;
        if (!o) return <p data-panel-note aria-busy="true">Loading push…</p>;
        const setup = pushSetup(o.plugins, o.secretNames);
        const rows = deviceRows(subscriptions.value ?? [], st.here);
        const here = rows.some((r) => r.here);
        const can = canGenerateKeys(o.hasKek);
        return (
            <div data-push-devices data-push-state={setup.state}>
                {setup.state === 'absent'
                    ? <p data-panel-note>This deployment ships no push channel.</p>
                    : setup.state !== 'ready'
                        ? (
                            <div data-push-setup>
                                <p data-panel-note>
                                    {setup.state === 'off' ? 'Push is off for this workspace. ' : `Push needs ${setup.missing.join(', ')}. `}
                                    {can.ok ? 'One click sets it up — no keys to find.' : can.why}
                                </p>
                                {can.ok ? <Button intent="primary" icon="wifi" loading={st.busy} onClick={() => { void turnOn(); }}>Turn on push notifications</Button> : null}
                                <Link to={pluginHref(WEB_PUSH_PLUGIN)}>Advanced settings</Link>
                            </div>
                        )
                        : st.support === 'unsupported'
                            ? <p data-panel-note>This browser cannot take push notifications.</p>
                            : st.support === 'insecure'
                                ? <p data-panel-note>Push needs a secure (https) connection.</p>
                                : (
                                    <div data-push-here>
                                        {here
                                            ? <Button intent="default" icon="wifi" loading={st.busy} disabled={st.support === null} onClick={() => { void stopHere(); }}>Stop push on this browser</Button>
                                            : <Button intent="primary" icon="wifi" loading={st.busy} disabled={st.support === null} onClick={() => { void subscribe(setup.publicKey); }}>Get push on this browser</Button>}
                                    </div>
                                )}
                {rows.length ? (
                    <ul data-push-list aria-label="Subscribed browsers">
                        {rows.map((r) => (
                            <li data-push-device={r.here ? 'here' : ''}>
                                <Icon name="wifi" size={15} />
                                <span data-push-label>{r.label}{r.here ? ' (this browser)' : ''}</span>
                                <span data-push-added>{formatAge(r.addedAt, Date.now())}</span>
                                <Button intent="default" disabled={st.busy} label={`Remove ${r.label}`} onClick={() => { void remove(r.endpoint); }}>Remove</Button>
                            </li>
                        ))}
                    </ul>
                ) : null}
                {st.error ? <p data-chat-error role="alert">{st.error}</p> : null}
            </div>
        );
    };
}, { name: 'PushDevices' });
