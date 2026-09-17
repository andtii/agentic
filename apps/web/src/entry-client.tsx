import '@sigx/zero/css';
import '@sigx/zero-daisyui/css';
import '@agentic/ui/layout.css';
import '@agentic/ui/shell.css';
import './styles.css';
import '@sigx/zero-daisyui/register';
import { defineApp } from 'sigx';
import { ssrClientPlugin } from '@sigx/server-renderer/client';
import { installThemes } from '@sigx/zero-daisyui';
import { App } from './App';
import { createAppRouter } from './router';

// Seed zero's theme registry with the design system's themes before anything
// reads it (the shell's toggle). The persisted choice was restored before
// first paint by `themeInitScript` in <head>.
installThemes();

// Hydrate the server-rendered HTML in place. `hydrate()` is installed by
// ssrClientPlugin (declared optional on App, hence the `!`).
const app = defineApp(<App />);
app.use(createAppRouter());
app.use(ssrClientPlugin).hydrate!('#app');
