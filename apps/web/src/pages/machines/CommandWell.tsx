import { component, type Define } from 'sigx';
import { Button } from '@agentic/ui';

/** A command to run on the machine, with Copy — the Pair page's well, for the steps that stay local (#239). */
export const CommandWell = component<Define.Prop<'command', string, true>>(({ props }) => {
    // The clipboard can refuse (permissions, insecure context); a refused copy is not an error the page reports.
    const copy = (): void => { void navigator.clipboard?.writeText(props.command).catch(() => {}); };
    return () => (
        <div data-command-well>
            <span data-command-prompt aria-hidden="true">&gt;</span>
            <code>{props.command}</code>
            <Button intent="default" label={`Copy ${props.command}`} onClick={copy}>Copy</Button>
        </div>
    );
});
