import { component } from 'sigx';
import { Badge, Card, Switch } from '@sigx/zero-daisyui/components';
import { Row, Spacer, Stack } from '@agentic/ui';
import { Page } from '../components/Page';
import { plugins } from '../mock/data';

/** `/plugins` — in-repo modules, enabled per workspace. */
export const Plugins = component(() => {
    return () => (
        <Page title="Plugins" subtitle="Registered at build time; enable or disable per workspace.">
            <Stack gap="md">
                {plugins.map(p => (
                    <Card>
                        <Card.Body>
                            <Row gap="md">
                                <Stack gap="2xs">
                                    <strong>{p.name}</strong>
                                    <Badge size="sm" color="neutral">{p.kind}</Badge>
                                </Stack>
                                <Spacer />
                                <Switch defaultChecked={p.enabled}>{p.enabled ? 'Enabled' : 'Disabled'}</Switch>
                            </Row>
                        </Card.Body>
                    </Card>
                ))}
            </Stack>
        </Page>
    );
});
