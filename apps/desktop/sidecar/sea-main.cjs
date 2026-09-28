// The main script of the `agentic-node` single-executable (#991, scripts/sidecar.mjs). It stays tiny:
// the node's files live in the app's resources (`AGENTIC_NODE_APP`, set by src-tauri/src/node.rs;
// else `node/` beside the executable), where they can be read and updated like any files. A SEA's own
// `require` loads built-in modules only, so the launcher is loaded through `createRequire`.
'use strict';

const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');

const app = process.env.AGENTIC_NODE_APP || join(dirname(process.execPath), 'node');
const launcher = join(app, 'launch.cjs');
createRequire(launcher)(launcher);
