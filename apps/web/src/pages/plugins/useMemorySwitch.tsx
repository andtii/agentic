/**
 * Making a plugin the active one of its slot (#243), out of `LivePlugin` so
 * the plugin pages share it (#628). A memory plugin holds data: `activate`
 * first asks the Registry's dry run (`previewActivation`) and opens the
 * confirmation with what moving keeps and drops; the memories move with
 * `activate(…, { migrate: true })` only once the owner confirms. Any other
 * slot is activated at once. Every call goes through the page's own `run`,
 * so busy and the error line stay the page's.
 */
import { signal, type JSXElement } from 'sigx';
import { actor } from '@sigx/actors';
import type { MemorySwitchReport, SlotKind } from '@agentic/platform';
import { ConfirmDialog } from '@agentic/ui';
import type { ActorDefs } from '../../actors/defs';
import { memorySwitchText } from './model';

export interface MemorySwitchOptions {
    readonly defs: Pick<ActorDefs, 'Registry'>;
    /** The page's guarded Registry call: skips while signed out or busy, records a refusal. */
    readonly run: (call: (key: string) => Promise<unknown>) => Promise<void>;
    /** Whether the page's call is in flight — the dialog's confirm button shows it. */
    readonly busy: () => boolean;
    /** A plugin's display name by id. */
    readonly nameOf: (id: string) => string;
    readonly agentName: (id: string) => string;
    /** After a plugin became active — the page re-reads its dependents. */
    readonly onActivated?: () => Promise<void> | void;
}

export interface MemorySwitch {
    /** Make `id` the active `kind` plugin; a memory plugin opens the dry-run confirmation instead. */
    activate(kind: SlotKind, id: string): Promise<void>;
    /** The memory move's confirmation, while one is open. */
    dialog(): JSXElement | null;
}

export function useMemorySwitch(options: MemorySwitchOptions): MemorySwitch {
    const { defs } = options;
    /** A memory plugin's dry run, while its confirmation is open (#243). */
    const move = signal<{ preview: MemorySwitchReport | null; id: string }>({ preview: null, id: '' });

    const activate = (kind: SlotKind, id: string): Promise<void> => options.run(async (k) => {
        // A memory plugin holds data: show what moving it keeps and drops, and move only on confirm.
        if (kind === 'memory') {
            move.id = id;
            move.preview = await actor(defs.Registry, k).previewActivation(kind, id);
            return;
        }
        await actor(defs.Registry, k).activate(kind, id);
        await options.onActivated?.();
    });
    const confirmMove = (): Promise<void> => options.run(async (k) => {
        try {
            await actor(defs.Registry, k).activate('memory', move.id, { migrate: true });
        } finally {
            move.preview = null;
        }
        await options.onActivated?.();
    });
    const dialog = (): JSXElement | null => {
        const report = move.preview;
        if (!report) return null;
        const text = memorySwitchText(report, options.nameOf, options.agentName);
        return (
            <ConfirmDialog
                model={() => move.preview !== null}
                title={text.title}
                description={text.description}
                {...(text.scopes.length ? { dependents: text.scopes, dependentsLabel: `Memories by scope · ${text.scopes.length}` } : {})}
                confirmLabel={text.confirmLabel}
                cancelLabel={`Keep ${options.nameOf(report.from)}`}
                danger={false}
                busy={options.busy()}
                onConfirm={() => { void confirmMove(); }}
                onCancel={() => { move.preview = null; }}
            />
        );
    };
    return { activate, dialog };
}
