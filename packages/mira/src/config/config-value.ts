import { Config, Redacted } from "effect"

/**
 * A value that can be provided directly or read from Effect's `Config` system
 * when a layer is built.
 */
export type ConfigValue<T> = T | Config.Config<T>

/** Narrow a plain value or a Config to a Config. */
export const isConfigValue = <A>(value: A | Config.Config<A>): value is Config.Config<A> =>
  Config.isConfig(value)

/** Lift a plain value into a Config; leaves an existing Config untouched. */
export const resolveConfigValue = <A>(value: A | Config.Config<A>): Config.Config<A> =>
  isConfigValue(value) ? value : Config.succeed(value)

/** Unwrap a string or Redacted<string> secret. */
export const unwrapSecret = (value: string | Redacted.Redacted<string>): string =>
  typeof value === "string" ? value : Redacted.value(value)
