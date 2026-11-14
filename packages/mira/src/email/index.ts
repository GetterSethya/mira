export { makeHookedEmailServiceLayer } from "./hooked.js"
export { NoopEmail } from "./noop.js"
export { SmtpEmail } from "./smtp.js"
export type { SmtpConfigValue, SmtpEmailConfig } from "./smtp.js"
export {
  loginAlertEmail,
  loginOtpEmail,
  passwordlessOtpEmail,
  passwordResetEmail,
  verificationOtpEmail
} from "./templates.js"
export type {
  LoginAlertEmailInput,
  LoginOtpEmailInput,
  PasswordResetEmailInput,
  VerificationOtpEmailInput
} from "./templates.js"
export {
  EmailNotConfiguredError,
  EmailSendError,
  EmailService,
  MailTransport
} from "./types.js"
export type {
  EmailDescription,
  EmailError,
  EmailMessage,
  EmailSendOptions,
  EmailSendResult,
  EmailServiceShape,
  MailTransportConfig,
  MailTransportShape
} from "./types.js"
