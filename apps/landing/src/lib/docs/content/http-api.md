Mira exposes one generated REST surface for every collection, plus shared auth, file, schema, and telemetry routes. Collection routes at `/api/collections/:name` enforce the action's rule before touching data. This page covers routes, sessions, query parameters, upload limits, and status codes; [querying](../querying/) covers filtering and cursors and [auth](../auth/) covers credentials.

## Route table

| Method | Path | Purpose | Success |
|---|---|---|---|
| `GET` | `/api/collections/:name` | List records | `200` |
| `POST` | `/api/collections/:name` | Create a record (JSON or multipart) | `201` |
| `GET` | `/api/collections/:name/:id` | View one record | `200` |
| `PATCH` | `/api/collections/:name/:id` | Update a record | `200` |
| `DELETE` | `/api/collections/:name/:id` | Delete a record | `204` |
| `POST` | `/api/collections/:name/auth-with-password` | Log in; may return an OTP challenge | `200` |
| `POST` | `/api/collections/:name/auth-with-password/verify-otp` | Complete login OTP | `200` |
| `POST` | `/api/collections/:name/auth-with-password/resend-otp` | Reissue login OTP | `202` |
| `POST` | `/api/collections/:name/auth-with-otp/request` | Request a passwordless code | `202` |
| `POST` | `/api/collections/:name/auth-with-otp` | Complete passwordless login | `200` |
| `POST` | `/api/collections/:name/verify-email/request` | Request or resend a verification code | `202` |
| `POST` | `/api/collections/:name/verify-email` | Verify an email address | `200` |
| `POST` | `/api/collections/:name/password-reset/request` | Request a reset link | `202` |
| `POST` | `/api/collections/:name/password-reset` | Complete a password reset | `200` |
| `GET` | `/api/collections/:name/auth-config` | Public auth capability flags | `200` |
| `POST` | `/api/auth/logout` | Revoke the presented token | `204` |
| `POST` | `/api/auth/logout-all` | Revoke every session for the user | `204` |
| `GET` | `/api/auth/me` | Return the authenticated record | `200` |
| `GET` | `/api/files/:collection/:id/:filename` | Serve an uploaded file | `200` |
| `POST` | `/api/files/token` | Mint a short-lived file token | `200` |
| `GET` | `/api/_schema` | Collection schema introspection | `200` |
| `GET` | `/api/_telemetry/logs` | Read persisted logs | `200` |
| `GET` | `/api/_telemetry/spans` | Read persisted spans | `200` |

Unknown collections return `404`. View collections reject create, update, and delete with `405 read_only`; login against a non-auth collection is also `405`.

## Authentication and sessions

Send `Authorization: Bearer <token>`; if absent, Mira uses the `mira_token` cookie. Both paths run the same fail-closed check: session type, non-revoked `jti`, existing record, matching password fingerprint (`pwf`), and current generation. Any token-store error denies.

Log in with a JSON body:

```bash
curl -X POST http://localhost:8080/api/collections/users/auth-with-password \
  -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","password":"correct horse battery staple"}'
```

Success returns `{ token, record }`, with `record` hidden-field-stripped and boolean-decoded, and sets a `mira_token` cookie: `httpOnly`, `sameSite: strict`, `path: /`, 72 hours. A malformed body returns `422`; bad credentials return `403` without revealing the cause. If the auth collection requires login OTP, the response is `{ otpRequired: true, challengeId, expiresAt }` and no session is minted until `POST /auth-with-password/verify-otp` succeeds.

Email flows use the same `challengeId` + six-digit code shape. `POST /auth-with-otp/request` and `/verify-email/request` return `202 { challengeId }` even for unknown addresses; `POST /password-reset/request` returns a generic `202`. Invalid, expired, or replayed codes return `400`, too many attempts return `429`, and a missing transport returns `503 email_not_configured`. See the [email page](../email/) for the full route list and security rules.

`POST /api/auth/logout` revokes the presented `jti` best-effort and clears the cookie with `204`. `POST /api/auth/logout-all` requires a valid session, bumps the user's generation so earlier tokens are rejected, and returns `204`; without a session it returns `401`. `GET /api/auth/me` returns `{ collection, record }` with hidden fields stripped and booleans decoded.

`/api/_schema` and both telemetry routes require a session belonging to a plugin-declared admin collection. An app with no admin plugin has an empty admin set, so every authenticated session gets `403`; non-admin sessions get `403`, and missing or invalid tokens get `401`. The schema payload is an array of collection entries with `name`, `kind`, `fields`, `required`, `indexes`, `auth`, and `viewQuery`, preserving `x-system`, `x-hidden`, `x-generated`, and `x-kind`. `auth` carries the per-collection `x-auth.email` flags.

The telemetry routes accept `filter`, `after`, and `limit`; spans also accept `traceId`. Their cursor direction is the reverse of collection lists, and a bad filter returns `400`, not `422`.

## List parameters

`GET /api/collections/:name` accepts:

| Parameter | Meaning |
|---|---|
| `filter` | URL-encoded JSON `FilterNode`; invalid JSON or schema mismatch returns `422` |
| `sort` | Schema field name; unknown names are ignored |
| `order` | `asc` (default) or `desc` |
| `select` | Comma-separated field names to return |
| `expand` | Comma-separated relation field names to embed |
| `after` | `seqId` from the last page; non-negative integer |
| `limit` | Page size; default `30`, clamped to `100`; values below `1` fall back to `30` |

The response is a cursor page:

```json
{
  "items": [{ "id": "abc123", "title": "Hello" }],
  "nextCursor": 41
}
```

`seqId` is not included in ordinary list items; `nextCursor` carries it. Pass `nextCursor` as `after` for the next page. A full final page can still return a non-null cursor, so keep requesting until you get `null`; reads never run `COUNT(*)`. `after` always filters the internal `seqId`, even when `sort` names another field, so use the default order for a complete paged walk.

## Writes and uploads

Create and update accept JSON or `multipart/form-data`; file fields go through those routes:

```bash
curl -X POST http://localhost:8080/api/collections/posts \
  -H "Authorization: Bearer $MIRA_TOKEN" \
  -F 'title=Hello from curl' \
  -F 'cover=@./cover.png'
```

There is no separate upload endpoint. A multipart create returns `201`; an update returns `200`. Files are stored as `<uuid>.<extension>` (or `.bin`), and failed uploads delete every allocated key.

Multipart limits are fixed:

- Budget: `min(64 MiB, 1 MiB overhead + Σ x-maxSize)`, defaulting each file field to 8 MiB.
- At most 64 parts; non-file fields cap at 64 KiB.
- MIME types must be in the field's `x-mimeTypes` allowlist when declared.
- JSON `Content-Length` over 32 MiB is rejected before reading.

Over-budget or too many parts returns `413`; a bad field, unusable part, or a file over its own `x-maxSize` returns `422`. A chunked JSON body without `Content-Length` is not rejected by the pre-read size check.

## File serving

`GET /api/files/:collection/:id/:filename` requires a plain `filename` (no `/`, `\`, `..`, NUL) that exactly matches a file field on the record; otherwise `404`.

Unprotected fields are served directly. Protected fields (`x-protected`) need a `token` query parameter: a 5-minute file JWT whose `filecol` matches the collection, plus a passing `view` rule. Missing, invalid, or cross-collection tokens return `403`, as does a collection without a view rule. Admin-collection tokens bypass the rule.

Mint a file token for the current session:

```bash
curl -X POST http://localhost:8080/api/files/token \
  -H "Authorization: Bearer $MIRA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"collection":"posts"}'
```

The response is `{ token, expiresAt }`. The request needs a live session, and the issuer record must still exist. A missing body or `collection` field returns `422`; an unknown collection returns `404`. Set `MIRA_TOKEN` from the login response and use the returned file token as `FILE_TOKEN`.

Add `thumb` for a resized variant, for example `?token=$FILE_TOKEN&thumb=200x200t`. Specs are `WxH`, `WxHt` (cover), `WxHb` (contain), and `WxHf` (fill); unknown specs serve the original. Results cache at `_thumbs/<filename>/<spec>`, and resize failures fall back to the original.

## Listing example

```bash
curl -s "http://localhost:8080/api/collections/posts?limit=10&sort=created&order=desc&select=id,title" \
  -H "Authorization: Bearer $MIRA_TOKEN"
```

Build nested filters with the filter builder and let the client SDK encode them; hand-written JSON is easy to get wrong. See [querying](../querying/) for the AST and [auth](../auth/) for sessions.

## Status codes

Domain errors map to a fixed set of responses:

| Status | Cause |
|---|---|
| `400` | Bad telemetry filter or query parameter |
| `401` | Missing or invalid session where an admin session is required |
| `404` | Record, collection, file, or route target not found |
| `403` | Rule denial, failed credentials, missing or invalid file token |
| `422` | Schema validation failure, malformed JSON, bad filter, bad multipart field, or a file over its own `x-maxSize` |
| `405` | Write against a view collection, or login against a non-auth collection |
| `413` | JSON body, multipart budget, or part count over its limit |
| `502` | Storage backend failure |
| `500` | SQL error or an unexpected defect |

Errors are JSON with an `error` string and, where useful, `message` or `issues`. CORS headers appear on errors too. Collection and auth handlers emit server spans and annotate auth results as `anonymous`, `invalid_token`, or `authenticated`; file and logout routes are not guaranteed to carry the same annotations.
