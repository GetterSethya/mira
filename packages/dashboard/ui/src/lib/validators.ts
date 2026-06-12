import { Schema } from "effect"

const email = Schema.String.pipe(
  Schema.filter((s) => s.length > 0, { message: () => "Email is required" }),
  Schema.filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s), { message: () => "Invalid email address" })
)

const password = Schema.String.pipe(Schema.filter((s) => s.length > 0, { message: () => "Password is required" }))

const strongPassword = Schema.String.pipe(
  Schema.filter((s) => s.length >= 8, { message: () => "Password must be at least 8 characters" })
)

const token = Schema.String.pipe(
  Schema.filter((s) => s.length > 0, { message: () => "Registration token is required" })
)

export const LoginSchema = Schema.Struct({ email, password })

export const RegisterSchema = Schema.Struct({ name: Schema.String, email, password: strongPassword })

export function formatFieldErrors(errors: any[]): string {
  return errors.map((e) => e.message).join(", ")
}
