// The Worker wrangler bundles (`main` in wrangler.jsonc) — a one-line façade
// over the built entry, dist/server/entry.cloudflare.js.
//
// Why not the entry itself: the app build splits the server into chunks (the
// `sigx` chunk, the server-fn modules, the node shims), and rolldown makes the
// entry chunk re-export the helpers those chunks share (`export { … as n }`).
// workerd validates every export of a module Worker as a handler, a Durable
// Object class or a WorkflowEntrypoint, so a re-exported constant fails the
// script at load: "Incorrect type for map entry 'n': the provided value is not
// of type 'function or ExportedHandler'". Re-exporting only the two real
// exports keeps the bundle wrangler uploads valid. (#35; upstream: the
// `@sigx/cloudflare` adapter should emit this shape itself.)
export { default, ActorHost } from './dist/server/entry.cloudflare.js';
