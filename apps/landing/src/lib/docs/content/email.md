Mira can send email through an optional SMTP transport. The same service powers login alerts, password reset, email verification, login OTP, and passwordless login. Email is selected in code, the same way file storage is selected, and the dashboard shows the live transport read-only.

## Select the transport

Add `.email(SmtpEmail(...))` to the builder. Every field accepts a plain value or an Effect `Config` value, resolved once when the layer is built:

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

`secure` means implicit TLS (usually port 465). Use `requireTLS: true` for STARTTLS. `passwordResetUrl` defaults to `${applicationUrl}/reset-password?token={{token}}&collection={{collection}}`; both placeholders are required.

Without `.email(...)` Mira uses a no-op `EmailService`. `EmailService.enabled` is `false`, `send` fails with `EmailNotConfiguredError`, and email-dependent request endpoints return `503 email_not_configured`. A collection that requires login OTP fails at boot instead of silently downgrading to password-only.

Every send also passes through the rate-limit engine. The default store is SQLite; the default budgets are listed under [Rate limits and cost controls](#rate-limits-and-cost-controls). To use another store, pass a self-contained `RateLimitStore` layer:

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

The email code depends on the `RateLimiter` service, not on SQLite. The in-memory store is for tests and isolated processes; production should use the SQLite default or a shared store. SQLite is single-node.

`SmtpEmail` does not import a mail library into the core service. The platform supplies a `MailTransport`; the Node preset is the only implementation that imports `nodemailer`, so the `EmailService` contract stays portable.

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
    passwordless: true
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

The flags are serialized as `x-auth.email` and are available from the public `GET /api/collections/:name/auth-config` projection (with defaults applied). The admin `GET /api/_schema` also carries them for the dashboard and codegen.

## Routes

| Method | Route | Success | Other outcomes |
|---|---|---|---|
| `POST` | `/api/collections/:name/auth-with-password` | `{ token, record }` or `{ otpRequired: true, challengeId, expiresAt }` | `429 rate_limited` when the login OTP budget is blocked |
| `POST` | `/api/collections/:name/auth-with-password/verify-otp` | `{ token, record }` | `400 invalid_code`, `429 too_many_attempts` |
| `POST` | `/api/collections/:name/auth-with-password/resend-otp` | `202 { challengeId, expiresAt }` | `429 rate_limited` (cooldown or budget) |
| `POST` | `/api/collections/:name/auth-with-otp/request` | `202 { challengeId, expiresAt }` | `404 not_found`, `429 rate_limited`, `503 email_not_configured` |
| `POST` | `/api/collections/:name/auth-with-otp` | `{ token, record }` | `400 invalid_code`, `429 too_many_attempts` |
| `POST` | `/api/collections/:name/verify-email/request` | `202 { challengeId, expiresAt }` | `404 not_found`, `429 rate_limited`, `503 email_not_configured` |
| `POST` | `/api/collections/:name/verify-email` | `{ verified: true }` | `400 invalid_code`, `429 too_many_attempts` |
| `POST` | `/api/collections/:name/password-reset/request` | `202 { message }` | `429 rate_limited`, `503 email_not_configured` |
| `POST` | `/api/collections/:name/password-reset` | `{ ok: true }` | `400 invalid_token`, `422 validation_failed` |
| `GET` | `/api/collections/:name/auth-config` | `{ collection, emailConfigured, email }` | `404 not_found` |

Registration sends a verification OTP when the collection enables it. The create response is the public record plus `emailVerification: { challengeId, expiresAt }`. If the verification mail is rate-limited or the limiter is unavailable, the account is still created and the response carries `verificationDeferred: true` instead; a rate limit also includes `verificationRetryAfterSeconds`. The client can call `verify-email/request` later. Password login remains allowed while `emailVerified` is false; use a rule such as `R.auth(Users, "emailVerified").eq(R.literal(true))` if an app needs to restrict access.

## Security and limits

- Email verification, login OTP, and passwordless codes are six digits, HMAC-hashed at rest, single-use, and expiring.
- Password reset uses a 256-bit token whose SHA-256 hash is stored.
- One live challenge exists per `(collection, user, purpose)`; issuing a new code supersedes the old one.
- Request endpoints return the same `202` + `challengeId` shape for known and unknown emails and detach the send. The pre-lookup rate checks and cooldown are account-agnostic, so timing does not reveal whether the address exists. A live challenge's attempt limit can still distinguish a real challenge from a dummy one; that is a pre-existing OTP property.
- Login OTP awaits delivery; a failed send returns `503 email_unavailable` and does not leave a challenge.
- Password reset consumes the token, updates the password through the collection service, bumps the token generation, and consumes all outstanding challenges for that user.
- The internal auth-flow write context may set only `password` or `emailVerified` for the challenge's own user. It is not `admin: true`.
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

Recovery mail is password reset and email verification. Login mail is login OTP and passwordless codes. Notification mail is login alerts, dashboard test mail, and plugin `custom` sends. The three budgets are separate, so reset spam cannot exhaust the login OTP budget and a notification flood cannot starve either security flow. Recovery and login OTP also use separate IP and recipient buckets, so reset spam cannot block OTP login for the same address or proxy.

The send budgets are all-or-nothing: if one recipient is over budget, the global and collection counters are not charged. The daily budgets are the hard cost ceiling; the hourly budgets bound the rate. A transport failure still consumes the attempted budget. Changing `jwt_secret` changes the HMAC key space; old buckets become unreachable and are pruned.

All policies use fixed windows. A cooldown can therefore allow two requests around a window boundary; the recipient and send limits still bound the burst. Login alerts and plugin `custom` mail share the notification budget, so abuse can exhaust alerts without affecting security mail. Password reset, verification, and passwordless request sends are detached: a send-budget block is logged (`email.rate_limited`) and the request still returns its generic `202`; `202` means "accepted", not "delivered".

`429` responses carry `retryAfterSeconds`, `scope` (`request`, `cooldown`, or `send`), and a `Retry-After` header. The default CORS config exposes `Retry-After`; browser clients can also read the body field. A request endpoint returning `429` is a normal backoff signal, not an account-existence answer. `too_many_attempts` also carries `restart: true`: the challenge is dead and the client must request a new code.

`clientIp` uses `HttpServerRequest.remoteAddress`. It does not trust `X-Forwarded-For` or `X-Real-IP`, which are spoofable without a trusted-proxy configuration. Behind a plain L7 proxy every user shares the proxy's bucket; preserve the peer address at the socket level or plan a `trustProxy` option. A missing peer address skips the IP policy and logs `rate_limit.ip_unavailable`; it never collapses all callers into one `"unknown"` bucket. IPv4-mapped IPv6 collapses to IPv4, and IPv6 buckets by `/64`.

The SQLite store is single-node. A multi-instance deployment needs a shared `RateLimitStore`; the email code does not change when you swap it.

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

`onEmailSend` runs serially, may rewrite the message, and may set `skip: true` to cancel the send. Its chain has a 2-second fail-open timeout. A skipped message consumes no budget; a rewritten recipient is charged on the rewritten address. `onEmailSent` and `onEmailError` are detached observers. `onEmailError` never fires for `EmailNotConfiguredError` or a rate limit. Plugin layers, `onBootstrap`, and routes may `yield* EmailService`; when email is not configured the referenced service reports `enabled: false`. Plugin sends consume the notification budget and cannot bypass the send limits.

## Dashboard and local testing

Settings -> App shows the live storage and email descriptions read-only. There are no editable SMTP fields in the dashboard; change the builder and restart. The Email diagnostics card sends a test message only to the authenticated superadmin's own address. It is limited to five per hour per superadmin and returns `429` with `retryAfterSeconds` when blocked; a shared send-budget block looks the same to the UI.

For local testing, no paid provider is needed:

```bash
docker compose -f docker-compose.mailpit.yml up -d
```

Mailpit listens on `localhost:1025` for SMTP and serves the inbox at `http://localhost:8025`. Point `SmtpEmail` at that host and port. Automated tests use an in-process `smtp-server`, so CI needs no Docker or account. The same `SmtpEmail` transport works on Bun; use `BunPlatform` and `BunSqliteDatabase` from `@gettersethya/mira/bun` and keep the email config unchanged.

## Related pages

- [Auth collections and sessions](../auth/) for registration, login, and sessions.
- [Server and operations](../server/) for builder wiring and runtime config.
- [Plugins, hooks, and crons](../plugins/) for plugin layers and hooks.
- [Dashboard plugin](../dashboard/) for the live read-only cards and test email.
