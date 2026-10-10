// Type-level acceptance for the Svelte entry.
//
// This file is intentionally NOT a `.test.ts`: `@tanstack/svelte-query` ships
// `.svelte` component files that node-based vitest cannot import, so anything
// importing the package root can only be verified by `tsc --noEmit`
// (tsconfig `include`s the whole `tests/` directory). The runtime behavior of
// the passthrough is covered by `tanstack-svelte.test.ts` with local factories.
//
// What this proves (compile-time):
// - `createSvelteCollectionAdapter` accepts the real v6 `queryOptions` /
//   `mutationOptions` factories (this is what broke `tsc -p tsconfig.build.json`
//   before the `_core.ts` factory types were loosened);
// - the produced option objects satisfy svelte-query `createQuery` /
//   `createMutation` inputs (reactive getter form).
import { expect } from "vitest"
import { Effect } from "effect"
import { MutableRef } from "effect"
import { createMutation, createQuery, mutationOptions, queryOptions } from "@tanstack/svelte-query"
import { BaseCollection } from "@gettersethya/mira-client"
import { Field } from "@gettersethya/mira-client"
import { makeCollectionClient } from "@gettersethya/mira-client"
import type { ExecuteFn } from "@gettersethya/mira-client"
import { createSvelteCollectionAdapter } from "../src/svelte.js"

const Posts = BaseCollection.define("posts", { title: Field.text() })

function makeTestClient() {
  // Compile-time acceptance only (see header): option objects are built but never
  // executed, so stub `execute` as a defect instead of faking `T` with an assertion.
  const execute: ExecuteFn = () => Effect.die("test stub: execute must not be called")

  return makeCollectionClient({
    collectionName: "posts",
    schema: Posts.schema,
    fields: Posts.fields,
    execute,
    baseUrl: "http://localhost",
    authTokenRef: null,
    loggedInRef: null,
    fileTokenCacheRef: MutableRef.make(new Map()),
    isAuth: false,
  })
}

const adapter = createSvelteCollectionAdapter(queryOptions, mutationOptions)
const adapted = adapter(makeTestClient(), "posts")

const listOpts: Parameters<typeof createQuery>[0] = () => adapted.getList().queryOptions
const createOpts: Parameters<typeof createMutation>[0] = () => adapted.create().mutationOptions

expect(listOpts).toBeDefined()
expect(createOpts).toBeDefined()
