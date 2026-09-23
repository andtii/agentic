/**
 * What a person reads for a Claude model (#517): `Fable 5.1`, `Opus 5.5 (1M context)`, `Haiku 4.5` — never the raw id.
 *
 * A full id (`claude-opus-5-5`, `claude-haiku-4-5-20251001`) carries its version. An alias (`opus`, `sonnet[1m]`,
 * `default`) does not, so the version comes from what the account says about it (Claude Code's `supportedModels()`
 * describes `opus` as `Opus 5.5 · …`); without one the family alone is shown. Anything else is its label, else its id.
 * Pure.
 */

import type { ModelOption } from '@agentic/core';

const FAMILIES = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'] as const;

const capital = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

/** `claude-opus-5-5` / `opus` → family and version (if the id names one); `null` for an id that is no Claude family. */
function parseId(id: string): { family: string; version?: string } | null {
    const m = /^(?:claude-)?([a-z]+)(?:-(\d+)(?:[-.](\d{1,2}))?)?(?:-\d{8})?$/.exec(id.toLowerCase());
    if (!m || !(FAMILIES as readonly string[]).includes(m[1]!)) return null;
    const version = m[2] ? (m[3] ? `${m[2]}.${m[3]}` : m[2]) : undefined;
    return { family: m[1]!, ...(version ? { version } : {}) };
}

/** The first `<Family> <version>` the account's text names (`Opus 5.5 · Most capable`), for `family` or any family. */
function namedIn(text: string | undefined, family?: string): string | undefined {
    if (!text) return undefined;
    const re = /\b(Fable|Mythos|Opus|Sonnet|Haiku) (\d+(?:\.\d+)?)\b/gi;
    for (const m of text.matchAll(re)) if (!family || m[1]!.toLowerCase() === family) return `${capital(m[1]!.toLowerCase())} ${m[2]}`;
    return undefined;
}

/** The model's display name; `option` is what the account reports for it (its label and description), when it does. */
export function modelDisplayName(id: string, option?: Pick<ModelOption, 'label' | 'description'>): string {
    const long = /\[1m\]$/i.test(id);
    const bare = long ? id.slice(0, -4) : id;
    const context = long ? ' (1M context)' : '';
    if (bare === 'default') {
        const current = namedIn(option?.description) ?? namedIn(option?.label);
        return current ? `Default (${current})` : 'Default';
    }
    const parsed = parseId(bare);
    if (!parsed) return option?.label || id;
    const named = parsed.version ? `${capital(parsed.family)} ${parsed.version}` : (namedIn(option?.description, parsed.family) ?? namedIn(option?.label, parsed.family) ?? capital(parsed.family));
    return named + context;
}
