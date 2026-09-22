/**
 * "Sign in…" on an environment row (#484): the runtime's own sign-in,
 * relayed from the machine — a link to open in any browser (and a paste
 * field when the runtime wants its code back), or a device code to enter
 * at a URL, the live phase, a failure with **Try again**, **Cancel**. The
 * page owns the round trip (`LiveMachine`); this is the view.
 */
import { component, signal, watch, type Define, type JSXElement } from 'sigx';
import { ConfirmDialog, TextField } from '@agentic/ui';
import { loginErrorText, loginPhaseText, type LoginView } from './login';

export type LoginDialogProps =
    & Define.Model<boolean>
    & Define.Prop<'machineName', string, true>
    & Define.Prop<'environmentName', string, true>
    & Define.Prop<'accountLabel', string, true>
    /** The sign-in as the platform reports it; `null` while the request is on its way. */
    & Define.Prop<'login', LoginView | null>
    /** A call is out (the buttons wait). */
    & Define.Prop<'busy', boolean>
    /** The pasted code, sent once. */
    & Define.Event<'answer', string>
    /** Start the sign-in again after a failure. */
    & Define.Event<'retry'>
    & Define.Event<'cancel'>;

export const LoginDialog = component<LoginDialogProps>(({ props, emit }) => {
    const ui = signal({ code: '', sent: false, attempted: false });
    watch(() => props.model?.value, (open) => { if (open) { ui.code = ''; ui.sent = false; ui.attempted = false; } });
    const send = (): void => {
        ui.attempted = true;
        const code = ui.code.trim();
        if (!code) return;
        ui.sent = true;
        emit('answer', code);
    };
    return (): JSXElement => {
        const login = props.login ?? null;
        const action = login?.action;
        const phase = login?.phase;
        const failed = phase === 'failed';
        const done = phase === 'done';
        const waitingPaste = !!action?.expectsPaste && (phase === 'action' || phase === 'waiting') && !ui.sent;
        return (
            <ConfirmDialog
                model={props.model}
                title={`Sign ${props.accountLabel} in on ${props.machineName}`}
                description={loginPhaseText(login, props.machineName)}
                confirmLabel={failed ? 'Try again' : waitingPaste ? 'Send code' : done ? 'Close' : 'Waiting…'}
                cancelLabel={done ? 'Close' : 'Cancel'}
                danger={false}
                busy={props.busy === true || (!failed && !waitingPaste && !done)}
                onConfirm={() => { if (failed) emit('retry'); else if (waitingPaste) send(); else if (done) emit('cancel'); }}
                onCancel={() => emit('cancel')}
            >
                <div data-login-body data-login-phase={phase ?? 'requesting'} data-login-kind={action?.kind}>
                    {action ? (
                        <div data-login-action>
                            {action.kind === 'device-code' && action.code ? <code data-login-code aria-label="Device code">{action.code}</code> : null}
                            <a href={action.url} target="_blank" rel="noopener noreferrer" data-login-url>{action.kind === 'device-code' ? 'Open the sign-in page' : 'Open the sign-in link'}</a>
                            <span data-login-url-text>{action.url}</span>
                        </div>
                    ) : null}
                    {waitingPaste ? (
                        <div onKeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}>
                            <TextField model={() => ui.code} name="login-code" label="Code from the sign-in page" required error={ui.attempted && !ui.code.trim() ? 'Paste the code the page showed you.' : undefined} disabled={props.busy} />
                        </div>
                    ) : null}
                    {ui.sent && !failed && !done ? <p data-env-note>Code sent — the runtime is checking it.</p> : null}
                    {phase === 'waiting' && !action?.expectsPaste ? <p data-env-note>Waiting for the runtime to see the sign-in…</p> : null}
                    {failed && login?.error ? <p data-env-failure role="alert">{loginErrorText(login.error)}</p> : null}
                    <p data-login-foot>The login stays on {props.machineName}; the platform only sees whether the account can authenticate.{action?.expectsPaste ? ' A pasted code is handed to the runtime once and kept nowhere.' : ''}</p>
                </div>
            </ConfirmDialog>
        );
    };
});
