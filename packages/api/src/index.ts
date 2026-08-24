/**
 * Eden Treaty consumes `typeof app` from the Elysia instance.
 * The server remains the single source of truth; web never hand-writes API types.
 *
 * `App` comes from the server entry (type-only import, erased at runtime so
 * importing this module never binds a port).
 */
export type { App } from "@pg-studio/server";
