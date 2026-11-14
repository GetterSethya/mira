import { Schema } from "effect"

const email = Schema.String.pipe(
  Schema.check(Schema.makeFilter((s: string) => s.length > 0, { message: "Email is required" })),
  Schema.check(Schema.makeFilter((s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s), { message: "Invalid email address" }))
)

const password = Schema.String.pipe(
  Schema.check(Schema.makeFilter((s: string) => s.length > 0, { message: "Password is required" }))
)

const strongPassword = Schema.String.pipe(
  Schema.check(Schema.makeFilter((s: string) => s.length >= 8, { message: "Password must be at least 8 characters" }))
)

const token = Schema.String.pipe(
  Schema.check(Schema.makeFilter((s: string) => s.length > 0, { message: "Registration token is required" }))
)

const otpCode = Schema.String.pipe(
  Schema.check(Schema.makeFilter((s: string) => /^\d{6}$/.test(s), { message: "Enter the 6-digit code" }))
)

export const LoginSchema = Schema.Struct({ email, password })

export const RegisterSchema = Schema.Struct({ name: Schema.String, email, password: strongPassword })

export const ForgotPasswordSchema = Schema.Struct({ email })

export const ResetPasswordSchema = Schema.Struct({ password: strongPassword, passwordConfirm: strongPassword })

export const LoginOtpSchema = Schema.Struct({ code: otpCode })

export const TestEmailSchema = Schema.Struct({ to: Schema.optional(email) })

export function formatFieldErrors(errors: any[]): string {
  return errors.map((e) => e.message).join(", ")
}
