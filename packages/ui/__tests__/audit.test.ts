/**
 * The design-system audit gate (#595): what `sigx zero:build` writes to
 * `dist/ds/audit.json`, run here from source, with the same kit function
 * (`auditDesignSystem`) and the fragment merged the way the build merges it.
 *
 * Errors are locked at 0 (off-ramp spacing, an unreset button chip, an
 * endless animation under reduced motion, a declared axis step nobody
 * paints) and so are warnings: every scope declares out the axes it does not
 * wire (`fragment/scopes.ts`) and every spacing literal rides the ramp. The
 * info lines are the static contrast matrix's cells it cannot measure
 * (blends, gradients) plus the rating star's 4:1 indicator. A new finding
 * fails this test with its message, which says how to fix it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { auditDesignSystem, formatAudit, mergeManifests, type ZeroManifest } from '@sigx/zero-kit';
import { designSystem } from '../src/design-system';
import { fragment } from '../src/fragment';

const zeroManifest = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@sigx/zero/manifest.json')), 'utf8')) as ZeroManifest;

describe('the design-system audit', () => {
    const result = auditDesignSystem(designSystem, mergeManifests(zeroManifest, fragment));

    it('reports no error and no warning', () => {
        const blocking = result.findings.filter((f) => f.severity !== 'info');
        expect(blocking.length ? formatAudit({ ...result, findings: blocking }).join('\n') : '').toBe('');
        expect(result.summary.errors).toBe(0);
        expect(result.summary.warnings).toBe(0);
    });

    it('keeps the info lines to the contrast cells no static read can measure', () => {
        expect(new Set(result.findings.map((f) => f.rule))).toEqual(new Set(['contrast/indicator', 'contrast/unmeasured']));
    });
});
