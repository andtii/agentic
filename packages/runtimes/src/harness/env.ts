/** The account half of a harness child's environment: what could select another account is removed, the profile's own home is set (EXE-04/05). */

/**
 * Extra variables for a child process: every parent key matching one of `strip` maps to `undefined` (removed), then
 * `set` is applied — a `set` value of `undefined` removes that key too (no profile dir: the harness's default).
 */
export function profileEnv(
    parent: Readonly<Record<string, string | undefined>>,
    spec: { readonly strip: readonly RegExp[]; readonly set: Readonly<Record<string, string | undefined>> }
): Record<string, string | undefined> {
    const extra: Record<string, string | undefined> = {};
    for (const key of Object.keys(parent)) if (spec.strip.some((re) => re.test(key))) extra[key] = undefined;
    for (const [key, value] of Object.entries(spec.set)) extra[key] = value;
    return extra;
}
