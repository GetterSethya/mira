The dashboard is an optional `MiraPlugin` that adds an admin UI and management API to a Mira server. It contributes the `_superadmin` auth collection, token-gated first-boot registration, config and cron endpoints, and a per-collection Connect sheet that generates SDK snippets and a TypeScript file. Install it with one dependency and one `.extend()` call.

## Install and extend

```install
pnpm add @gettersethya/mira-dashboard
```

The snippet assumes your `Posts` and `Users` definitions are in scope; import them from the shared collections module. The dashboard is Node-only (it hashes passwords and reads `ui/dist`), so run it in the Node platform preset.

```ts
import {
  LocalFileStorage,
  Mira,
  NodePlatform,
  SqliteDatabase
} from "@gettersethya/mira"
import { MiraDashboard } from "@gettersethya/mira-dashboard"
import { Posts, Users } from "./collections.js"

const app = Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "data.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .collections([Posts, Users])
  .build()
  .extend(MiraDashboard)

app.serve()
```

`extend()` returns the same app. Plugin routes merge after the built-in collection routes under `/_dashboard/`; the SPA is served from the package's `ui/dist`, falling back to `index.html` for client-side routes.

## The `_superadmin` collection

`MiraDashboard` declares `adminCollections: [SuperAdminCollection]`. The app merges it into the served set and passes its name as the router's admin allowlist. A `_superadmin` session therefore gets `admin: true` on `/api/collections/*` and protected file downloads, skipping rule enforcement and hidden-field stripping. Treat a superadmin token as a root credential.

The collection is auth-kind with `email`, `password`, and a `name` field. Rules grant list, view, update, and delete only to `_superadmin` actors; `create` is public at the rule level. The registration token gates `POST /_dashboard/api/register`, but it does not close the generic `POST /api/collections/_superadmin` route. Because the create rule is public, that generic route can create a superadmin directly unless you override the rule or keep the route unreachable during first boot. Treat the first boot as a trusted window and restrict the generic collection route if it is exposed.

The browser-safe definition imports only `@gettersethya/mira-client`; rules attach server-side, keeping Node-only code out of the SPA bundle.

## First-boot registration

On every boot `onBootstrap` generates a fresh 32-byte hex token and checks `_superadmin` with an admin context:

- Empty collection: publish the token in memory and log `Register at: <applicationUrl>/_dashboard/register?token=<token>`.
- Non-empty: log the dashboard URL and leave the in-memory token alone.

The token is module-level state, never persisted, so it is lost on restart. `generateRegisterToken()` uses Node's `Buffer` and random bytes, which is another reason the dashboard runs on the Node platform. Because the token is only published while the collection is empty, a restart after bootstrapping mints nothing usable. Finish registration before exposing the server; to retry, remove the rows and restart. Registration creates a record but does not log you in; log in with the new superadmin through the normal auth route.

Check whether registration is still open:

```bash
curl -s http://localhost:8080/_dashboard/api/bootstrap-status
```

The response is `{ bootstrapped, message? }`; `message` appears only while empty. Register with:

```bash
curl -X POST http://localhost:8080/_dashboard/api/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"…","name":"Admin","token":"<token>"}'
```

The body requires `email`, `password`, `name`, and `token`. Success returns `201` with `{ id, email }`. A wrong token is `403 invalid_token`; an already-populated collection is `403 already_bootstrapped`. The record is created through `CollectionService` with `admin: true`, so hashing and validation follow the normal auth path.

## Dashboard API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/_dashboard/api/bootstrap-status` | no | Whether any superadmin exists |
| `POST` | `/_dashboard/api/register` | token | Create the first superadmin |
| `POST` | `/_dashboard/api/superadmin/create` | yes | Add another superadmin |
| `GET` | `/_dashboard/api/superadmin` | yes | List up to 500 superadmins |
| `DELETE` | `/_dashboard/api/superadmin/:id` | yes | Delete a superadmin |
| `GET` | `/_dashboard/api/config` | yes | Read the config snapshot plus live storage/email descriptions |
| `PUT` | `/_dashboard/api/config` | yes | Update editable application keys |
| `POST` | `/_dashboard/api/email/test` | yes | Send a test email to the authenticated superadmin |
| `GET` | `/_dashboard/api/crons` | yes | List cron state |
| `POST` | `/_dashboard/api/crons/:name/run` | yes | Run a cron immediately |

Auth routes take the token from `Authorization: Bearer` then the `mira_token` cookie, verify it against `AppConfig.jwtSecret`, and accept only `col === "_superadmin"`; anything else is `401`.

`POST /_dashboard/api/superadmin/create` takes `{ email, password }`, rejects duplicates with `409 email_taken`, and returns `201` with `{ id, email }`. `DELETE /_dashboard/api/superadmin/:id` returns `204` for an unknown id and `409 last_superadmin` when one or zero remain; success returns `204`, and downstream delete failures are swallowed.

## Config and crons

`GET /_dashboard/api/config` returns `{ appName, applicationUrl, port, values, editable, readOnly, secret, storage, email }`. `values` drops `cron_state` and the legacy S3/email keys. `storage` is the live `FileStorage.describe()` result (local directory or S3 endpoint/bucket/region) and `email` is the live `EmailService.describe()` result (transport, host, port, TLS, From, auth presence) — neither contains credentials. `editable` is only `app_name`, `application_url`, `port`, and `log_retention_days`. `readOnly` holds `jwt_secret`; `secret` names `jwt_secret`.

`PUT /_dashboard/api/config` accepts `{ values: Record<string, string> }`; any key outside the allowlist rejects the whole request with `400 not_editable`. Accepted keys upsert into `_config`, but the running process keeps resolved values, so changes apply after restart. S3 and email backends are selected in code with `.storage(...)` and `.email(...)`, not from this API.

`POST /_dashboard/api/email/test` sends to the authenticated superadmin's own address only. It returns `503 email_not_configured` when no transport is configured, `502 email_unavailable` when delivery fails, and is rate-limited per superadmin. The settings page exposes this as a separate Email diagnostics card.

The dashboard login page also handles the auth-email flows when the `_superadmin` collection enables them: it accepts `authWithPassword`'s `otpRequired` challenge, offers a passwordless code request when advertised by `GET /api/collections/_superadmin/auth-config`, and links to the public `/forgot-password` and `/_dashboard/reset-password` pages. Login alerts are sent through the same SMTP transport when `loginAlerts` is true.

`GET /_dashboard/api/crons` returns every cron's state with ISO dates and errors normalised to strings or `null`. `POST /_dashboard/api/crons/:name/run` calls `runNow(name)`, returning `204` on success and `404` for an unknown name. Last-run state persists across restarts, but live status starts as standby on boot.

## Connect sheet and generated snippets

Each collection page has a Connect action that builds copyable snippets and a TypeScript file from the live schema. Open a collection from the dashboard, choose Connect, and switch between the SDK, raw `fetch`, and generated-types tabs. The logic is plain functions in the plugin package, testable without a browser.

`generateCollectionFile(schemas, options?)` emits a client-side `mira.generated.ts` module with collection definitions, `PostsRecord` / `PostsCreate` / `PostsUpdate` aliases, and a `collections` map. The generated header marks it as client-only: it carries collection/field definitions but not server rules or indexes. It orders collections dependency-first by relation target with a cycle fallback, skips system fields, keeps non-system hidden fields as `{ hidden: true }`, appends `.view()` inside view collections, escapes view SQL, and imports only used symbols from `@gettersethya/mira-client`. A missing relation target downgrades to text with a comment.

`resolveSubset(schemas, rootName)` returns the root plus the transitive closure of its relation targets, dependency-first. `pascalCase(name)` produces deterministic identifiers and prefixes a leading digit with `_`.

`sdkSections`, `fetchSections`, and `curlSections` cover reads, auth, and writes; view collections get list/getOne plus a read-only note and no mutations; auth create bodies include `email`, `password`, and `passwordConfirm`. Install commands come from `installCommand(manager, packages)` for `pnpm`, `npm`, `yarn`, or `bun` (`npm` uses `install`, the others `add`).

## Security notes

A `_superadmin` session skips collection rules and can download protected files on any collection. Protect superadmin credentials and never hand the registration URL to someone who should not become an administrator. The registration token is single-process, in-memory, and logged only while the collection is empty; it is not recoverable after a restart. Config writes cannot change `jwt_secret`, so they cannot silently invalidate every session, but the value is still returned to authenticated superadmins.

For builder and storage wiring, see [server](../server/); for the superadmin credential model, see [auth](../auth/).
