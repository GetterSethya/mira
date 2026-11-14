# Crypto Service

## Overview

Platform abstractions for random-number generation, UUIDs, and hashing. Runtime code
depends on the `CryptoService` tag instead of importing `node:crypto` directly, which
keeps the core library portable. `crypto/node.ts` is the Node implementation,
`crypto/bun.ts` is the Bun implementation, and `crypto/hash.ts` provides shared
SHA-256/HMAC helpers that switch to `Bun.CryptoHasher` when it is available. The
synchronous `randomBytesSync` variant exists so callers that cannot `yield*` an Effect
(e.g. tracer callbacks) can still draw random bytes.

## Interface

- `CryptoService` — `Context.Service` tag exposing `randomBytesSync(size)`, `randomBytes(size)`, `randomUUID()` [crypto.ts:CryptoService]
- `NodeCryptoLayer` — `Layer.succeed` implementation backed by `node:crypto` [node.ts:NodeCryptoLayer]
- `BunCryptoLayer` — `Layer.succeed` implementation using `crypto.getRandomValues` and `Bun.randomUUIDv7()` (with a v4 fallback) [bun.ts:BunCryptoLayer]
- `bytesToBase64Url(bytes)` — unpadded base64url encoder [hash.ts:bytesToBase64Url]
- `sha256Base64Url(value)` — SHA-256 digest as base64url [hash.ts:sha256Base64Url]
- `hmacSha256Base64Url(secret, value)` — HMAC-SHA-256 as base64url [hash.ts:hmacSha256Base64Url]
- `hmacSha256Base64(secret, value)` — HMAC-SHA-256 as standard padded base64, used by the JWT `pwf` claim [hash.ts:hmacSha256Base64]
- `CryptoHashError` — tagged error for hash failures [hash.ts:CryptoHashError]
- Barrel re-exports `CryptoService`, `NodeCryptoLayer`, `BunCryptoLayer`, and the hash helpers [index.ts:CryptoService]

## Invariants

- `randomBytesSync` returns a `Uint8Array` directly and must only be used where an Effect cannot be yielded [crypto.ts:CryptoService]
- `randomBytes` and `randomUUID` return `Effect.Effect` values; neither declares an error channel [crypto.ts:CryptoService]
- The Node layer delegates verbatim to `nodeCrypto.randomBytes` / `randomUUID`, so output is cryptographically secure OS entropy [node.ts:NodeCryptoLayer]
- The Bun layer draws bytes from `crypto.getRandomValues` and prefers `Bun.randomUUIDv7()`; UUIDs are therefore time-sortable on Bun and v4 on Node [bun.ts:BunCryptoLayer]
- Hash helpers use `Bun.CryptoHasher` synchronously when present and fall back to WebCrypto (`globalThis.crypto.subtle`) elsewhere; both paths must produce identical bytes [hash.ts:nativeDigest]
- `hmacSha256Base64` and `hmacSha256Base64Url` hash the same digest and differ only in encoding [hash.ts:hmacSha256Base64]
- This directory is the only place (besides the other platform-specific implementations aggregated by the platform layers) permitted to import `node:crypto` [node.ts:NodeCryptoLayer]

## Side Effects

- Draws entropy from the operating system's CSPRNG via `node:crypto` or Web Crypto [node.ts:NodeCryptoLayer] [bun.ts:BunCryptoLayer]
- Hashes strings in memory; no I/O [hash.ts:sha256Base64Url]
- No filesystem, database, network, environment, timer, or cache access [crypto.ts:CryptoService]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Bun smoke (native vectors, UUIDv7): `bun run apps/example-bun/src/smoke.ts`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
