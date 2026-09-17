import '@sigx/zero/css';
import '@agentic/ui/css';
import '@agentic/ui/layout.css';
import '@agentic/ui/shell.css';
import './styles.css';
import './styles/pages.css';
// Empty at runtime: augments `@sigx/zero`'s vocabulary with the theme, properties and per-scope axes.
import '@agentic/ui/register';
import { defineApp } from 'sigx';
import { ssrClientPlugin } from '@sigx/server-renderer/client';
import { installThemes } from '@agentic/ui/design-system';
import { App } from './App';
import { createAppRouter } from './router';

// Seed zero's theme registry with the design system's one theme before
// anything reads it. `<html data-theme="control-room">` is set in the
// document; the persisted choice (none in v1) would be restored before
// first paint by `themeInitScript` in <head>.
installThemes();

// Hydrate the server-rendered HTML in place. `hydrate()` is installed by
// ssrClientPlugin (declared optional on App, hence the `!`).
const app = defineApp(<App />);
app.use(createAppRouter());
app.use(ssrClientPlugin).hydrate!('#app');
