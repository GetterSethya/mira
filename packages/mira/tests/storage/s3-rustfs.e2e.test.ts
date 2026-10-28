/**
 * End-to-end test for `S3CompatibleStorage` against a real S3-compatible
 * server (RustFS).
 *
 * Gated behind `MIRA_S3_E2E=1` so the normal test suite needs no Docker:
 *
 * ```powershell
 * docker compose -f docker-compose.rustfs.yml up -d
 * $env:MIRA_S3_E2E = "1"
 * pnpm --filter @gettersethya/mira exec vitest run tests/storage/s3-rustfs.e2e.test.ts
 * ```
 *
 * Overridable with `MIRA_S3_ENDPOINT`, `MIRA_S3_BUCKET`, `MIRA_S3_REGION`,
 * `MIRA_S3_ACCESS_KEY` and `MIRA_S3_SECRET_KEY`. The bucket is created
 * automatically when missing.
 */
import { NodeHttpServer } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { BaseCollection, Bytes, Field } from "@gettersethya/mira-client"
import { Data, Effect, Layer, Stream } from "effect"
import type { HttpClientResponse } from "effect/http"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/http"
import { s3Fetch } from "files-sdk/s3-fetch"

import { applyRulesToCollections, defineRule, Mira } from "@/app/index.js"
import { SqliteDatabase } from "@/databases/sqlite.js"
import { makeCollectionRouter } from "@/http/router.js"
import { NodePlatform } from "@/platforms/node.js"
import { S3CompatibleStorage } from "@/storage/s3-preset.js"
import { FileStorage } from "@/storage/storage.js"

const endpoint = process.env["MIRA_S3_ENDPOINT"] ?? "http://localhost:9000"
const bucketName = process.env["MIRA_S3_BUCKET"] ?? "mira-e2e"
const regionName = process.env["MIRA_S3_REGION"] ?? "us-east-1"
const accessKey = process.env["MIRA_S3_ACCESS_KEY"] ?? "miraadmin"
const secret = process.env["MIRA_S3_SECRET_KEY"] ?? "miraadmin-secret"

const s3Config = { endpoint, bucketName, regionName, accessKey, secret }

const enabled = process.env["MIRA_S3_E2E"] === "1"
const describeE2E = enabled ? describe : describe.skip

// ---------------------------------------------------------------------------
// Collection + app wiring (real builder → S3CompatibleStorage)
// ---------------------------------------------------------------------------

const docsDef = BaseCollection.define("docs", {
  title: Field.text(),
  attachment: Field.file({ required: false, maxSize: Bytes.fromMB(1) })
})
const docsRules = defineRule(docsDef, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.public(),
  delete: R.public()
}))

// The same rule-applied definitions must feed both the app layer and the
// router — the router sent to the test server reads rules from these schemas.
const [Docs] = applyRulesToCollections([docsDef], [docsRules])

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: ":memory:" }))
  .storage(S3CompatibleStorage(s3Config))
  .collections([Docs])
  .build()

// ---------------------------------------------------------------------------
// Bucket bootstrap (PUT /bucket through the SDK's SigV4 client)
// ---------------------------------------------------------------------------

class BucketSetupError extends Data.TaggedError("BucketSetupError")<{
  readonly reason: string
}> {}

const ensureBucket = Effect.tryPromise({
  try: async () => {
    const adapter = s3Fetch({
      bucket: bucketName,
      endpoint,
      region: regionName,
      accessKeyId: accessKey,
      secretAccessKey: secret,
      forcePathStyle: true
    })
    const res = await adapter.raw.fetch(`${endpoint.replace(/\/+$/, "")}/${bucketName}`, {
      method: "PUT"
    })
    // 409 = already exists / already owned by these credentials.
    if (!res.ok && res.status !== 409) {
      throw new BucketSetupError({
        reason: `create bucket ${bucketName}: ${res.status} ${await res.text()}`
      })
    }
  },
  catch: (cause) =>
    cause instanceof BucketSetupError
      ? cause
      : new BucketSetupError({ reason: String(cause) })
}).pipe(Effect.orDie)

const bucketLayer = Layer.effectDiscard(ensureBucket)

const testLayer = Layer.mergeAll(app.buildServiceLayer(), NodeHttpServer.layerTest, bucketLayer)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const serveRouter = Effect.flatMap(
  HttpRouter.toHttpEffect(HttpRouter.addAll(makeCollectionRouter([Docs]))),
  HttpServer.serveEffect()
)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

function requireString(value: unknown, field: string): string {
  if (!isRecord(value)) throw new Error(`expected an object response, got ${typeof value}`)
  const candidate = value[field]
  if (typeof candidate !== "string") {
    throw new Error(`expected a string "${field}" in response, got ${typeof candidate}`)
  }
  return candidate
}

const responseText = (res: HttpClientResponse.HttpClientResponse) =>
  res.text.pipe(Effect.orElseSucceed(() => ""))

/** Remove every object in the dedicated e2e bucket before each test. */
const clearBucket = Effect.gen(function* () {
  const storage = yield* FileStorage
  const keys = yield* storage.list("")
  yield* Effect.forEach(
    keys,
    (key) => storage.delete(key).pipe(Effect.ignore),
    { concurrency: "unbounded" }
  )
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("S3CompatibleStorage E2E (RustFS)", () => {
  it.effect("upload → serve → list → record delete removes the object", () =>
    Effect.gen(function* () {
      yield* clearBucket
      yield* serveRouter

      const payload = new TextEncoder().encode(`mira-rustfs-e2e-${Date.now()}`)
      const form = new FormData()
      form.append("title", "rustfs e2e")
      form.append("attachment", new Blob([payload], { type: "text/plain" }), "hello.txt")

      const createRes = yield* HttpClient.execute(
        HttpClientRequest.bodyFormData(HttpClientRequest.post("/api/collections/docs"), form)
      )
      const createText = yield* responseText(createRes)
      assert.strictEqual(createRes.status, 201, createText)

      const created = yield* createRes.json
      const id = requireString(created, "id")
      const key = requireString(created, "attachment")

      const storage = yield* FileStorage

      // The bytes actually landed in RustFS.
      assert.strictEqual(yield* storage.exists(key), true)
      assert.deepStrictEqual(yield* storage.read(key), payload)
      assert.ok((yield* storage.list("")).includes(key))

      // Mira's own file route streams them back.
      const fileRes = yield* HttpClient.get(`/api/files/docs/${id}/${key}`)
      assert.strictEqual(fileRes.status, 200)
      assert.strictEqual(fileRes.headers["content-type"]?.split(";")[0], "text/plain")
      assert.deepStrictEqual(new Uint8Array(yield* fileRes.arrayBuffer), payload)

      // The record exposes the key, so clients can build the file URL.
      const recordRes = yield* HttpClient.get(`/api/collections/docs/${id}`)
      assert.strictEqual(recordRes.status, 200)
      const record = yield* recordRes.json
      assert.strictEqual(requireString(record, "attachment"), key)

      // Deleting the record cleans the object up (best-effort file cleanup).
      const deleteRes = yield* HttpClient.execute(
        HttpClientRequest.delete(`/api/collections/docs/${id}`)
      )
      assert.strictEqual(deleteRes.status, 204)
      assert.strictEqual(yield* storage.exists(key), false)
    }).pipe(Effect.provide(testLayer))
  )

  it.effect("direct FileStorage roundtrip, prefix listing, delete and url", () =>
    Effect.gen(function* () {
      yield* clearBucket
      const storage = yield* FileStorage

      const key = `e2e-direct/${Date.now()}/nested.bin`
      const payload = new Uint8Array([0, 1, 2, 3, 250, 251, 252])

      yield* storage.upload(key, Stream.fromArray([payload]), "application/octet-stream")

      assert.strictEqual(yield* storage.exists(key), true)
      assert.deepStrictEqual(yield* storage.read(key), payload)
      assert.ok((yield* storage.list("e2e-direct/")).includes(key))
      assert.strictEqual(storage.url(key), `${endpoint.replace(/\/+$/, "")}/${bucketName}/${key}`)

      yield* storage.delete(key)
      assert.strictEqual(yield* storage.exists(key), false)
    }).pipe(Effect.provide(testLayer))
  )
})
