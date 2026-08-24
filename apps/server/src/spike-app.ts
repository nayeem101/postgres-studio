import { Elysia, t } from "elysia";

/**
 * Phase 0 throwaway surface proving TypeBox validation + path params.
 * Deliberately database-free so request tests need no Postgres.
 */

export const EchoBody = t.Object({
  name: t.String({ minLength: 1 }),
  limit: t.Optional(t.Number({ minimum: 1, maximum: 100 })),
});

export type EchoBody = typeof EchoBody.static;

export const spikeApp = new Elysia({ name: "spike", prefix: "/spike" })
  .get(
    "/hello/:name",
    ({ params }) => ({ message: `hello, ${params.name}` }),
    {
      params: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
      }),
      response: t.Object({
        message: t.String(),
      }),
    },
  )
  .post(
    "/echo",
    ({ body }) => ({
      name: body.name,
      limit: body.limit ?? null,
    }),
    {
      body: EchoBody,
      response: t.Object({
        name: t.String(),
        limit: t.Nullable(t.Number()),
      }),
    },
  );
