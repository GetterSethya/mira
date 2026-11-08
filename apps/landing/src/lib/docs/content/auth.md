An auth collection adds users, passwords, and sessions to a Mira app. It is a normal collection with three extra system fields, server-side password hashing, credential checks at the write path, and a login route that mints a session token. This page covers defining the collection, the credential rules, registration and login, session transport, and the additive `manage` rule. Rule evaluation itself is covered on the [rules page](../rules/) and the client auth methods on the [client SDK page](../client-sdk/).

## Define an auth collection

Pass extra fields only. `email`, `password`, and `emailVerified` are system fields and cannot be redeclared.

```ts
import { AuthCollection, Field } from "@gettersethya/mira"

export const Users = AuthCollection.define("users", {
  displayName: Field.text({ required: true, minLength: 1 }),
  role: Field.literalText({ literal: ["member", "admin"], default: "member" }),
})
```

The builder injects `email` (unique index), `password` (hidden, write-only, `x-kind: "password"`), and `emailVerified` (boolean, default `false`), on top of `id`, `seqId`, `created`, and `updated`. `email` and `password` are required on create; `emailVerified` defaults to `false`. Field semantics are on the [collections page](../collections/).

## Passwords and credential checks

A non-empty password is hashed server-side on create and update, at the collection service write path, and the plaintext is never stored. An empty `password` on update is dropped before hashing, so a blank edit form keeps the existing hash; do not create an account with an empty password. Write-time credential failures come back as `422` validation errors with an `issues` array.

The checks depend on who is calling:

- Create with a non-empty password requires `passwordConfirm`, and it must equal `password`.
- Update that changes the password requires `passwordConfirm`.
- A caller without manager access who changes the password or the email must also supply `oldPassword`.
- `emailVerified` is manager-only: a non-manager cannot set it to `true` on create or change it on update.

Who counts as a manager is either an admin request context (used by the dashboard plugin) or an authenticated actor matching the collection's `manage` rule. Admins bypass the credential checks entirely.

## Register a user

Registration is an ordinary create against the collection's route, so open signup requires the create rule to allow it. For a public signup flow, add `create: R.public()` to the auth collection's rules:

```ts
import { defineRule } from "@gettersethya/mira"

export const usersRules = defineRule(Users, (R) => ({
  create: R.public(),
}))
```

Attach the binding with `.rules([usersRules])` on `Mira.builder()`; a detached `defineRule` result does nothing by itself. Then register over HTTP or through the client. The client snippets below assume `mira = createMiraClient(url).withCollections({ users: Users })`. `register()` wraps the create endpoint and does not log the user in; call `authWithPassword()` afterwards if you want a session.

```bash
curl -X POST http://localhost:8080/api/collections/users \
  -H "content-type: application/json" \
  -d '{"displayName":"Ada","email":"ada@example.com","password":"correct-horse","passwordConfirm":"correct-horse"}'
```

```ts
const user = await mira.users.register().raw({
  displayName: "Ada",
  email: "ada@example.com",
  password: "correct-horse",
  passwordConfirm: "correct-horse",
})
```

The response is the stored record with hidden fields stripped.

## Log in and read the current user

Login lives at `POST /api/collections/:name/auth-with-password` and expects a JSON body with `email` and `password`. A non-auth collection answers `405`; a malformed body answers `422`; bad credentials answer `403` without saying which part failed. A successful login returns `{ token, record }` and sets the session cookie.

```bash
curl -X POST http://localhost:8080/api/collections/users/auth-with-password \
  -H "content-type: application/json" \
  -d '{"email":"ada@example.com","password":"correct-horse"}'
```

```ts
const { token, record } = await mira.users.authWithPassword().raw({
  email: "ada@example.com",
  password: "correct-horse",
})
```

`GET /api/auth/me` returns the authenticated user as `{ collection, record }`, with hidden fields stripped and boolean columns decoded to real booleans. The client's `me()` unwraps that envelope and rejects with a `401` `MiraError` when the session belongs to a different collection.

```ts
const me = await mira.users.me().raw()
```

```bash
curl http://localhost:8080/api/auth/me -H "authorization: Bearer $TOKEN"
```

## Sessions

A session is a signed JWT with `typ: "session"`, HS256, and a 72-hour expiry, carrying the user id (`sub`), the collection (`col`), a token id (`jti`), and a password fingerprint (`pwf`) plus a per-user generation (`gen`). Every request resolves the token against the `TokenStore`: the `jti` must not be revoked, the auth record must still exist, `pwf` must match the current stored hash, and `gen` must match the current generation. Any store error denies the request, so authentication fails closed. Because `pwf` is derived from the password hash, changing a password invalidates every token minted before the change.

The token is read from the `Authorization: Bearer` header first, then from the `mira_token` cookie. Login sets that cookie as `httpOnly`, `sameSite: "strict"`, `path: "/"`, for 72 hours. That is the browser path: the client never reads the cookie, `createMiraClient(url)` sends `credentials: "include"`, and `auth.ensureSession()` revalidates it against `/api/auth/me` on page load. For server-side rendering use `createMiraClient(url, { type: "server" })`, which authenticates with a bearer token you supply through `auth.setToken(token)`; `auth.isValid()` checks only the JWT expiry, not the signature.

Logout revokes the presented token id and clears the cookie:

```bash
curl -X POST http://localhost:8080/api/auth/logout -H "authorization: Bearer $TOKEN"
```

In browser mode, `mira.auth.clear()` calls that route and resets the local login flag. In server mode, `auth.clear()` only drops the local token, so call the route yourself to revoke it. To end every session for the user on all devices, call `logout-all`, which requires a valid session and bumps the generation:

```bash
curl -X POST http://localhost:8080/api/auth/logout-all -H "authorization: Bearer $TOKEN"
```

Both routes answer `204` on success. Tokens minted before a `logout-all` are rejected afterwards.

## Grant manager access with the manage rule

`manage` is an additive rule. It never bypasses the base create or update rule; it only escalates what a caller already allowed to do. It applies to auth collections only, and a `manage` key on a base or view collection is a compile error. The complete rule set, with a manager path:

```ts
export const usersRules = defineRule(Users, (R) => ({
  list: R.public(),
  view: R.field("id").eq(R.selfId()),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  manage: R.and(
    R.authCollection().eq(R.literal("users")),
    R.auth(Users, "role").eq(R.literal("admin")),
  ),
}))
```

On create, the rule is evaluated against the incoming payload with `emailVerified` forced to `false`, so the field it guards cannot be used to satisfy the rule. On update, it is evaluated against the stored record by id. A matching manager may set `email` and `emailVerified` and change a password without `oldPassword`; `passwordConfirm` is still required for password changes. The base `update` rule still decides which rows a manager can reach, so `manage` adds privileges rather than granting access. `manage` has no effect on `list`, `view`, or `delete`.

The `authCollection` check matters when an app has more than one auth collection: `R.auth(Users, "role")` reads a role field from the authenticated actor, but the rule engine does not use the collection argument to verify which auth collection issued the token. Pairing it with `R.authCollection()` prevents a token from another auth collection with a matching role from satisfying the rule.

Do not let public signup choose a privileged role. A client-writable `role` field combined with `create: R.public()` lets a signup send `"role": "admin"`. Make the field server-managed, or set it in a plugin hook, and test the create rule before opening signup.

## Next steps

- [Access rules](../rules/) for per-action evaluation and rule syntax.
- [Client SDK and TanStack](../client-sdk/) for `raw`/`toEffect`, browser and server auth, and adapter options.
- [HTTP API and files](../http-api/) for route details, cookies, and file tokens.
