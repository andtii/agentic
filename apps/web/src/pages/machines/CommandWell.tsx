import { component, type Define, type JSXElement } from 'sigx';
import { Button } from '@agentic/ui';

/**
 * A command to run on the machine, with Copy — the Pair page's well, for the steps that stay local (#239).
 * `fallback` is the same command spelled out for a daemon whose installer never wrote the
 * `agentic-daemon` launcher (#354): folded away until the short one says "command not found".
 */
export const CommandWell = component<Define.Prop<'command', string, true> & Define.Prop<'fallback', string>>(({ props }) => {
    // The clipboard can refuse (permissions, insecure context); a refused copy is not an error the page reports.
    const copy = (text: string) => (): void => { void navigator.clipboard?.writeText(text).catch(() => {}); };
    const well = (command: string): JSXElement => (
        <div data-command-well>
            <span data-command-prompt aria-hidden="true">&gt;</span>
            <code>{command}</code>
            <Button intent="default" label={`Copy ${command}`} onClick={copy(command)}>Copy</Button>
        </div>
    );
    return () => (
        <>
            {well(props.command)}
            {props.fallback ? (
                <details data-command-fallback>
                    <summary>“command not found”?</summary>
                    <p data-command-fallback-text>That machine was set up before the installer added the command. Run this instead, or re-run the installer from the Pair page to get it:</p>
                    {well(props.fallback)}
                </details>
            ) : null}
        </>
    );
});
