Give your app sign-up, login, and a session a client can carry between requests. An auth collection is a normal collection with `email`, a hidden write-only `password`, and `emailVerified` added to its schema, and the credential checks run at the collection service write path.

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

A non-empty password is hashed server-side on create and update, at the collection service write path, and the plaintext is never stored. Write-time credential failures come back as `422` validation errors with an `issues` array.

Create with a non-empty password requires `passwordConfirm`, and it must equal `password`. `emailVerified` is manager-only: a non-manager cannot set it to `true` on create.

Update that changes the password requires `passwordConfirm`. A caller without manager access who changes the password or the email must also supply `oldPassword`. An empty `password` on update is dropped before hashing, so a blank edit form keeps the existing hash; do not create an account with an empty password.

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

A session is a signed JWT with `typ: "session"`, HS256, and a 72-hour expiry. It carries the user id (`sub`), the collection (`col`), a token id (`jti`), a password fingerprint (`pwf`), and a per-user generation (`gen`).

Every request resolves the token against the `TokenStore`: the `jti` must not be revoked, the auth record must still exist, `pwf` must match the current stored hash, and `gen` must match the current generation. Any store error denies the request, so authentication fails closed. Because `pwf` is derived from the password hash, changing a password invalidates every token minted before the change.

The token is read from the `Authorization: Bearer` header first, then from the `mira_token` cookie. Login sets that cookie as `httpOnly`, `sameSite: "strict"`, `path: "/"`, for 72 hours.

That is the browser path: the client never reads the cookie, `createMiraClient(url)` sends `credentials: "include"`, and `auth.ensureSession()` revalidates it against `/api/auth/me` on page load. For server-side rendering use `createMiraClient(url, { type: "server" })`, which authenticates with a bearer token you supply through `auth.setToken(token)`; `auth.isValid()` checks only the JWT expiry, not the signature.

Logout revokes the presented token id and clears the cookie:

```bash
curl -X POST http://localhost:8080/api/auth/logout -H "authorization: Bearer $TOKEN"
```

In browser mode, `mira.auth.clear()` calls that route and resets the local login flag. In server mode, `auth.clear()` only drops the local token, so call the route yourself to revoke it. To end every session for the user on all devices, call `logout-all`, which requires a valid session and bumps the generation:

```bash
curl -X POST http://localhost:8080/api/auth/logout-all -H "authorization: Bearer $TOKEN"
```

Both routes answer `204` on success. Tokens minted before a `logout-all` are rejected afterwards.

## Manager access

`manage` is an additive rule. It never bypasses the base create or update rule; it only escalates what a caller is already allowed to do. It applies to auth collections only, and a `manage` key on a base or view collection is a compile error. Add it to the binding whose other actions are on the [rules page](../rules/):

```ts
export const usersRules = defineRule(Users, (R) => ({
  // other actions, as on the rules page
  manage: R.and(
    R.authCollection().eq(R.literal("users")),
    R.auth(Users, "role").eq(R.literal("admin")),
  ),
}))
```

`manage` is not a substitute for the create rule: open signup still needs `create: R.public()` from the registration section above.

On create, `manage` is evaluated against the incoming payload with `emailVerified` forced to `false`, so the field it guards cannot be used to satisfy the rule. On update, it is evaluated against the stored record by id. A matching manager may set `email` and `emailVerified` and change a password without `oldPassword`; `passwordConfirm` is still required for password changes. `manage` has no effect on `list`, `view`, or `delete`.

The `authCollection` check matters when an app has more than one auth collection: `R.auth(Users, "role")` reads a role field from the authenticated actor, but the rule engine does not use the collection argument to verify which auth collection issued the token. Pairing it with `R.authCollection()` prevents a token from another auth collection with a matching role from satisfying the rule.

## Email flows

An auth collection opts into verification, login alerts, login OTP, passwordless login, and email changes with the third `AuthCollection.define()` argument, and every option defaults to off. The transport is selected in the builder with `.email(SmtpEmail(...))`; without it the flows are disabled and request endpoints return `503 email_not_configured`.

For a self-service address change, an authenticated user posts `{ newEmail, oldPassword }` to `POST /request-email-change` and confirms the mailed token at `POST /confirm-email-change`.

The flags, the transport config, the route table, the rate-limit budgets, and local testing are all on the [email page](../email/).

## Common mistakes

- A registration request returns 403: no `create` rule is attached, and a detached `defineRule` result does nothing until it is passed to `.rules([...])`.
- A create with an empty `password` fails validation, because `password` is required on create. An empty `password` on update is dropped instead, so a blank edit form keeps the existing hash.
- A signup that sends `role: "admin"` succeeds: public signup plus a client-writable role field hands out the role. Make the field server-managed, or set it in a plugin hook.

## Next

- [Querying and pagination](../querying/) to read the rows those sessions are allowed to see.
- [Client SDK and TanStack](../client-sdk/) for `raw`/`toEffect`, browser and server auth, and adapter options.
