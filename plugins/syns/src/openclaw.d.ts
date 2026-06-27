/**
 * Minimal ambient declaration for the OpenClaw Plugin SDK surface this plugin uses.
 *
 * The real types ship with the `openclaw` package (the gateway provides it at runtime), but
 * we deliberately do NOT depend on it at build time: the package is large, version-coupled to
 * the gateway, and not always present in a clean plugin checkout. Declaring the one symbol we
 * use keeps `tsc` self-contained — `npm install && npm run build` needs only `typescript` and
 * `@types/node`. The SDK surface is intentionally typed loosely here; the runtime module is
 * authoritative. See PLAN.md.
 */
declare module "openclaw/plugin-sdk/plugin-entry" {
  export function definePluginEntry(config: any): unknown;
}
