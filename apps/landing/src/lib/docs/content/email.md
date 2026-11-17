Mira sends auth email (login OTP, passwordless codes, verification, password reset, email-change links, and login alerts) through one optional SMTP transport you select in the builder. The same `EmailService` backs every flow, and the dashboard shows the live transport read-only.

## Select the transport

Add `.email(SmtpEmail(...))` to the builder. Email is selected in code, the same way file storage is selected.

Every field accepts a plain value or an Effect `Config` value, resolved once when the layer is built:

```typescript
import { Config } from "effect"
import { Mira, NodePlatform, SmtpEmail, SqliteDatabase, LocalFileStorage } from "@gettersethya/mira"

Mira.builder()
  .platform(NodePlatform)
  .database(SqliteDatabase({ filename: "data.db" }))
  .storage(LocalFileStorage({ directory: "./uploads" }))
  .email(SmtpEmail({
    host: Config.String("SMTP_HOST"),
    port: Config.Number("SMTP_PORT"),
    secure: false,
    auth: {
      user: Config.String("SMTP_USER"),
      pass: Config.Redacted("SMTP_PASS")
    },
    from: "Mira <no-reply@example.com>"
  }))
  .collections([Users])
  .build()
  .serve()
```

`secure` means implicit TLS (usually port 465). Use `requireTLS: true` for STARTTLS.

`passwordResetUrl` defaults to `${applicationUrl}/reset-password?token={{token}}&collection={{collection}}`. `emailChangeUrl` defaults to `${applicationUrl}/email-change?token={{token}}&collection={{collection}}`. Both placeholders are required in either override.

Without `.email(...)` Mira uses a no-op `EmailService`: `enabled` is `false`, `send` fails with `EmailNotConfiguredError`, and email-dependent request endpoints return `503 email_not_configured`. A collection that requires login OTP fails at boot instead of silently downgrading to password-only.

Every send also passes through the rate-limit engine. The default store is SQLite. The default budgets are listed under [Rate limits and cost controls](#rate-limits-and-cost-controls). To use another store, pass a self-contained `RateLimitStore` layer:

```typescript
Mira.builder()
  // ...
  .rateLimits({
    store: MyRedisRateLimitStoreLayer,
    emailPolicies: {
      sendRecoveryHourly: { name: "email:send:recovery-hourly", limit: 300, windowMs: 3_600_000, onStoreError: "deny" }
    }
  })
```

The email code depends on the `RateLimiter` service, not on SQLite. The in-memory store is for tests and isolated processes. Production should use the SQLite default or a shared store. SQLite is single-node.

`SmtpEmail` does not import a mail library into the core service. The platform supplies a `MailTransport`. The Node preset is the only implementation that imports `nodemailer`, so the `EmailService` contract stays portable.

## Opt in per auth collection

Pass the third `AuthCollection.define()` argument:

```typescript
const Users = AuthCollection.define("users", {
  name: Field.text()
}, {
  email: {
    verification: true,
    loginAlerts: true,
    loginOtp: "required",
    passwordless: true,
    emailChange: true
  }
})
```

All options default to off:

| Option | Default | Meaning |
|---|---|---|
| `verification` | `false` | Send a verification OTP after registration. |
| `loginAlerts` | `false` | Send an alert after a successful password or OTP login. |
| `loginOtp` | `"off"` | Require an OTP after a correct password. |
| `passwordless` | `false` | Allow email-OTP login. |
| `emailChange` | `false` | Allow self-service email changes through a confirmation link. |

The flags are serialized as `x-auth.email` and are available from the public `GET /api/collections/:name/auth-config` projection, with defaults applied. The admin `GET /api/_schema` also carries them for the dashboard and codegen.

## Customize templates

`.emailTemplates()` replaces any of the six built-in messages. Overrides are render functions, not mustache strings, so each template keeps its typed input:

```typescript
Mira.builder()
  // ... required steps
  .emailTemplates({
    defaults: {
      loginOtp: ({ appName, code, expiresMinutes }) => ({
        subject: `Your ${appName} login code`,
        text: `Your code is ${code}. It expires in ${expiresMinutes} minutes.`
      })
    },
    collections: {
      users: {
        verification: ({ appName, code }) => ({
          subject: `Confirm your ${appName} address`,
          text: `Your code is ${code}.`,
          html: `<p>Your code is <strong>${escapeHtml(code)}</strong>.</p>`
        })
      }
    }
  })
```

| Template id | Input | Default subject |
|---|---|---|
| `verification` | `appName`, `email`, `code`, `expiresMinutes` | `Verify your <app> email` |
| `loginOtp` | `appName`, `email`, `code`, `expiresMinutes` | `Your <app> login code` |
| `passwordless` | `appName`, `email`, `code`, `expiresMinutes` | `Your <app> sign-in code` |
| `passwordReset` | `appName`, `email`, `resetUrl`, `expiresMinutes` | `Reset your <app> password` |
| `emailChange` | `appName`, `currentEmail`, `newEmail`, `confirmUrl`, `expiresMinutes` | `Confirm your new <app> email` |
| `loginAlert` | `appName`, `collection`, `email`, `ip`, `userAgent`, `time` | `New sign-in to <app>` |

A renderer returns `{ subject, text, html?, replyTo?, headers? }`. The recipient (`to`) belongs to the auth flow, so an override cannot silently send mail somewhere else. Resolution order is:

1. `collections[<name>][<id>]`: one auth collection
2. `defaults[<id>]`: every collection
3. the built-in renderer

A collection that only overrides `verification` keeps the built-in login OTP, password reset, email-change, login-alert, and passwordless messages unchanged. With no `.emailTemplates()` at all, every message is byte-for-byte the default.

`collections` keys are validated at build time: an unknown name or a non-auth collection throws instead of silently falling back.

Custom HTML is trusted application code. Escape any interpolated user data with the exported `escapeHtml(value)` helper, and do not pass untrusted input into `subject`. Mira strips CR/LF from rendered subjects so a custom subject cannot inject mail headers. `sanitizeEmailSubject` is exported for the same check in your own tooling.

## Preview in the dashboard

The dashboard's collection schema dialog includes an email tab for auth collections. It reads `GET /_dashboard/api/email/templates?collection=<name>` (superadmin-authenticated) and shows all six effective templates with a `source` badge (`builtin`, `global`, or `collection`), the subject, the plain text, and the HTML source.

The preview uses fixed sentinel inputs (`user@example.invalid`, `203.0.113.10`, sample tokens, a fixed timestamp), never live challenge data. It returns no recipient, no live reset link, and no SMTP configuration, and it works while the transport is disabled. The response's `transportEnabled` flag tells the UI whether mail can actually be sent. HTML is displayed as escaped source text, never rendered.

## Routes

Auth email routes live under `/api/collections/:name`. [HTTP API and files](../http-api/) owns the exact rows and status codes. The groups below explain each flow.

### Password login and OTP

- `POST /api/collections/:name/auth-with-password`
- `POST /api/collections/:name/auth-with-password/verify-otp`
- `POST /api/collections/:name/auth-with-password/resend-otp`

With `loginOtp: "required"`, a correct password returns `{ otpRequired: true, challengeId, expiresAt }` instead of a token. Verify the six-digit code at `verify-otp`. `resend-otp` reissues it under the cooldown and budget.

### Passwordless

- `POST /api/collections/:name/auth-with-otp/request`
- `POST /api/collections/:name/auth-with-otp`

With `passwordless: true`, `auth-with-otp/request` sends a six-digit code and returns `202 { challengeId, expiresAt }` even for unknown addresses. `auth-with-otp` exchanges the code for `{ token, record }`.

### Verification

- `POST /api/collections/:name/verify-email/request`
- `POST /api/collections/:name/verify-email`

`verify-email/request` sends or resends a code and always returns `202 { challengeId, expiresAt }`. `verify-email` marks the address verified with `{ verified: true }`.

When `verification` is on, registration sends a code and the create response carries `emailVerification: { challengeId, expiresAt }`.

If the verification mail is rate-limited or the limiter is unavailable, the account is still created and the response carries `verificationDeferred: true` instead. A rate limit also includes `verificationRetryAfterSeconds`. Call `verify-email/request` later to retry.

Password login remains allowed while `emailVerified` is false. An app that needs a verified address can add a rule such as `R.auth(Users, "emailVerified").eq(R.literal(true))`.

### Reset

- `POST /api/collections/:name/password-reset/request`
- `POST /api/collections/:name/password-reset`

`password-reset/request` sends a 256-bit token link and always returns a generic `202 { message }`. `password-reset` consumes the token, updates the password, and returns `{ ok: true }`.

### Email change

- `POST /api/collections/:name/request-email-change`
- `POST /api/collections/:name/confirm-email-change`

`request-email-change` takes `{ newEmail, oldPassword }` plus the session token and checks the current password with the login budgets. It sends a 30-minute confirmation link to the new address and always returns the same generic `202 { message }`. If the address belongs to another account, no mail is sent and the response does not change, so the endpoint does not reveal that it is taken.

The link opens `emailChangeUrl`. The client posts its `token` to `confirm-email-change` as `{ token }`. Confirmation sets `email` and `emailVerified: true`, bumps the token generation so every existing session is invalidated, and consumes the user's other outstanding challenges. A change to the current address returns `422 email_unchanged`. Confirmation can return `409 email_taken` if the address became taken in the meantime.

`GET /api/collections/:name/auth-config` returns `{ collection, emailConfigured, email }`, the public flags with defaults applied, and needs no session.

## Security and limits

- Email verification, login OTP, and passwordless codes are six digits, HMAC-hashed at rest, single-use, and expiring.
- Password reset and email change use 256-bit tokens whose SHA-256 hashes are stored.
- One live challenge exists per `(collection, user, purpose)`. Issuing a new code supersedes the old one.
- Request endpoints return the same `202` + `challengeId` shape for known and unknown emails and detach the send. The pre-lookup rate checks and cooldown are account-agnostic, so timing does not reveal whether the address exists.
- A live challenge's attempt limit can still distinguish a real challenge from a dummy one. That is a pre-existing OTP property.
- Login OTP awaits delivery. A failed send returns `503 email_unavailable` and does not leave a challenge.
- Password reset consumes the token, updates the password through the collection service, bumps the token generation, and consumes all outstanding challenges for that user.
- Email change requires an authenticated session and the current password. Confirmation is sent only to the new address. Success sets `emailVerified` and invalidates every session and outstanding challenge for the user.
- The internal auth-flow write context may set only `password` or `emailVerified` for the challenge's own user. The separate email-change context may set only `email` and `emailVerified`. Neither is `admin: true`.
- Login alerts are detached and skipped when email is disabled. Failures are logged, never surfaced to the login response.

## Rate limits and cost controls

Every email request and every `EmailService.send` consumes a policy. Request policies fail open if the limiter store is down and log a warning. Send policies fail closed with `503 rate_limit_unavailable`, so a broken limiter does not become an open relay.

Default policies:

| Policy | Key | Limit | Window |
|---|---|---:|---:|
| `email:request:recovery-ip` | peer IP | 60 | 15 min |
| `email:request:login-ip` | peer IP | 30 | 15 min |
| `email:request:recipient` | address + purpose | 5 | 15 min |
| `email:request:cooldown` | address + purpose | 1 | 60 s |
| `email:request:login-cooldown` | address + purpose | 1 | 30 s |
| `email:send:recovery-hourly` | global | 300 | 1 hour |
| `email:send:recovery-daily` | global | 3,000 | 24 hours |
| `email:send:login-hourly` | global | 200 | 1 hour |
| `email:send:login-daily` | global | 2,000 | 24 hours |
| `email:send:notification-hourly` | global | 200 | 1 hour |
| `email:send:notification-daily` | global | 2,000 | 24 hours |
| `email:send:collection` | collection + class | 300 | 1 hour |
| `email:send:recipient` | address + purpose | 10 | 1 hour |
| `email:dashboard:test` | superadmin | 5 | 1 hour |

Recovery mail is password reset, email verification, and email change. Login mail is login OTP and passwordless codes. Notification mail is login alerts, dashboard test mail, and plugin `custom` sends.

The three budgets are separate, so reset spam cannot exhaust the login OTP budget and a notification flood cannot starve either security flow. Recovery and login OTP also use separate IP and recipient buckets, so reset spam cannot block OTP login for the same address or proxy.

The send budgets are all-or-nothing: if one recipient is over budget, the global and collection counters are not charged. The daily budgets are the hard cost ceiling. The hourly budgets bound the rate. A transport failure still consumes the attempted budget.

Changing `jwt_secret` changes the HMAC key space. Old buckets become unreachable and are pruned.

All policies use fixed windows. A cooldown can therefore allow two requests around a window boundary. The recipient and send limits still bound the burst.

Login alerts and plugin `custom` mail share the notification budget, so abuse can exhaust alerts without affecting security mail.

Password reset, verification, email change, and passwordless request sends are detached: a send-budget block is logged (`email.rate_limited`) and the request still returns its generic `202`. A `202` means the request was accepted, not that mail was delivered.

`429` responses carry `retryAfterSeconds`, `scope` (`request`, `cooldown`, or `send`), and a `Retry-After` header. The default CORS config exposes `Retry-After`. Browser clients can also read the body field.

A request endpoint returning `429` is a normal backoff signal, not an account-existence answer. `too_many_attempts` also carries `restart: true`: the challenge is dead and the client must request a new code.

`clientIp` uses `HttpServerRequest.remoteAddress`. It does not trust `X-Forwarded-For` or `X-Real-IP`, which are spoofable without a trusted-proxy configuration.

Behind a plain L7 proxy every user shares the proxy's bucket. Preserve the peer address at the socket level or plan a `trustProxy` option.

A missing peer address skips the IP policy and logs `rate_limit.ip_unavailable`. It never collapses all callers into one `"unknown"` bucket. IPv4-mapped IPv6 collapses to IPv4, and IPv6 buckets by `/64`.

The SQLite store is single-node. A multi-instance deployment needs a shared `RateLimitStore`. The email code does not change when you swap it.

## Plugins

Plugins can use `EmailService` directly and observe sends:

```typescript
MiraPlugin.define({
  onEmailSend: {
    collections: ["users"],
    handler: (ctx) => Effect.succeed({ ...ctx, message: { ...ctx.message, subject: `[Mira] ${ctx.message.subject}` } })
  },
  onEmailSent: {
    handler: (ctx) => Effect.log(`sent ${ctx.purpose} to ${String(ctx.message.to)}`)
  },
  onEmailError: {
    handler: (ctx) => Effect.logWarning(`email failed: ${ctx.error.code}`)
  }
})
```

`onEmailSend` runs serially, may rewrite the message, and may set `skip: true` to cancel the send. Its chain has a 2-second fail-open timeout.

A skipped message consumes no budget. A rewritten recipient is charged on the rewritten address. `onEmailSent` and `onEmailError` are detached observers. `onEmailError` never fires for `EmailNotConfiguredError` or a rate limit.

Plugin layers, `onBootstrap`, and routes may `yield* EmailService`. When email is not configured the referenced service reports `enabled: false`. Plugin sends consume the notification budget and cannot bypass the send limits.

## Dashboard and local testing

Settings -> App shows the live storage and email descriptions read-only. There are no editable SMTP fields in the dashboard. Change the builder and restart.

The Email diagnostics card sends a test message only to the authenticated superadmin's own address. It is limited to five per hour per superadmin and returns `429` with `retryAfterSeconds` when blocked. A shared send-budget block looks the same to the UI.

For local testing, no paid provider is needed:

```bash
docker run -d --name mira-mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
```

Mailpit listens on `localhost:1025` for SMTP and serves the inbox at `http://localhost:8025`. Point `SmtpEmail` at that host and port.

Automated tests use an in-process `smtp-server`, so CI needs no Docker or account. The same `SmtpEmail` transport works on Bun. Use `BunPlatform` and `BunSqliteDatabase` from `@gettersethya/mira/bun` and keep the email config unchanged.

## Next

Continue to the [Dashboard plugin](../dashboard/) for the live email cards, or look up the exact routes and status codes in [HTTP API and files](../http-api/).
