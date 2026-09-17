import { component } from 'sigx';
import { Button, Card, Field, Input, NativeSelect } from '@sigx/zero-daisyui/components';
import { listThemes, useTheme } from '@sigx/zero';
import { Row, Stack } from '@agentic/ui';
import { Page } from '../components/Page';
import { ServerGreeting } from '../components/ServerGreeting';

/** `/settings` — workspace settings; theme picking exercises zero's theme registry. */
export const Settings = component(() => {
    const theme = useTheme();
    return () => (
        <Page title="Settings" subtitle="Workspace, credentials, appearance.">
            <Card>
                <Card.Header><Card.Title>Appearance</Card.Title></Card.Header>
                <Card.Body>
                    <Stack gap="md">
                        <Field>
                            <Field.Label>Theme</Field.Label>
                            <NativeSelect
                                placeholder="Follow the system"
                                options={listThemes().map(t => ({ value: t.name, label: `${t.name} (${t.colorScheme})` }))}
                                onValueChange={(v: string) => theme.setTheme(v ? (v as Parameters<typeof theme.setTheme>[0]) : null)}
                            />
                            <Field.Description>An explicit theme is remembered on this device.</Field.Description>
                        </Field>
                        <Row gap="sm">
                            <Button size="sm" onClick={() => theme.toggle()}>Toggle light/dark</Button>
                            <Button size="sm" variant="ghost" onClick={() => theme.setTheme(null)}>Follow the system</Button>
                        </Row>
                    </Stack>
                </Card.Body>
            </Card>
            <Card>
                <Card.Header><Card.Title>Credentials</Card.Title></Card.Header>
                <Card.Body>
                    <Field>
                        <Field.Label>Anthropic API key</Field.Label>
                        <Input type="password" autocomplete="off"><Input.Control><Input.Input placeholder="sk-ant-…" /></Input.Control></Input>
                        <Field.Description>Encrypted at rest with the deployment key. Mock — nothing is saved.</Field.Description>
                    </Field>
                </Card.Body>
            </Card>
            <Card>
                <Card.Header><Card.Title>Server</Card.Title></Card.Header>
                <Card.Body><ServerGreeting /></Card.Body>
            </Card>
        </Page>
    );
});
