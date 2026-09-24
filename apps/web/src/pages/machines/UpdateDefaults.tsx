import { component, type Define } from 'sigx';
import type { UpdateSettings } from '@agentic/core';
import { ErrorNote } from '@agentic/ui';
import { UpdatePolicyForm, type UpdateChoice } from './UpdatePolicyForm';

/**
 * Settings → "Machine updates" (#367; OPS-03): the release channel and the
 * update policy every machine follows unless its own page sets one
 * (`WorkspaceSettings.updates`). Saved on its own — `updateSettings({ updates })`
 * — so the rest of the settings form is not in its way.
 */
export const UpdateDefaults = component<
    & Define.Prop<'value', UpdateSettings, true>
    & Define.Prop<'timeZone', string, true>
    & Define.Prop<'busy', boolean>
    /** "Saved." or why it was not. */
    & Define.Prop<'status', string>
    & Define.Prop<'failed', boolean>
    & Define.Event<'save', UpdateSettings>
>(({ props, emit }) => () => (
    <div data-update-defaults>
        <UpdatePolicyForm
            name="workspace-update"
            channel={props.value.defaultChannel}
            policy={props.value.defaultPolicy}
            timeZone={props.timeZone}
            busy={props.busy}
            onSave={(choice: UpdateChoice) => emit('save', { defaultChannel: choice.channel ?? props.value.defaultChannel, defaultPolicy: choice.policy ?? props.value.defaultPolicy })}
        />
        {props.status ? (props.failed ? <ErrorNote data-update-defaults-status="">{props.status}</ErrorNote> : <p data-update-defaults-status role="status">{props.status}</p>) : null}
    </div>
));
