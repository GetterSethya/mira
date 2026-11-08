# Storage

## Overview

File storage abstraction (`FileStorage` tag) with three implementation paths:

1. `storage.ts` — the contract, its two tagged errors, and a local-disk layer that
   reads/writes through Effect's `FileSystem`/`Path` services under a configured
   root directory.
2. `s3-storage.ts` — an S3-compatible backend built on `files-sdk`. The signed
   transport is `s3Fetch` (aws4fetch, no `@aws-sdk/*`); `makeFileStorageFromFiles`
   is the adapter-agnostic core that maps any `files-sdk` service onto the
   `FileStorage` contract, and `makeS3FileStorageLayer` resolves configuration
   (plain values or `Config`) and wires it up.
3. `local-preset.ts` / `s3-preset.ts` — thin `MiraStorage` presets
   (`{ layer }`) wrapping the two layers for the app builder.

Keys are opaque strings. Local storage confines every key to the storage root; S3
URL building drops `.`/`..` segments and URI-encodes each path segment so a key
cannot escape the bucket root.

## Interface

- `FileStorage` — `Context.Service` tag with `upload`, `delete`, `url`, `read`, `exists`, `list` [storage.ts:FileStorage]
- `FileStorageError` — tagged error for a failed storage operation, carrying a `reason` string [storage.ts:FileStorageError]
- `FileStorageNotFound` — tagged error for a missing object, carrying the `key` [storage.ts:FileStorageNotFound]
- `makeFileStorageLayer(provider, config)` — local-disk layer; `config["directory"]` defaults to `./uploads`, the `provider` argument is unused [storage.ts:makeFileStorageLayer]
- `makeFileStorageFromFiles(files, urlForKey?)` — adapts any `files-sdk` `FilesService` to `FileStorage`; default `urlForKey` is `/files/<encoded key>` (exported from the file, **not** re-exported by `index.ts`) [s3-storage.ts:makeFileStorageFromFiles]
- `makeS3FileStorageLayer(config)` — S3-compatible layer; resolves every `Config` value once at build time [s3-storage.ts:makeS3FileStorageLayer]
- `S3CompatibleStorage` — `MiraStorage` preset wrapping `makeS3FileStorageLayer` [s3-preset.ts:S3CompatibleStorage]
- `LocalFileStorage` — `MiraStorage` preset wrapping `makeFileStorageLayer("local", …)` [local-preset.ts:LocalFileStorage]
- (type) `S3ConfigValue<T>` — `T | Config.Config<T>` [s3-storage.ts:S3ConfigValue]
- (type) `S3CompatibleStorageConfig` — endpoint, `bucketName`, `regionName`, accessKey, secret (plain or `Redacted`), optional `forcePathStyle`, optional `publicBaseUrl` [s3-storage.ts:S3CompatibleStorageConfig]

## Invariants

- Every local key is resolved against the configured root and rejected when the relative path escapes the root or is absolute; `.`, `..`, mixed separators and redundant separators are normalised first [storage.ts:containedPath]
- Local `read` maps an out-of-root key AND a missing file to `FileStorageNotFound`; a `FileSystem.exists` failure is treated as "not present" rather than an error [storage.ts:makeFileStorageLayer]
- Local `upload` creates the parent directory recursively, then streams the input into the file sink [storage.ts:makeFileStorageLayer]
- Local `upload` remaps only the **sink's own** `PlatformError` to `FileStorageError` and passes upstream stream errors through unchanged, so callers keep their original error type (e.g. the upload size-limit validation error) [storage.ts:makeFileStorageLayer]
- Local `delete` is force-removal (missing files are not an error) and refuses keys outside the root [storage.ts:makeFileStorageLayer]
- Local `exists` returns `false` on a `PlatformError` instead of failing [storage.ts:makeFileStorageLayer]
- Local `list` reads the directory recursively, keeps only entries whose stat type is `File`, joins them with the caller's prefix, and normalises `\` to `/` [storage.ts:makeFileStorageLayer]
- Local `url` is synchronous and returns `/files/<key>`; the local provider ignores the mime type it is given [storage.ts:makeFileStorageLayer]
- Every S3 config field accepts a plain value or `Config`, is lifted with `Config.succeed` when plain, and is resolved once when the layer is built; missing variables therefore fail at startup, not on first upload [s3-storage.ts:resolveConfigValue], [s3-storage.ts:makeS3FileStorageLayer]
- The S3 layer dies (`Effect.orDie`) on resolution failure so a misconfigured bucket is a build-time defect rather than a per-operation error [s3-storage.ts:makeS3FileStorageLayer]
- Importing the S3 module performs no network or credential work; the `files-sdk` client is constructed inside the layer [s3-storage.ts:makeS3FileStorageLayer]
- `forcePathStyle` defaults to `true`; `publicBaseUrl` is omitted from the resolved config when not supplied (never set to `undefined`) [s3-storage.ts:makeS3FileStorageLayer]
- `makeFileStorageFromFiles` maps `FilesError` to `FileStorageError`, except `NotFound` on `read` which becomes `FileStorageNotFound`; `NotFound` on `delete` succeeds silently and on `exists` returns `false` [s3-storage.ts:makeFileStorageFromFiles]
- The adapted `upload` drains the source stream *inside* the Effect and then hands a single `Uint8Array` to the provider, so streaming errors keep their original type instead of being rewritten by the adapter's error mapping [s3-storage.ts:makeFileStorageFromFiles]
- `url()` prefers `publicBaseUrl`, otherwise emits a path-style URL, or a virtual-host URL when `forcePathStyle` is `false` and the endpoint parses; an unparseable endpoint falls back to path style [s3-storage.ts:makeUrlBuilder]
- `encodeKeyPath` drops empty, `.` and `..` path segments and `encodeURIComponent`s each remaining segment, so a key cannot escape the bucket root through a URL [s3-storage.ts:encodeKeyPath]
- Both presets satisfy the `MiraStorage` shape — a single `layer` field typed `Layer<FileStorage, never, FileSystem | Path>` [local-preset.ts:LocalFileStorage], [s3-preset.ts:S3CompatibleStorage]

## Side Effects

- Local provider: creates directories, streams bytes to disk, reads files, stats entries, lists directories, and removes files via Effect `FileSystem` [storage.ts:makeFileStorageLayer]
- S3 provider: performs signed HTTP requests to the object store for upload, download, delete, existence checks and listing [s3-storage.ts:makeS3FileStorageLayer]
- Reads environment/configuration through Effect `Config` when the S3 layer is built [s3-storage.ts:resolveConfigValue]
- Reads `Redacted` secrets only at layer build, unwrapping them into plain strings for the signer [s3-storage.ts:unwrapSecret]
- No side effects at import time for either provider; the local layer acquires `FileSystem`/`Path` from the environment [storage.ts:makeFileStorageLayer]

## Verification

- Run: `pnpm --filter @gettersethya/mira test`
- Typecheck: `pnpm --filter @gettersethya/mira typecheck`
