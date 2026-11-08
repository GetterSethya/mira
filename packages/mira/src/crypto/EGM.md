# Crypto Service

## Overview

A thin platform abstraction over random-number and UUID generation. Runtime code depends
on the `CryptoService` tag instead of importing `node:crypto` directly, which keeps the
core library portable; `crypto/node.ts` is the one Node-specific implementation that the
`NodePlatformLayer` aggregator wires in. The synchronous variant exists so callers that
cannot `yield*` an Effect (e.g. tracer callbacks) can still draw random bytes.

## Interface

- `CryptoService` — `Context.Service` tag exposing `randomBytesSync(size)`, `randomBytes(size)`, `randomUUID()` [crypto.ts:CryptoService]
- `NodeCryptoLayer` — `Layer.succeed` implementation backed by `node:crypto` [node.ts:NodeCryptoLayer]
- Barrel re-exports `CryptoService` and `NodeCryptoLayer` [index.ts:CryptoService] [index.ts:NodeCryptoLayer]

## Invariants

- `randomBytesSync` returns a `Uint8Array` directly and must only be used where an Effect cannot be yielded [crypto.ts:CryptoService]
- `randomBytes` and `randomUUID` return `Effect.Effect` values; neither declares an error channel [crypto.ts:CryptoService]
- The Node layer delegates verbatim to `nodeCrypto.randomBytes` / `randomUUID`, so output is cryptographically secure OS entropy [node.ts:NodeCryptoLayer]
- This directory is the only place (besides the other platform-specific implementations aggregated by `NodePlatformLayer`) permitted to import `node:crypto` [node.ts:NodeCryptoLayer]

## Side Effects

- Draws entropy from the operating system's CSPRNG via `node:crypto` [node.ts:NodeCryptoLayer]
- No filesystem, database, network, environment, timer, or cache access [crypto.ts:CryptoService]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
