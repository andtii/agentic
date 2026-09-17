import { component } from 'sigx';
import { Card, Kbd, Steps } from '@sigx/zero-daisyui/components';
import { Stack } from '@agentic/ui';
import { Page } from '../components/Page';

/** `/pair` — pair a machine's daemon with this workspace. */
export const Pair = component(() => {
    return () => (
        <Page title="Pair a machine" subtitle="Run the daemon on a machine and confirm the code it shows.">
            <Steps defaultStep="install" label="Pairing">
                <Steps.Item value="install"><Steps.Indicator /><Steps.Title>Install</Steps.Title><Steps.Separator /></Steps.Item>
                <Steps.Item value="code"><Steps.Indicator /><Steps.Title>Enter the code</Steps.Title><Steps.Separator /></Steps.Item>
                <Steps.Item value="done"><Steps.Indicator /><Steps.Title>Done</Steps.Title></Steps.Item>
            </Steps>
            <Card>
                <Card.Body>
                    <Stack gap="sm">
                        <p>On the machine, run:</p>
                        <pre><code>npx agentic-daemon pair</code></pre>
                        <p>Then enter the six-character code it prints, e.g. <Kbd>Q7M-4KD</Kbd>. Mock — no pairing happens yet.</p>
                    </Stack>
                </Card.Body>
            </Card>
        </Page>
    );
});
