/**
 * The chat's header (#1058; `docs/design/chat-modes/screenshots/ChatFocus.png`): the title with a note
 * under it naming the rule that chose the view, then the `VIEW` (`Focus | Team | Lanes`) and `DETAIL`
 * (`Messages | Steps | Raw`) controls. Choosing a view pins it; `Auto` (shown while pinned) lets the chat
 * pick again. Lanes is not offered below 1024 px.
 */
import { component, type Define } from 'sigx';
import { Segmented, type DetailLevel, type SegmentedOption } from '@agentic/ui';
import type { ChatViewName } from '../view-prefs';
import { viewNote, type ViewPick } from './pick';

const VIEW_OPTIONS: readonly SegmentedOption[] = [
    { value: 'focus', label: 'Focus' },
    { value: 'team', label: 'Team' },
    { value: 'lanes', label: 'Lanes' }
];
const DETAIL_OPTIONS: readonly SegmentedOption[] = [
    { value: 'messages', label: 'Messages' },
    { value: 'steps', label: 'Steps' },
    { value: 'raw', label: 'Raw' }
];

export type ViewHeaderProps =
    & Define.Prop<'title', string, true>
    & Define.Prop<'pick', ViewPick, true>
    & Define.Prop<'detail', DetailLevel, true>
    & Define.Prop<'narrow', boolean, false>
    & Define.Prop<'onView', (view: ChatViewName | 'auto') => void, true>
    & Define.Prop<'onDetail', (detail: DetailLevel) => void, true>;

export const ViewHeader = component<ViewHeaderProps>(({ props }) => {
    return () => {
        const pick = props.pick;
        const views = props.narrow ? VIEW_OPTIONS.filter((o) => o.value !== 'lanes') : VIEW_OPTIONS;
        return (
            <header data-chat-head="">
                <div data-chat-head-text="">
                    <div data-chat-head-title="">{props.title}</div>
                    <p data-chat-view-note="" data-rule={pick.rule}>
                        <span>{viewNote(pick)}</span>
                        {pick.rule === 'pinned' ? <button type="button" data-chat-view-auto="" onClick={() => props.onView('auto')}>Auto</button> : null}
                    </p>
                </div>
                <div data-chat-head-controls="">
                    <div data-chat-control="view">
                        <span data-chat-control-label="" aria-hidden="true">View</span>
                        <Segmented label="View" options={views} model={() => pick.view} onValueChange={(v: string) => props.onView(v as ChatViewName)} />
                    </div>
                    <div data-chat-control="detail">
                        <span data-chat-control-label="" aria-hidden="true">Detail</span>
                        <Segmented label="Detail" options={DETAIL_OPTIONS} model={() => props.detail} onValueChange={(d: string) => props.onDetail(d as DetailLevel)} />
                    </div>
                </div>
            </header>
        );
    };
}, { name: 'ChatViewHeader' });
