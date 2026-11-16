export { makeHookedEmailServiceLayer } from "./hooked.js"
export { NoopEmail } from "./noop.js"
export { SmtpEmail } from "./smtp.js"
export type { SmtpConfigValue, SmtpEmailConfig } from "./smtp.js"
export {
  EMAIL_TEMPLATE_IDS,
  EmailTemplates,
  emailChangeEmail,
  escapeHtml,
  loginAlertEmail,
  loginOtpEmail,
  makeEmailTemplates,
  passwordlessOtpEmail,
  passwordResetEmail,
  sanitizeEmailSubject,
  verificationOtpEmail
} from "./templates.js"
export type {
  EmailChangeEmailInput,
  EmailTemplateContent,
  EmailTemplateId,
  EmailTemplateInputs,
  EmailTemplateOverrides,
  EmailTemplatePreview,
  EmailTemplateSource,
  EmailTemplatesConfig,
  EmailTemplatesShape,
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
