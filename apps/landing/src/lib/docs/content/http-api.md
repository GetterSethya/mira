Every Mira collection gets a generated REST surface, plus shared auth, file, schema, and telemetry routes that enforce the action's rule before touching data. Use this page to look up a route, a status code, an upload limit, or a file rule.

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
| `POST` | `/api/collections/:name/request-email-change` | Send a confirmation link to a new address | `202` |
| `POST` | `/api/collections/:name/confirm-email-change` | Complete an email change by token | `200` |
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

## Sessions

Send `Authorization: Bearer <token>`; if the header is absent, Mira uses the `mira_token` cookie. [Auth collections and sessions](../auth/) owns credential checks, session lifetime, and token invalidation.

## Admin and telemetry routes

`/api/_schema` and both telemetry routes require a session belonging to a plugin-declared admin collection. An app with no admin plugin has an empty admin set, so every authenticated session gets `403`; missing or invalid tokens get `401`.

The schema payload lists each collection's name, kind, fields, required names, indexes, auth flags, and view query; [Collections and fields](../collections/) owns the annotations.

The telemetry routes accept `filter`, `after`, and `limit` (spans also accept `traceId`), run newest-first, and return `400` rather than `422` for a bad filter.

## List parameters

`GET /api/collections/:name` accepts three groups of list parameters:

- `filter` — a URL-encoded JSON `FilterNode`.
- `sort`, `order`, `select`, `expand` — the sort field and direction, the field projection, and relation embedding.
- `after`, `limit` — the `seqId` cursor and page size; `limit` defaults to `30` and is clamped to `100`.

The response is `{ items, nextCursor }`. [Querying and pagination](../querying/) owns the full parameter table, the filter AST, cursor semantics, and caching.

## Writes and uploads

Create and update accept JSON or `multipart/form-data`; file fields go through those routes:

```bash
curl -X POST http://localhost:8080/api/collections/posts \
  -H "Authorization: Bearer $MIRA_TOKEN" \
  -F 'title=Hello from curl' \
  -F 'cover=@./cover.png'
```

There is no separate upload endpoint. A multipart create returns `201`; an update returns `200`.

Files are stored as `<uuid>.<extension>` (or `.bin`), and failed uploads delete every allocated key.

Multipart limits are fixed:

- Budget: `min(64 MiB, 1 MiB overhead + Σ x-maxSize)`, defaulting each file field to 8 MiB.
- At most 64 parts; non-file fields cap at 64 KiB.
- JSON `Content-Length` over 32 MiB is rejected before reading.

File field constraints such as `x-maxSize`, `x-mimeTypes`, and `x-protected` are documented with the field definitions in [Collections and fields](../collections/).

Over-budget or too many parts returns `413`; a bad field, unusable part, or a file over its field limit returns `422`. A chunked JSON body without `Content-Length` is not rejected by the pre-read size check.

## File serving

`GET /api/files/:collection/:id/:filename` requires a plain `filename` (no `/`, `\`, `..`, NUL) that exactly matches a file field on the record; otherwise `404`.

Unprotected fields are served directly. Protected fields need a `token` query parameter: a 5-minute file JWT whose `filecol` matches the collection, plus a passing `view` rule. Missing, invalid, or cross-collection tokens return `403`, as does a collection without a view rule. Admin-collection tokens bypass the rule.

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

Build nested filters with the filter builder and let the client SDK encode them; hand-written JSON is easy to get wrong. See [Querying and pagination](../querying/) for the AST.

## Status codes

Domain errors map to a fixed set of responses:

| Status | Cause |
|---|---|
| `400` | Bad telemetry filter or query parameter |
| `401` | Missing or invalid session where an admin session is required |
| `403` | Rule denial, failed credentials, missing or invalid file token |
| `404` | Record, collection, file, or route target not found |
| `405` | Write against a view collection, or login against a non-auth collection |
| `409` | Email change target became taken in the meantime |
| `413` | JSON body, multipart budget, or part count over its limit |
| `422` | Schema validation failure, malformed JSON, bad filter, bad multipart field, a file over its own field limit, or an unchanged email change |
| `429` | Auth email request/cooldown limit (`rate_limited`) or an exhausted OTP attempt budget (`too_many_attempts`); includes `retryAfterSeconds` and `Retry-After` |
| `500` | SQL error or an unexpected defect |
| `502` | Storage backend failure, or a dashboard test email the transport rejected |
| `503` | `email_not_configured`, `email_unavailable`, or `rate_limit_unavailable` |

Errors are JSON with an `error` string and, where useful, `message`, `issues`, `retryAfterSeconds`, or `scope`. CORS headers appear on errors too.

The default CORS config exposes `Retry-After`; a custom config must list it in `exposedHeaders` for browser clients to read the header. Collection and auth handlers emit server spans and annotate auth results as `anonymous`, `invalid_token`, or `authenticated`; file and logout routes are not guaranteed to carry the same annotations.

## Next

Look up a symbol in [API reference](../api/), or return to [Getting started](../getting-started/) for a fresh app.
