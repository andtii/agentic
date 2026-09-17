/**
 * The handoff's icon set: inline stroke SVG on a 24 grid, stroke 1.6, round
 * caps, `currentColor` — the exact geometry drawn on the artboards
 * (`docs/design/artboards/*.dc.html`). Sizes: 14 in captions, 15 to 17 in
 * buttons and nav, 20 on mobile and machine glyphs.
 *
 * Decorative by default (`aria-hidden`); pass `label` when the icon is the
 * only content of a control and there is no `aria-label` on the control.
 */
import { component, type Define, type JSXElement } from '@sigx/runtime-core';

const icons = {
    home: () => (<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></>),
    chats: () => <path d="M4 5h16v11H9l-5 4z" />,
    agents: () => (<><rect x="5" y="7" width="14" height="12" rx="2" /><path d="M12 3v4" /><path d="M9 12v2" /><path d="M15 12v2" /></>),
    machines: () => (<><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8" /><path d="M12 16v4" /></>),
    schedules: () => (<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
    history: () => (<><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 8v4l3 2" /></>),
    usage: () => (<><path d="M4 19V9" /><path d="M10 19V5" /><path d="M16 19v-7" /><path d="M22 19H2" /></>),
    plugins: () => (<><path d="M9 3v5" /><path d="M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>),
    settings: () => (<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></>),
    'chevron-right': () => <path d="m9 6 6 6-6 6" />,
    'chevron-down': () => <path d="m6 9 6 6 6-6" />,
    'chevron-left': () => <path d="m14 6-6 6 6 6" />,
    close: () => <path d="M6 6l12 12M18 6 6 18" />,
    plus: () => <path d="M12 5v14M5 12h14" />,
    download: () => (<><path d="M12 4v11" /><path d="m7 11 5 5 5-5" /><path d="M5 20h14" /></>),
    edit: () => <path d="M4 20h4L19 9l-4-4L4 16z" />,
    retire: () => (<><path d="M4 9h10a5 5 0 0 1 0 10H8" /><path d="m8 5-4 4 4 4" /></>),
    trash: () => (<><path d="M5 7h14" /><path d="M9 7V4h6v3" /><path d="M7 7l1 13h8l1-13" /></>),
    brain: () => (<><path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0V7a3 3 0 0 0-3-3z" /><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3" /></>),
    link: () => (<><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1" /><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" /></>),
    shield: () => <path d="M12 3 4 6v6c0 4.5 3.2 8 8 9 4.8-1 8-4.5 8-9V6z" />,
    search: () => (<><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>),
    delegate: () => (<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="9" r="2" /><path d="M6 7v10" /><path d="M18 11c0 4-6 3-6 6" /></>),
    file: () => (<><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>),
    terminal: () => (<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3" /><path d="M13 15h4" /></>),
    check: () => <path d="m5 12 5 5 9-10" />,
    attach: () => <path d="M20 11.5 12 19.5a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7" />,
    send: () => <path d="M4 12 20 4l-6 16-3-7z" />,
    stop: () => <rect x="6" y="6" width="12" height="12" rx="1.5" />,
    wifi: () => (<><path d="M3 9a14 14 0 0 1 18 0" /><path d="M6.5 12.5a9 9 0 0 1 11 0" /><path d="M10 16a4 4 0 0 1 4 0" /></>),
    key: () => (<><circle cx="8" cy="14" r="4" /><path d="m11 11 9-9" /><path d="m16 6 3 3" /></>),
    warning: () => (<><path d="M12 4 2.5 20h19z" /><path d="M12 10v4" /><path d="M12 17v.5" /></>),
    play: () => <path d="M7 5v14l12-7z" />,
    menu: () => <path d="M4 7h16M4 12h16M4 17h16" />
} satisfies Record<string, () => JSXElement>;

export type IconName = keyof typeof icons;
export const ICON_NAMES = Object.keys(icons) as IconName[];

export type IconProps =
    & Define.Prop<'name', IconName, true>
    /** Pixel size on both axes; 15 is the button and caption default. */
    & Define.Prop<'size', number>
    /** An accessible name — only when the icon carries meaning on its own. */
    & Define.Prop<'label', string>
    & Define.Prop<'class', string>;

export const Icon = component<IconProps>(({ props }) => () => {
    const size = props.size ?? 15;
    return (
        <svg
            data-icon={props.name}
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
            role={props.label ? 'img' : undefined}
            aria-label={props.label}
            aria-hidden={props.label ? undefined : 'true'}
            class={props.class}
            style="flex-shrink: 0"
        >
            {icons[props.name]()}
        </svg>
    );
}, { name: 'Icon' });
