import { render } from '@sigx/runtime-dom';
import type { JSXElement } from '@sigx/runtime-core';
import type { AgentConfig, AgentId, EnvironmentId } from '@agentic/core';
import type { SettingsFormValue } from '@agentic/ui';

/**
 * happy-dom's `new FormData(form)` gets a `<select multiple>` wrong twice: it takes only the first selected option,
 * and it posts the select while disabled. A browser posts every selected option of an enabled one (HTML:
 * constructing the entry list). zero's multiple Combobox posts through such a select, so the form tests read the
 * entry list a browser would build.
 */
const HappyFormData = globalThis.FormData;
class BrowserFormData extends HappyFormData {
    constructor(form?: HTMLFormElement, submitter?: HTMLElement | null) {
        super(form, submitter);
        if (!form) return;
        const multiples = [...form.elements].filter((el): el is HTMLSelectElement => el instanceof HTMLSelectElement && el.multiple && !!el.name);
        for (const name of new Set(multiples.map((el) => el.name))) this.delete(name);
        for (const el of multiples) {
            if (el.disabled || el.closest('fieldset:disabled')) continue;
            for (const o of el.options) if (o.selected && !o.disabled) this.append(el.name, o.value);
        }
    }
}
if (globalThis.FormData === HappyFormData) globalThis.FormData = BrowserFormData as typeof FormData;

/** Mount into a fresh container attached to the document (zero's ids and popovers need a live tree). */
export function mount(node: JSXElement): HTMLElement {
    const container = document.createElement('div');
    document.body.appendChild(container);
    render(node, container);
    return container;
}

export function setText(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function setSelect(el: HTMLSelectElement, value: string): void {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

export function toggle(el: HTMLInputElement, checked: boolean): void {
    el.checked = checked;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Let zero settle what it writes after a render. Its Select posts through a
 * hidden `<select>` whose option selectedness is written from `onUpdated`
 * (zero#145: happy-dom does not run the selectedness algorithm a real engine
 * runs on insert), so a posted value read straight after a mount or a
 * programmatic model write is stale until then.
 */
export function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The values a `<select>` offers, without the single-mode placeholder zero's hidden select always carries. */
export function optionValues(select: HTMLSelectElement): string[] {
    return [...select.options].map((o) => o.value).filter(Boolean);
}

/**
 * The control a person operates for `el`: zero's Select, Combobox and
 * ToggleGroup post through a visually-hidden, `aria-hidden` `<select>`; the
 * accessible control is the root's `combobox` (a Select's trigger, a
 * Combobox's input) or, for a group, the root itself. Every other element is
 * its own control.
 */
export function controlOf(el: HTMLElement): HTMLElement {
    if (!(el instanceof HTMLSelectElement) || el.dataset.part !== 'hidden-input') return el;
    const root = el.closest<HTMLElement>(`[data-scope="${el.dataset.scope}"][data-part="root"]`);
    return root?.querySelector<HTMLElement>('[role="combobox"]') ?? root ?? el;
}

/** Every visible form control inside `root`: real inputs, textareas and selects (a zero hidden `<select>` as its control), hidden inputs excluded. */
export function controls(root: HTMLElement): HTMLElement[] {
    return [...new Set([...root.querySelectorAll<HTMLElement>('input:not([type="hidden"]), textarea, select')].map(controlOf))];
}

/** The accessible name a control gets from `<label for>`, a wrapping `<label>` or `aria-label`/`aria-labelledby`. */
export function labelOf(target: HTMLElement): string {
    const el = controlOf(target);
    const own = el.getAttribute('aria-label');
    if (own) return own;
    const by = el.getAttribute('aria-labelledby');
    if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    const forLabel = el.id ? document.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`) : null;
    if (forLabel) return forLabel.textContent?.trim() ?? '';
    return el.closest('label')?.textContent?.trim() ?? '';
}

/** Ids from `aria-describedby` that resolve to an element with the given role. */
export function describedByRole(el: HTMLElement, role: string): HTMLElement[] {
    return (el.getAttribute('aria-describedby') ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id))
        .filter((d): d is HTMLElement => !!d && d.getAttribute('role') === role);
}

export function submit(form: HTMLFormElement): void {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

/** A fully populated, canonical config (see agent-model.ts for the canonical form). */
export function fullAgentConfig(): AgentConfig {
    return {
        name: 'Reviewer',
        description: 'Reviews pull requests',
        role: 'Code reviewer',
        instructions: 'Be terse.\nCite lines.',
        skills: [{ id: 'review' }, { id: '@acme/security', version: '2.1' }],
        tools: [{ name: 'Read' }, { name: 'Bash', mode: 'ask' }, { name: 'Delete', mode: 'deny' }],
        connectors: [{ id: 'github' }],
        approvalPolicy: [
            { id: 'category:write', match: { categories: ['write'] }, outcome: 'ask' },
            { id: 'category:destructive', match: { categories: ['destructive'] }, outcome: 'deny' },
            { id: 'rule-x', match: { tools: ['Bash'], source: 'mcp' }, outcome: 'ask', scope: 'session' }
        ],
        memoryPolicy: { shared: ['team', 'repo:agentic'], autoLearn: 'lessons' },
        execution: {
            runtime: 'claude-code',
            defaultEnvironmentId: 'env_1' as EnvironmentId,
            model: 'claude-opus-4',
            limits: { maxTurns: 20, maxCostUsd: 2.5, maxDepth: 2 },
            offlinePolicy: 'fail'
        },
        collaborators: ['agent_a' as AgentId, 'agent_b' as AgentId]
    };
}

export function fullSettings(): SettingsFormValue {
    return {
        timeZone: 'Europe/Stockholm',
        notifications: { kinds: { reminder: true, 'task-done': false, 'task-failed': true, approval: true, input: false, 'update-available': false, 'update-applied': false, 'update-failed': false, 'daemon-crash-loop': false, 'harness-update-available': false, 'resource-pressure': false, 'machine-security': false }, push: true },
        defaultEnvironmentId: 'env_1' as EnvironmentId
    };
}
