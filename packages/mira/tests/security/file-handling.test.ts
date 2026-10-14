// Exercises the production code paths (real `makeCollectionRouter`, real
// `CollectionService`, real on-disk `FileStorage`).
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

import { FileStorage } from "@/storage/storage.js"

import { get, makeSecurityLayer, postJson, serveRouter, setupTables } from "./_harness.js"

// Relative to packages/mira (vitest cwd).
const TMP = "./tests/security/.tmp"
const ROOT = "./tests/security/.tmp/files-root"

// `makeSecurityLayer` provides FileSystem/Path internally, so no extra wrap.
const layer = makeSecurityLayer(ROOT)

// ---------------------------------------------------------------------------
// Filesystem helpers (effect FileSystem, provided by the harness layer)
// ---------------------------------------------------------------------------

const fsExists = (p: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(p).pipe(Effect.orElseSucceed(() => false))
  })

const fsWrite = (p: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const parent = p.slice(0, p.lastIndexOf("/"))
    if (parent.length > 0) {
      yield* fs.makeDirectory(parent, { recursive: true }).pipe(Effect.orDie)
    }
    yield* fs.writeFileString(p, content).pipe(Effect.orDie)
  })

const fsRemove = (p: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.remove(p, { recursive: true, force: true }).pipe(Effect.orDie)
  })

/** Remove the whole scratch tree so each test starts clean. */
const resetTmp = fsRemove(TMP)

const delAnon = (path: string) => HttpClient.execute(HttpClientRequest.delete(path))

const ReadPost = Schema.Struct({ id: Schema.String, attachment: Schema.String })

const readPost = (res: { json: Effect.Effect<unknown, unknown, never> }) =>
  Effect.gen(function* () {
    const raw = yield* res.json
    return yield* Schema.decodeUnknownEffect(ReadPost)(raw)
  })

/** A served file is safe only if it is not inline-executable. */
const servedInlineIsSafe = (headers: Readonly<Record<string, string | undefined>>) => {
  const disposition = (headers["content-disposition"] ?? "").toLowerCase()
  const nosniff = (headers["x-content-type-options"] ?? "").toLowerCase()
  return disposition.includes("attachment") || nosniff === "nosniff"
}

// ---------------------------------------------------------------------------

describe("file handling security audit (regression: expects secure behaviour)", () => {
  it.effect("H1 uploaded HTML must NOT be served inline without attachment/nosniff", () =>
    Effect.gen(function* () {
      yield* resetTmp
      yield* setupTables
      yield* serveRouter()

      const payload = "<script>document.title='PWNED'</script>"
      const fd = new FormData()
      fd.append("title", "xss")
      fd.append("attachment", new Blob([payload], { type: "text/html" }), "evil.html")

      const res = yield* HttpClient.execute(
        HttpClientRequest.bodyFormData(HttpClientRequest.post("/api/collections/posts"), fd)
      )
      assert.strictEqual(res.status, 201)
      const created = yield* readPost(res)

      const dl = yield* get(`/api/files/posts/${created.id}/${created.attachment}`)
      const text = yield* dl.text.pipe(Effect.orElseSucceed(() => "<no-body>"))

      console.log("[H1][evidence] download status:", dl.status)
      console.log("[H1][evidence] download headers:", JSON.stringify(dl.headers))
      console.log("[H1][evidence] download body:", text)

      // control: the file is served at all
      assert.strictEqual(dl.status, 200)
      assert.ok(
        servedInlineIsSafe(dl.headers),
        `insecure: served content-type ${dl.headers["content-type"]} inline with no content-disposition: attachment and no x-content-type-options: nosniff`
      )
    }).pipe(Effect.provide(layer))
  )

  it.effect("H1b uploaded SVG must NOT be served inline without attachment/nosniff", () =>
    Effect.gen(function* () {
      yield* resetTmp
      yield* setupTables
      yield* serveRouter()

      const payload = "<svg xmlns='http://www.w3.org/2000/svg'><script>alert('PWNED')</script></svg>"
      const fd = new FormData()
      fd.append("title", "svg-xss")
      fd.append("attachment", new Blob([payload], { type: "image/svg+xml" }), "evil.svg")

      const res = yield* HttpClient.execute(
        HttpClientRequest.bodyFormData(HttpClientRequest.post("/api/collections/posts"), fd)
      )
      assert.strictEqual(res.status, 201)
      const created = yield* readPost(res)

      const dl = yield* get(`/api/files/posts/${created.id}/${created.attachment}`)
      const text = yield* dl.text.pipe(Effect.orElseSucceed(() => "<no-body>"))

      console.log("[H1b][evidence] download status:", dl.status)
      console.log("[H1b][evidence] download headers:", JSON.stringify(dl.headers))
      console.log("[H1b][evidence] download body:", text)

      assert.strictEqual(dl.status, 200)
      assert.ok(
        servedInlineIsSafe(dl.headers),
        `insecure: served content-type ${dl.headers["content-type"]} inline with no content-disposition: attachment and no x-content-type-options: nosniff`
      )
    }).pipe(Effect.provide(layer))
  )

  it.effect("H2 deleting a record must NOT delete a file outside the storage root (delete path)", () =>
    Effect.gen(function* () {
      yield* resetTmp
      yield* setupTables
      yield* serveRouter()

      const victim = `${TMP}/victim-delete.txt`
      yield* fsWrite(victim, "SENTINEL-DO-NOT-DELETE")

      // JSON (not multipart) create — the file field accepts an arbitrary string.
      const created = yield* postJson("/api/collections/posts", {
        title: "traversal",
        attachment: "../victim-delete.txt"
      })
      assert.strictEqual(created.status, 201)
      const rec = yield* readPost(created)

      const before = yield* fsExists(victim)
      const delRes = yield* delAnon(`/api/collections/posts/${rec.id}`)
      const after = yield* fsExists(victim)

      console.log("[H2][evidence] stored attachment:", rec.attachment)
      console.log("[H2][evidence] sentinel before delete:", before)
      console.log("[H2][evidence] DELETE status:", delRes.status)
      console.log("[H2][evidence] sentinel after delete:", after)

      // control: record delete still succeeds
      assert.strictEqual(delRes.status, 204)
      assert.strictEqual(before, true)
      assert.ok(after, "traversal delete removed a file outside the storage root (sentinel gone)")
    }).pipe(Effect.provide(layer))
  )

  it.effect("H2b replacing a file field must NOT delete a file outside the storage root (update path)", () =>
    Effect.gen(function* () {
      yield* resetTmp
      yield* setupTables
      yield* serveRouter()

      const victim = `${TMP}/victim-update.txt`
      yield* fsWrite(victim, "SENTINEL-DO-NOT-DELETE")

      const created = yield* postJson("/api/collections/posts", {
        title: "traversal-update",
        attachment: "../victim-update.txt"
      })
      assert.strictEqual(created.status, 201)
      const rec = yield* readPost(created)

      const before = yield* fsExists(victim)
      const upRes = yield* HttpClient.execute(
        HttpClientRequest.patch(`/api/collections/posts/${rec.id}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ attachment: "replacement.txt" })
        )
      )
      const after = yield* fsExists(victim)

      console.log("[H2b][evidence] sentinel before update:", before)
      console.log("[H2b][evidence] PATCH status:", upRes.status)
      console.log("[H2b][evidence] sentinel after update:", after)

      // control: update still succeeds
      assert.strictEqual(upRes.status, 200)
      assert.strictEqual(before, true)
      assert.ok(after, "replacement delete removed a file outside the storage root (sentinel gone)")
    }).pipe(Effect.provide(layer))
  )

  it.effect("H3 download route must NOT allow path traversal reads outside the root", () =>
    Effect.gen(function* () {
      yield* resetTmp
      yield* setupTables
      yield* serveRouter()

      const victim = `${TMP}/victim-read.txt`
      yield* fsWrite(victim, "SECRET-VICTIM-CONTENT")

      const created = yield* postJson("/api/collections/posts", {
        title: "read-traversal",
        attachment: "../victim-read.txt"
      })
      assert.strictEqual(created.status, 201)
      const rec = yield* readPost(created)

      const candidates = [
        "..%2Fvictim-read.txt",
        "..%252Fvictim-read.txt",
        "%2E%2E%2Fvictim-read.txt",
        "..%5Cvictim-read.txt",
        "..%2F%2Fvictim-read.txt"
      ]

      const observed: Array<{ enc: string; status: number; ct: string | undefined; body: string }> = []
      for (const enc of candidates) {
        const r = yield* get(`/api/files/posts/${rec.id}/${enc}`)
        const body = yield* r.text.pipe(Effect.orElseSucceed(() => "<no-body>"))
        observed.push({ enc, status: r.status, ct: r.headers["content-type"], body })
        console.log(`[H3][evidence] enc=${enc} status=${r.status} content-type=${r.headers["content-type"]} body=${JSON.stringify(body.slice(0, 80))}`)
      }

      const leaked = observed.filter((o) => o.body.includes("SECRET-VICTIM-CONTENT"))
      console.log("[H3][evidence] encodings leaking the sentinel:", leaked.length)

      // Second probe: read a real file outside the root.
      const pkgCreated = yield* postJson("/api/collections/posts", {
        title: "read-arbitrary",
        attachment: "../../../../package.json"
      })
      assert.strictEqual(pkgCreated.status, 201)
      const pkgRec = yield* readPost(pkgCreated)
      const pkgRes = yield* get(`/api/files/posts/${pkgRec.id}/..%2F..%2F..%2F..%2Fpackage.json`)
      const pkgBody = yield* pkgRes.text.pipe(Effect.orElseSucceed(() => "<no-body>"))
      console.log("[H3][evidence] arbitrary package.json read status:", pkgRes.status)
      console.log("[H3][evidence] arbitrary package.json read ct:", pkgRes.headers["content-type"])
      console.log("[H3][evidence] arbitrary package.json body (first 80):", JSON.stringify(pkgBody.slice(0, 80)))

      // Combine into one assertion so both violations surface in the failure.
      const traversalSecure = leaked.length === 0
      const arbitraryReadSecure = pkgRes.status !== 200
      assert.ok(
        traversalSecure && arbitraryReadSecure,
        `path traversal leaked ${leaked.length} encoding(s) [${leaked.map((l) => l.enc).join(", ")}]; ` +
          `arbitrary read of ../../../../package.json returned status ${pkgRes.status}`
      )
    }).pipe(Effect.provide(layer))
  )

  it.effect("H4 a large upload with no x-maxSize must be rejected by a default cap", () =>
    Effect.gen(function* () {
      yield* resetTmp
      yield* setupTables
      yield* serveRouter()

      const size = 10 * 1024 * 1024
      const bytes = new Uint8Array(size)
      for (let i = 0; i < size; i += 4096) bytes[i] = 65

      const fd = new FormData()
      fd.append("title", "big")
      fd.append("attachment", new Blob([bytes], { type: "application/octet-stream" }), "big.bin")

      const res = yield* HttpClient.execute(
        HttpClientRequest.bodyFormData(HttpClientRequest.post("/api/collections/posts"), fd)
      )
      const body = yield* res.text.pipe(Effect.orElseSucceed(() => "<no-body>"))

      console.log("[H4][evidence] uploaded bytes:", size)
      console.log("[H4][evidence] create status:", res.status)
      console.log("[H4][evidence] create body (first 120):", body.slice(0, 120))

      assert.ok(
        res.status >= 400 && res.status < 500,
        `unbounded upload accepted ${size} bytes with status ${res.status} (no default max size)`
      )
    }).pipe(Effect.provide(layer))
  )

  it.effect("H5 FileStorage.list must NOT enumerate or delete files outside the root", () =>
    Effect.gen(function* () {
      yield* resetTmp
      yield* setupTables
      yield* serveRouter()

      // ---- direct probe: list() with a traversal prefix ----
      yield* fsWrite(`${TMP}/evil-listed/a.txt`, "A")
      yield* fsWrite(`${TMP}/evil-listed/b.txt`, "B")

      const storage = yield* FileStorage
      const listedResult = yield* storage.list("../evil-listed/").pipe(Effect.result)
      const listedCount = Result.isSuccess(listedResult) ? listedResult.success.length : 0
      console.log(
        "[H5][evidence] direct list('../evil-listed/') =>",
        Result.isSuccess(listedResult) ? JSON.stringify(listedResult.success) : `failure: ${listedResult.failure}`
      )

      assert.strictEqual(
        listedCount,
        0,
        `list('../evil-listed/') enumerated ${listedCount} out-of-root file(s)`
      )

      // ---- end-to-end: delete path's thumbnail cleanup ----
      yield* fsWrite(`${TMP}/evil-amp/x.txt`, "X")
      yield* fsWrite(`${TMP}/evil-amp/y.txt`, "Y")

      const created = yield* postJson("/api/collections/posts", {
        title: "list-amp",
        attachment: "../../evil-amp"
      })
      assert.strictEqual(created.status, 201)
      const rec = yield* readPost(created)

      const beforeX = yield* fsExists(`${TMP}/evil-amp/x.txt`)
      const beforeY = yield* fsExists(`${TMP}/evil-amp/y.txt`)
      const delRes = yield* delAnon(`/api/collections/posts/${rec.id}`)
      const afterX = yield* fsExists(`${TMP}/evil-amp/x.txt`)
      const afterY = yield* fsExists(`${TMP}/evil-amp/y.txt`)

      console.log("[H5][evidence] amp before delete  x:", beforeX, "y:", beforeY)
      console.log("[H5][evidence] amp DELETE status:", delRes.status)
      console.log("[H5][evidence] amp after delete   x:", afterX, "y:", afterY)

      // control: delete still succeeds
      assert.strictEqual(delRes.status, 204)
      assert.strictEqual(beforeX, true)
      assert.strictEqual(beforeY, true)
      assert.ok(afterX, "amplified delete removed out-of-root evil-amp/x.txt")
      assert.ok(afterY, "amplified delete removed out-of-root evil-amp/y.txt")
    }).pipe(Effect.provide(layer))
  )
})
