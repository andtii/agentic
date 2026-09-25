/**
 * Starter plans (#753): the phases and items a preset's `starter` setting seeds a project's first plan with. Plain
 * data — whoever creates the plan (the Plan actor, a person) turns each item title into a `PlanItem`.
 */

export interface PlanTemplatePhase {
    readonly title: string;
    readonly items: readonly string[];
}

export interface PlanTemplate {
    readonly id: string;
    readonly title: string;
    readonly phases: readonly PlanTemplatePhase[];
}

export const EVENT_DAY_TEMPLATE: PlanTemplate = {
    id: 'event-day',
    title: 'Event day',
    phases: [
        { title: 'Decide', items: ['Set the date and a rain date', 'Agree the budget', 'Draft the guest list', 'Book the venue'] },
        { title: 'Book', items: ['Book catering', 'Book music or entertainment', 'Order decorations', 'Arrange rentals (tables, chairs, tents)', 'Arrange transport and parking'] },
        { title: 'Invite', items: ['Send save-the-dates', 'Send invitations', 'Track RSVPs and dietary needs', 'Confirm numbers with catering'] },
        { title: 'Run', items: ['Write the day-of schedule', 'Brief helpers on their roles', 'Set up the venue', 'Welcome guests', 'Clear down the venue'] },
        { title: 'Wrap up', items: ['Settle the invoices', 'Send thank-you notes'] }
    ]
};

export const RELEASE_TEMPLATE: PlanTemplate = {
    id: 'release',
    title: 'Release',
    phases: [
        { title: 'Scope', items: ['List what the release holds', 'Cut what does not fit', 'Name an owner per item'] },
        { title: 'Build', items: ['Land the changes', 'Write the tests', 'Update the docs'] },
        { title: 'Check', items: ['Run the full suite', 'Try it end to end', 'Fix what the checks found'] },
        { title: 'Ship', items: ['Draft the release notes', 'Tag and publish', 'Announce it'] }
    ]
};

/** Every starter plan, by the `starter` setting that picks it. */
export const PLAN_TEMPLATES: Readonly<Record<string, PlanTemplate>> = {
    [EVENT_DAY_TEMPLATE.id]: EVENT_DAY_TEMPLATE,
    [RELEASE_TEMPLATE.id]: RELEASE_TEMPLATE
};

/** How many items a starter plan holds. */
export function planTemplateItemCount(template: PlanTemplate): number {
    return template.phases.reduce((n, p) => n + p.items.length, 0);
}
