# platforms

## Overview

Node.js platform preset for the Mira app builder. `node.ts` is the only file in
this directory: it re-exports the Effect Node runtime and assembles every
Node-specific service implementation (filesystem, path, crypto, HTTP server
factory) into `NodePlatformLayer`, then wraps that layer plus the Node auth
service and `NodeRuntime.runMain` into the `NodePlatform` preset consumed by
`Mira.builder().platform(...)`. A non-Node target would add a sibling preset
(e.g. Bun) with the same shape.

## Interface

### `node.ts`

- `NodePlatformLayer` — `Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCryptoLayer, NodeHttpServerFactoryLayer)`. [node.ts:NodePlatformLayer]
- `NodePlatform` — `MiraPlatform` preset: `{ layer: NodePlatformLayer + NodeAuthServiceLayer, runMain: (effect) => NodeRuntime.runMain(effect) }`. [node.ts:NodePlatform]
- `NodeRuntime` — re-export of `NodeRuntime` from `@effect/platform-node` for custom entrypoints. [node.ts:NodeRuntime]

No subdirectories.

## Invariants

- `NodePlatformLayer` provides exactly the platform services (FileSystem, Path, CryptoService, HttpServerFactory) and nothing app-specific. [node.ts:NodePlatformLayer]
- `NodePlatformLayer` is re-used verbatim inside `NodePlatform.layer` — the preset never re-declares platform services. [node.ts:NodePlatform]
- `NodePlatform.layer` additionally merges `NodeAuthServiceLayer`, which is not part of `NodePlatformLayer`. [node.ts:NodePlatform]
- `NodePlatform` must satisfy `MiraPlatform`, i.e. expose both `layer` and `runMain`. [node.ts:NodePlatform]
- `NodePlatform.runMain` delegates directly to `NodeRuntime.runMain` — no custom error handling or process wiring is added here. [node.ts:NodePlatform]
- `NodeRuntime` is re-exported as a value so custom entrypoints can reach it without importing `@effect/platform-node` themselves. [node.ts:NodeRuntime]

## Side Effects

- No server is bound at import time; HTTP listening is deferred to `HttpServerFactory` when the app layer is built. [node.ts:NodePlatformLayer]
- `NodePlatform.runMain` hands the effect to the Node runtime, which owns process lifecycle and signal handling for `serve()`. [node.ts:NodePlatform]
- No filesystem, network, timer, queue, or environment access in this directory itself.

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
