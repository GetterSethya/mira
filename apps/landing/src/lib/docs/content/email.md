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

Without `.email(...)` Mira uses a no-op `EmailService`. `EmailService.enabled` is `false`, `send` fails with `EmailNotConfiguredError`, and email-dependent request endpoints return `email_not_configured`. A collection that requires login OTP fails at boot instead of silently downgrading to password-only.

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

| Method | Route | Purpose |
|---|---|---|
| `POST` | `/api/collections/:name/auth-with-password` | Existing login. Returns `{ otpRequired: true, challengeId, expiresAt }` when login OTP is required. |
| `POST` | `/api/collections/:name/auth-with-password/verify-otp` | Complete login OTP with `{ challengeId, code }`. |
| `POST` | `/api/collections/:name/auth-with-password/resend-otp` | Reissue a login OTP. |
| `POST` | `/api/collections/:name/auth-with-otp/request` | Request a passwordless code. Returns a `challengeId`, even for an unknown email. |
| `POST` | `/api/collections/:name/auth-with-otp` | Complete passwordless login with `{ challengeId, code }`. |
| `POST` | `/api/collections/:name/verify-email/request` | Request or resend a verification code. |
| `POST` | `/api/collections/:name/verify-email` | Verify with `{ challengeId, code }`. |
| `POST` | `/api/collections/:name/password-reset/request` | Request a reset link. Always returns a generic `202`. |
| `POST` | `/api/collections/:name/password-reset` | Complete reset with `{ token, password, passwordConfirm }`. |
| `GET` | `/api/collections/:name/auth-config` | Public capability flags and `emailConfigured`. |

Registration sends a verification OTP when the collection enables it. The create response is the public record plus `emailVerification: { challengeId, expiresAt }`. Password login remains allowed while `emailVerified` is false; use a rule such as `R.auth(Users, "emailVerified").eq(R.literal(true))` if an app needs to restrict access.

## Security and limits

- Email verification, login OTP, and passwordless codes are six digits, HMAC-hashed at rest, single-use, and expiring.
- Password reset uses a 256-bit token whose SHA-256 hash is stored.
- One live challenge exists per `(collection, user, purpose)`; issuing a new code supersedes the old one.
- Request endpoints return the same `202` + `challengeId` shape for known and unknown emails and detach the send, so timing does not leak account existence.
- Login OTP awaits delivery; a failed send returns `503 email_unavailable` and does not leave a challenge.
- Password reset consumes the token, updates the password through the collection service, bumps the token generation, and consumes all outstanding challenges for that user.
- The internal auth-flow write context may set only `password` or `emailVerified` for the challenge's own user. It is not `admin: true`.
- Login alerts are detached and skipped when email is disabled. Failures are logged, never surfaced to the login response.

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

`onEmailSend` runs serially, may rewrite the message, and may set `skip: true` to cancel the send. Its chain has a 2-second fail-open timeout. `onEmailSent` and `onEmailError` are detached observers. `onEmailError` never fires for `EmailNotConfiguredError`. Plugin layers, `onBootstrap`, and routes may `yield* EmailService`; when email is not configured the referenced service reports `enabled: false`.

## Dashboard and local testing

Settings -> App shows the live storage and email descriptions read-only. There are no editable SMTP fields in the dashboard; change the builder and restart. The Email diagnostics card sends a test message only to the authenticated superadmin's own address.

For local testing, no paid provider is needed:

```bash
docker compose -f docker-compose.mailpit.yml up -d
```

Mailpit listens on `localhost:1025` for SMTP and serves the inbox at `http://localhost:8025`. Point `SmtpEmail` at that host and port. Automated tests use an in-process `smtp-server`, so CI needs no Docker or account.

## Related pages

- [Auth collections and sessions](../auth/) for registration, login, and sessions.
- [Server and operations](../server/) for builder wiring and runtime config.
- [Plugins, hooks, and crons](../plugins/) for plugin layers and hooks.
- [Dashboard plugin](../dashboard/) for the live read-only cards and test email.
