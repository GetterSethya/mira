# platforms

## Overview

Node and Bun platform presets for the Mira app builder. `node.ts` re-exports the
Effect Node runtime and assembles every Node-specific service implementation
(filesystem, path, crypto, HTTP server factory) into `NodePlatformLayer`, then
wraps that layer plus the Node auth service and `NodeRuntime.runMain` into the
`NodePlatform` preset. `bun.ts` does the same with native Bun filesystem/path,
`BunHttpServer`, `BunRuntime`, `BunCryptoLayer`, `BunAuthServiceLayer`, and a
native thumbnail layer; SMTP still reuses the Node-compatible `nodemailer`
transport, which runs on Bun's native sockets. Both presets are consumed by
`Mira.builder().platform(...)`.

## Interface

### `node.ts`

- `NodePlatformLayer` — `Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCryptoLayer, NodeHttpServerFactoryLayer)`. [node.ts:NodePlatformLayer]
- `NodePlatform` — `MiraPlatform` preset: `{ layer: NodePlatformLayer + NodeAuthServiceLayer, runMain: (effect) => NodeRuntime.runMain(effect) }`. [node.ts:NodePlatform]
- `NodeRuntime` — re-export of `NodeRuntime` from `@effect/platform-node` for custom entrypoints. [node.ts:NodeRuntime]

### `bun.ts`

- `BunPlatformLayer` — `Layer.mergeAll(BunFileSystem.layer, BunPath.layer, BunCryptoLayer, BunHttpServerFactoryLayer, NodeMailTransportLayer)`. [bun.ts:BunPlatformLayer]
- `BunPlatform` — `MiraPlatform` preset: `{ layer: BunPlatformLayer + BunAuthServiceLayer, runMain: (effect) => BunRuntime.runMain(effect), thumbnailLayer: ThumbnailServiceBunLive }`. [bun.ts:BunPlatform]
- `BunPortablePlatform` — same as `BunPlatform` but `NodeAuthServiceLayer` (scrypt) instead of Argon2id, so credentials remain verifiable on both runtimes. [bun.ts:BunPortablePlatform]
- `BunRuntime` — re-export from `@effect/platform-bun` for custom Bun entrypoints. [bun.ts:BunRuntime]

No subdirectories.

## Invariants

- `NodePlatformLayer` provides exactly the platform services (FileSystem, Path, CryptoService, HttpServerFactory) and nothing app-specific. [node.ts:NodePlatformLayer]
- `NodePlatformLayer` is re-used verbatim inside `NodePlatform.layer` — the preset never re-declares platform services. [node.ts:NodePlatform]
- `NodePlatform.layer` additionally merges `NodeAuthServiceLayer`, which is not part of `NodePlatformLayer`. [node.ts:NodePlatform]
- `NodePlatform` must satisfy `MiraPlatform`, i.e. expose both `layer` and `runMain`. [node.ts:NodePlatform]
- `NodePlatform.runMain` delegates directly to `NodeRuntime.runMain` — no custom error handling or process wiring is added here. [node.ts:NodePlatform]
- `NodeRuntime` is re-exported as a value so custom entrypoints can reach it without importing `@effect/platform-node` themselves. [node.ts:NodeRuntime]
- `BunPlatformLayer` uses native Bun filesystem, path, HTTP, and crypto layers; it does not import `@effect/platform-node`. [bun.ts:BunPlatformLayer]
- `BunPlatform` uses `BunAuthServiceLayer` (Argon2id) and supplies `ThumbnailServiceBunLive` (native contain/fill); only `NodeMailTransportLayer` is Node-compatible. [bun.ts:BunPlatform]
- `BunPortablePlatform` trades Argon2id for the shared scrypt format so a Bun-created database can return to Node without password resets. [bun.ts:BunPortablePlatform]
- `BunPlatform.runMain` delegates to `BunRuntime.runMain`; no custom signal handling is added. [bun.ts:BunPlatform]
- `MiraPlatform.thumbnailLayer` is optional; when absent the app foundation uses `ThumbnailServicePhotonLive`. [bun.ts:BunPlatform]

## Side Effects

- No server is bound at import time; HTTP listening is deferred to `HttpServerFactory` when the app layer is built. [node.ts:NodePlatformLayer]
- `NodePlatform.runMain` hands the effect to the Node runtime, which owns process lifecycle and signal handling for `serve()`. [node.ts:NodePlatform]
- `BunPlatform.runMain` hands the effect to `BunRuntime.runMain`, which owns Bun process lifecycle and signal handling for `serve()`. [bun.ts:BunPlatform]
- No filesystem, network, timer, queue, or environment access in this directory itself.

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Bun smoke: `bun run apps/example-bun/src/smoke.ts`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
