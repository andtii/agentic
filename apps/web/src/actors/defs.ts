/**
 * The actor definitions and the viewer the pages read through (#34) now live
 * in `@agentic/client` (#1116), where the app stores read them too; this file
 * re-exports them so the call sites stay as they were. The halves that are
 * wire-specific stay here: `clientDefs()` (`./client.ts`), `platformDefs()`
 * (`../actors.cloudflare.ts`) and `viewerHook` (`./viewer.ts`).
 */
export { useActorDefs, useViewer, type ActorDefs, type ViewerHook, type ViewerState } from '@agentic/client';
