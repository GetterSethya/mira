import type { Option, Redacted } from "effect"

/**
 * Optional S3 storage configuration.
 * Only loaded when `useS3` is true in AppConfig.
 *
 * @see AppConfig.useS3 — whether S3 is enabled
 * @see AppConfig.s3Config — the Option<S3Config>
 */
export interface S3Config {
  readonly endpoint: Redacted.Redacted<string>
  readonly bucketName: string
  readonly regionName: string
  readonly accessKey: Redacted.Redacted<string>
  readonly secret: Redacted.Redacted<string>
}

/**
 * Shape of the application configuration stored in the `_config` DB table.
 *
 * @see AppConfig — the Context.Tag that provides this
 */
export interface AppConfigShape {
  readonly appName: string
  readonly port: number
  readonly applicationUrl: string
  readonly jwtSecret: Redacted.Redacted<string>
  readonly useS3: boolean
  readonly s3Config: Option.Option<S3Config>
  readonly logRetentionDays: number
}
