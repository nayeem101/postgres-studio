/**
 * Eden Treaty consumes `typeof app` from the Elysia instance.
 * Phase 1: re-export that type from `apps/server` so `apps/web` never hand-writes API types.
 */
export type App = unknown;
