/**
 * `SecretField` — one secret a plugin declares (`manifest.secrets`), WRITE
 * ONLY. The platform never hands a stored secret back, so the field shows
 * SET / NOT SET and offers Replace and Remove; it never shows a value.
 *
 * A secret must not leave the page any way but the `save` event:
 * - the input has NO `name`, so no form post can carry it — a submit before
 *   hydration would otherwise put it in a URL (a `<form>` without a working
 *   handler posts natively);
 * - the input is rendered DISABLED until the component has mounted, so
 *   nothing can be typed into markup that has no handler yet;
 * - its own form is `method="post"` and the handler always
 *   `preventDefault`s;
 * - the typed value is dropped the moment `save` is emitted — a failed write
 *   means pasting it again, never a secret kept in page state.
 * There is no no-JS path for secrets, on purpose. Do not nest this inside
 * another `<form>` (HTML drops the inner one): put it beside `SchemaForm`.
 */
import { component, onMounted, type Define } from '@sigx/runtime-core';
import { signal, watch } from '@sigx/reactivity';
import { Field, Input } from '@sigx/zero';
import { agSecretAnatomy } from '../kit/anatomy.js';
import { Button } from '../kit/Button.js';
import { StatusPill } from '../kit/StatusPill.js';

const SCOPE = agSecretAnatomy.scope;

export type SecretFieldProps =
    /** The secret's name (`PluginSecretDeclaration.name`) — stamped as `data-secret`, never a form `name`. */
    & Define.Prop<'name', string, true>
    & Define.Prop<'label', string, true>
    & Define.Prop<'description', string>
    /** Whether the Registry holds a value (`Registry.secrets()` lists names only). */
    & Define.Prop<'isSet', boolean, true>
    & Define.Prop<'required', boolean>
    & Define.Prop<'disabled', boolean>
    /** A write is in flight. */
    & Define.Prop<'saving', boolean>
    /** What the last write answered when it refused. */
    & Define.Prop<'error', string>
    & Define.Prop<'placeholder', string>
    /** The one way the value leaves the field. */
    & Define.Event<'save', string>
    & Define.Event<'remove', void>;

export const SecretField = component<SecretFieldProps>(
    ({ props, emit }) => {
        const st = signal({ mounted: false, value: '', replacing: false, removing: false });
        onMounted(() => {
            st.mounted = true;
        });
        // The write landed (or the secret went away elsewhere): back to the resting state.
        watch(
            () => props.isSet,
            () => {
                st.replacing = false;
                st.removing = false;
            }
        );

        const save = (e: Event) => {
            e.preventDefault();
            const value = st.value;
            if (!st.mounted || !value || props.disabled || props.saving) return;
            st.value = '';
            emit('save', value);
        };
        const cancel = () => {
            st.value = '';
            st.replacing = false;
        };
        const remove = () => {
            if (!st.removing) {
                st.removing = true;
                return;
            }
            st.removing = false;
            emit('remove');
        };

        return () => {
            const editing = !props.isSet || st.replacing;
            const busy = !!props.disabled || !!props.saving;
            return (
                <Field.Root invalid={!!props.error} required={props.required} disabled={props.disabled}>
                    <Field.Label>{props.label}</Field.Label>
                    <div data-scope={SCOPE} data-part="root" data-secret={props.name} data-set={props.isSet ? '' : undefined}>
                        <div data-scope={SCOPE} data-part="state">
                            {props.isSet ? <StatusPill status="set" label="SET" tone="live" /> : <StatusPill status="not-set" label="NOT SET" tone={props.required ? 'needs-you' : 'muted'} hollow />}
                            {props.isSet && !st.replacing ? (
                                <span data-scope={SCOPE} data-part="actions">
                                    <Button disabled={busy} onClick={() => { st.replacing = true; st.removing = false; }}>
                                        Replace
                                    </Button>
                                    <Button intent="danger" confirm={st.removing} disabled={busy} onClick={remove}>
                                        {st.removing ? 'Confirm remove' : 'Remove'}
                                    </Button>
                                </span>
                            ) : null}
                        </div>
                        {editing ? (
                            <form data-scope={SCOPE} data-part="editor" method="post" onSubmit={save}>
                                <Input.Root model={() => st.value} type="password" autocomplete="off" disabled={!st.mounted || busy}>
                                    <Input.Control>
                                        <Input.Input placeholder={props.placeholder ?? (props.isSet ? 'Paste the new value' : 'Paste the value')} />
                                    </Input.Control>
                                </Input.Root>
                                <Button type="submit" intent="primary" loading={props.saving} disabled={!st.mounted || busy || !st.value}>
                                    Save
                                </Button>
                                {props.isSet ? (
                                    <Button disabled={busy} onClick={cancel}>
                                        Cancel
                                    </Button>
                                ) : null}
                            </form>
                        ) : null}
                    </div>
                    {props.description ? <Field.Description>{props.description}</Field.Description> : null}
                    {props.error ? <Field.Error>{props.error}</Field.Error> : null}
                </Field.Root>
            );
        };
    },
    { name: 'SecretField' }
);
