import { component, effect, onMounted, onUnmounted, signal, type Define } from 'sigx';
import { Countdown } from '@sigx/zero';
import { Button, Icon, Label } from '@agentic/ui';
import { pairing } from '../mock/ops';
import { dataMode } from '../data-mode';
import { LivePair } from './machines/LivePair';
import type { InstallLine } from './machines/live';
import { mmss } from './ops/format';
import { LinkButton } from './ops/LinkButton';
import { OpsPage } from './ops/OpsPage';
import { defineTopbar } from '../components/topbar';

/** The code's lifetime: the countdown starts at 10:00. */
export const CODE_LIFETIME = 600;

export type PairViewProps =
    & Define.Prop<'code', string, true>
    /** Seconds left when the page opens. */
    & Define.Prop<'expiresIn', number, true>
    /** The one-line installer per OS (#343): each its own well with Copy. */
    & Define.Prop<'install', readonly InstallLine[], true>
    & Define.Prop<'grants', readonly string[], true>
    /** The step-2 command; `agentic-daemon pair <code>` unless given (the live page adds `--url` and `--name`). */
    & Define.Prop<'command', string>
    /** Above the step-2 command: the live page's machine-name field. */
    & Define.Slot<'name'>
    /**
     * "New code" after expiry: with a listener the platform mints a fresh code and the
     * page restarts when `code` / `expiresIn` change; without one the same code restarts the clock.
     */
    & Define.Prop<'onRenew', () => void>;

/**
 * `/pair` — three numbered steps: install the daemon, enter the six
 * character code there, name its environments. The code is six 64 × 80
 * cells in mono 40 / 600; the countdown runs from what is left of 10:00,
 * and at zero the cells go dim and "New code" replaces the waiting line
 * (`docs/design/HANDOFF.md` → Pair, Edge cases).
 */
defineTopbar('pair', () => ({ crumb: 'Pair a machine', actions: () => <LinkButton to="/machines">Cancel</LinkButton> }));

export const PairView = component<PairViewProps>(({ props, slots }) => {
    const state = signal({ remaining: props.expiresIn, code: props.code });
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
        if (timer) clearInterval(timer);
        timer = undefined;
    };
    const start = () => {
        stop();
        if (state.remaining <= 0) return;
        timer = setInterval(() => {
            state.remaining = Math.max(0, state.remaining - 1);
            if (state.remaining === 0) stop();
        }, 1000);
    };
    onMounted(start);
    onUnmounted(stop);
    // A new code from the platform (#144) lands as new props: the cells and the clock follow.
    let first = true;
    const follow = effect(() => {
        const code = props.code;
        const expiresIn = props.expiresIn;
        if (first) {
            first = false;
            return;
        }
        state.code = code;
        state.remaining = expiresIn;
        start();
    });
    onUnmounted(follow);
    // With nobody minting, the same sample code restarts the clock (the mock page).
    const renew = () => {
        if (props.onRenew) {
            props.onRenew();
            return;
        }
        state.code = props.code;
        state.remaining = CODE_LIFETIME;
        start();
    };
    // The clipboard can refuse (permissions, insecure context); a refused copy is not an error the page reports.
    const copy = (text: string) => { navigator.clipboard?.writeText(text).catch(() => {}); };

    return () => {
        const expired = state.remaining <= 0;
        const pairCommand = props.command ?? `agentic-daemon pair ${state.code}`;
        return (
            <OpsPage page="pair" title="Pair a machine" hero>
                <div data-pair-grid>
                    <ol data-pair-steps>
                        <li data-pair-step data-phase="complete">
                            <span data-step-marker aria-hidden="true"><Icon name="check" size={14} /></span>
                            <div data-step-body>
                                <h2 data-step-title>Install the daemon on the machine</h2>
                                <p data-step-note>One line per OS — it downloads the daemon (and Node when the machine has none), pairs with the code below and keeps the daemon running in the background. Re-run it later to upgrade.</p>
                                {props.install.map((line) => (
                                    <div data-install-line key={line.os}>
                                        <Label>{line.os}</Label>
                                        <div data-command-well>
                                            <span data-command-prompt aria-hidden="true">&gt;</span>
                                            <code>{line.command}</code>
                                            <Button intent="default" label={`Copy the ${line.os} install line`} onClick={() => copy(line.command)}>Copy</Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </li>
                        <li data-pair-step data-phase="active">
                            <span data-step-marker aria-hidden="true">2</span>
                            <div data-step-body>
                                <h2 data-step-title>Enter this code there</h2>
                                {slots.name ? <div data-pair-name>{slots.name()}</div> : null}
                                <div data-command-well>
                                    <span data-command-prompt aria-hidden="true">&gt;</span>
                                    <code>{pairCommand}</code>
                                    <Button intent="default" onClick={() => copy(pairCommand)}>Copy</Button>
                                </div>
                                <div data-code-cells role="img" aria-label={`Pairing code ${state.code}`} data-expired={expired ? '' : undefined}>
                                    {state.code.split('').map(ch => <span data-code-cell>{ch}</span>)}
                                </div>
                                {expired ? (
                                    <div data-code-status data-expired="">
                                        <span>The code expired.</span>
                                        <Button intent="primary" onClick={renew}>New code</Button>
                                    </div>
                                ) : (
                                    <p data-code-status>
                                        <span data-code-dot aria-hidden="true" />
                                        <span>Waiting for the daemon · code expires in </span>
                                        <Countdown.Root label="Code expires in">
                                            <Countdown.Value value={Math.floor(state.remaining / 60)} digits={2} />
                                            <span aria-hidden="true">:</span>
                                            <Countdown.Value value={state.remaining % 60} digits={2} />
                                        </Countdown.Root>
                                        <span data-visually-hidden="">{mmss(state.remaining)}</span>
                                        <span> · single use</span>
                                    </p>
                                )}
                            </div>
                        </li>
                        <li data-pair-step data-phase="inactive">
                            <span data-step-marker aria-hidden="true">3</span>
                            <div data-step-body>
                                <h2 data-step-title>Name its environments</h2>
                                <p data-step-hint>The daemon reports the runtimes and accounts it finds. You choose which agents default to them.</p>
                            </div>
                        </li>
                    </ol>
                    <aside data-pair-rail>
                        <section data-card aria-label="What pairing grants">
                            <div data-label-row><Label>What pairing grants</Label></div>
                            {props.grants.map(text => <p data-card-text>{text}</p>)}
                        </section>
                    </aside>
                </div>
            </OpsPage>
        );
    };
});

/** `/pair`: a code minted by the Workspace on the platform (`LivePair`, #144), or the sample code. */
export const Pair = component(() => () => (dataMode() === 'live' ? <LivePair /> : <PairView code={pairing.code} expiresIn={pairing.expiresIn} install={pairing.install} grants={pairing.grants} />));
