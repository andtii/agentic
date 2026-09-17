/**
 * `ApprovalPrompt` — an open permission request as four decisions
 * (`ai-approval`): allow or deny, once or for the session. The buttons are
 * zero's `Button`, so the adopting design system's own button recipe paints
 * them; this scope owns only the box, the title and the reason.
 *
 * The decision goes out exactly as `session.respond()` takes it: a
 * `session`-scoped allow is remembered under the request's `permissionKey`,
 * so the same call is never asked twice; a deny carries a message the model
 * reads.
 */
import { component, type Define } from '@sigx/runtime-core';
import { Button } from '@sigx/zero';
import type { Decision, OpenRequest } from '@sigx/ai-agent/app';
import { aiApprovalAnatomy } from './anatomy.js';
import { nonBlank } from './text.js';

const SCOPE = aiApprovalAnatomy.scope;

export type RespondFn = (requestId: string, decision: Decision) => void;

export type ApprovalPromptProps =
    & Define.Prop<'request', OpenRequest, true>
    & Define.Prop<'onRespond', RespondFn, true>
    /** The tool's name when the request carries none (a card knows its part). */
    & Define.Prop<'toolName', string, false>;

export const DENY_MESSAGE = 'The operator denied this call.';

export const ApprovalPrompt = component<ApprovalPromptProps>(({ props }) => {
    const decide = (outcome: 'allow' | 'deny', scope: 'once' | 'session'): void => {
        props.onRespond(props.request.requestId, {
            type: 'permission',
            outcome,
            scope,
            ...(outcome === 'deny' ? { message: DENY_MESSAGE } : {})
        });
    };

    return () => {
        const request = props.request;
        const name = request.toolName ?? props.toolName ?? 'this tool';
        const why = nonBlank(request.message);
        return (
            <div data-scope={SCOPE} data-part="root" role="group" aria-label={`Allow ${name}?`}>
                <p data-scope={SCOPE} data-part="title">
                    Allow <code>{name}</code>?
                </p>
                {why && <p data-scope={SCOPE} data-part="description">{why}</p>}
                <div data-scope={SCOPE} data-part="actions">
                    <Button.Root type="button" size="sm" onClick={() => decide('allow', 'once')}>Allow once</Button.Root>
                    <Button.Root type="button" size="sm" color="primary" onClick={() => decide('allow', 'session')}>Allow for session</Button.Root>
                    <Button.Root type="button" size="sm" onClick={() => decide('deny', 'once')}>Deny once</Button.Root>
                    <Button.Root type="button" size="sm" color="error" onClick={() => decide('deny', 'session')}>Deny for session</Button.Root>
                </div>
            </div>
        );
    };
}, { name: 'ApprovalPrompt' });
