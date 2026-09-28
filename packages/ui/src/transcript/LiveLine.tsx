/**
 * `LiveLine` — the 44 px row under the last turn while an agent works (`ai-live-line`, #1054;
 * `docs/design/chat-modes/HANDOFF.md` → "The turn"): a spinner, the agent (tile and name), its
 * current step, the time since `startedAt` in `working`, and `Stop` when the page can stop it. The
 * elapsed time ticks once a second while the line is mounted.
 */
import { component, onMounted, onUnmounted, type Define } from '@sigx/runtime-core';
import { AgentTile, type AgentHue } from '../kit/AgentTile.js';
import { Button } from '../kit/Button.js';
import { aiLiveLineAnatomy } from './anatomy.js';
import { formatStepDuration } from './step-model.js';

const SCOPE = aiLiveLineAnatomy.scope;

export type LiveLineProps =
    & Define.Prop<'agent', string, true>
    /** The agent's identity slot for its tile. */
    & Define.Prop<'hue', AgentHue, false>
    /** What it is doing now: `Edit · packages/ui/package.json`. */
    & Define.Prop<'step', string, false>
    /** When the work started (epoch ms). */
    & Define.Prop<'startedAt', number, true>
    /** Stop the agent; no button without it. */
    & Define.Prop<'onStop', () => void, false>;

/** Whole seconds under a minute, then `1m 12s`: the live line never shows tenths. */
export function formatElapsed(ms: number): string {
    return ms < 10_000 ? `${Math.max(0, Math.floor(ms / 1000))}s` : formatStepDuration(ms);
}

export const LiveLine = component<LiveLineProps>(({ props, signal }) => {
    const st = signal({ now: Date.now() });
    let timer: ReturnType<typeof setInterval> | undefined;
    onMounted(() => {
        timer = setInterval(() => {
            st.now = Date.now();
        }, 1000);
    });
    onUnmounted(() => clearInterval(timer));
    return () => (
        <div data-scope={SCOPE} data-part="root" role="status">
            <span data-scope={SCOPE} data-part="spinner" aria-hidden="true" />
            <span data-scope={SCOPE} data-part="agent">
                <AgentTile name={props.agent} hue={props.hue} size={20} />
                <span>{props.agent}</span>
            </span>
            <span data-scope={SCOPE} data-part="step" title={props.step}>{props.step ?? 'working'}</span>
            <span data-scope={SCOPE} data-part="elapsed">{formatElapsed(st.now - props.startedAt)}</span>
            {props.onStop && (
                <span data-scope={SCOPE} data-part="stop">
                    <Button intent="default" icon="stop" onClick={() => props.onStop?.()}>
                        Stop
                    </Button>
                </span>
            )}
        </div>
    );
}, { name: 'LiveLine' });
