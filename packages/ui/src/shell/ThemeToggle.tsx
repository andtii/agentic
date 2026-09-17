import { component, type Define } from '@sigx/runtime-core';
import { Button, useTheme } from '@sigx/zero';

export type ThemeToggleProps = Define.Prop<'label', string>;

/**
 * Flips between the design system's light/dark pair. On the server the
 * controller comes from the app's `ThemeProvider`; in the browser it falls
 * back to zero's singleton. The label is scheme-independent on purpose:
 * the server cannot know the viewer's scheme, and a label that changed with
 * it would mismatch on hydration.
 */
export const ThemeToggle = component<ThemeToggleProps>(({ props }) => {
    const theme = useTheme();
    return () => (
        <Button variant="ghost" size="sm" onClick={() => theme.toggle()}>
            {props.label ?? 'Theme'}
        </Button>
    );
}, { name: 'ThemeToggle' });
