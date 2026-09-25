#!/usr/bin/env node
// Fails when an installer the build produced is over the budget (#848: the shell stays slim).
// Installers are what Tauri writes under a `bundle/` directory; the build's own executables are not.
//
//   node scripts/check-size.mjs <bundle dir> [max MB = 15]

import { readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

export const INSTALLER = /\.(msi|exe|dmg|AppImage|deb|rpm)$/;

export function installers(dir) {
    const out = [];
    const walk = (d) => {
        for (const name of readdirSync(d)) {
            const path = join(d, name);
            const st = statSync(path);
            // An .app bundle is a directory; the DMG that carries it is what is measured.
            if (st.isDirectory()) {
                if (!name.endsWith('.app')) walk(path);
            } else if (INSTALLER.test(name) && path.includes(`${sep}bundle${sep}`)) out.push({ path, bytes: st.size });
        }
    };
    walk(dir);
    return out;
}

/**
 * Formats that cannot meet the shell's budget by design, with their own ceiling. An AppImage carries
 * WebKitGTK and its libraries itself (~80 MB); the .deb and .rpm use the system's and stay small.
 */
export const FORMAT_BUDGET_MB = { AppImage: 100 };

export function budgetOf(path, maxMb) {
    const ext = /\.([^.]+)$/.exec(path)?.[1] ?? '';
    return FORMAT_BUDGET_MB[ext] ?? maxMb;
}

export function overBudget(files, maxMb) {
    return files.filter((f) => f.bytes > budgetOf(f.path, maxMb) * 1024 * 1024);
}

if (process.argv[1]?.endsWith('check-size.mjs')) {
    const [dir, max = '15'] = process.argv.slice(2);
    const files = installers(dir);
    if (!files.length) {
        console.error(`no installers under ${dir}`);
        process.exit(1);
    }
    for (const f of files) console.log(`${(f.bytes / 1024 / 1024).toFixed(1).padStart(6)} MB  ${f.path}`);
    const over = overBudget(files, Number(max));
    if (over.length) {
        console.error(`over budget (${max} MB; AppImage ${FORMAT_BUDGET_MB.AppImage} MB): ${over.map((f) => f.path).join(', ')}`);
        process.exit(1);
    }
}
