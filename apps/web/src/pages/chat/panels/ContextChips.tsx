/**
 * The chat panel's **Project context** card (#940; HANDOFF "Chat context" slot): one chip per enabled feature that
 * adds a ref prefix to the chat — `Plan #`, `Git pr:`. A chip puts its prefix into the composer, where the popup then
 * lists that feature's refs. Renders nothing outside a project, or when no enabled feature adds a prefix.
 */
import { component, type Define } from 'sigx';
import { Label } from '@agentic/ui';
import type { ContextChip } from '../project-context';

/** The chips' look reuses the Requests chip (`data-requests-chip`); these keep the list a wrapping row of buttons. */
const LIST = { listStyle: 'none', margin: '0', padding: '0', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-xs)' };
const CHIP = { background: 'transparent', cursor: 'pointer' };

export type ContextChipsProps = Define.Prop<'chips', readonly ContextChip[], true> & Define.Event<'insert', string>;

export const ContextChips = component<ContextChipsProps>(({ props, emit }) => () =>
    props.chips.length ? (
        <section data-context-section data-context-chips="" aria-label="Project context">
            <header data-context-head>
                <Label>Project context</Label>
            </header>
            <ul data-context-chip-list style={LIST}>
                {props.chips.flatMap((chip) => chip.prefixes.map((prefix) => (
                    <li key={`${chip.featureId}:${prefix}`}>
                        <button type="button" data-context-chip={chip.featureId} data-requests-chip="" style={CHIP} title={`Link ${chip.label} in the message: type ${prefix}`} onClick={() => emit('insert', prefix)}>
                            <span>{chip.label}</span>{' '}
                            <code>{prefix}</code>
                        </button>
                    </li>
                )))}
            </ul>
        </section>
    ) : null, { name: 'ContextChips' });
