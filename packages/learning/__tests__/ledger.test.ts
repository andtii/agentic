import type { AgentId } from '@agentic/core';
import { isoWeek, memoryCorrectionLedger } from '../src/index';

describe('isoWeek', () => {
    it('follows ISO 8601 across year boundaries, in UTC', () => {
        expect(isoWeek(Date.UTC(2026, 0, 1))).toBe('2026-W01'); // Thursday
        expect(isoWeek(Date.UTC(2027, 0, 1))).toBe('2026-W53'); // Friday belongs to the previous year
        expect(isoWeek(Date.UTC(2024, 11, 30))).toBe('2025-W01'); // Monday belongs to the next year
        expect(isoWeek(Date.UTC(2026, 8, 13, 23, 59))).toBe('2026-W37'); // Sunday closes the week
        expect(isoWeek(Date.UTC(2026, 8, 14))).toBe('2026-W38');
    });
});

describe('memoryCorrectionLedger', () => {
    it('returns the running weekly total and counts by kind', () => {
        const ledger = memoryCorrectionLedger();
        const agentId = 'agent_a' as AgentId;
        expect(ledger.recordCorrection({ agentId, week: '2026-W38', what: 'wrong', at: 0 })).toBe(1);
        expect(ledger.recordCorrection({ agentId, week: '2026-W38', what: 'never', at: 0 })).toBe(2);
        expect(ledger.count(agentId, '2026-W38', 'never')).toBe(1);
        expect(ledger.count(agentId, '2026-W39')).toBe(0);
    });
});
