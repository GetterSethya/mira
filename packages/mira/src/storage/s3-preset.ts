import type { MiraStorage } from "@/app/types.js"

import type { S3CompatibleStorageConfig } from "./s3-storage.js"
import { makeS3FileStorageLayer } from "./s3-storage.js"

/**
 * S3-compatible file storage preset.
 *
 * Creates a `MiraStorage` backed by any S3-compatible bucket (AWS S3, MinIO,
 * LocalStack, R2, …). Requests are signed by `files-sdk`'s `s3Fetch` adapter,
 * so no `@aws-sdk/*` package is required.
 *
 * The bucket must already exist. Use `forcePathStyle: false` for virtual-host
 * addressing, and `publicBaseUrl` when files are served through a CDN or custom
 * domain (private buckets have no direct public URL).
 *
 * @param config.endpoint - S3 endpoint including scheme
 * @param config.bucketName - Bucket that receives every uploaded object
 * @param config.regionName - Region used for request signing
 * @param config.accessKey - Access key id
 * @param config.secret - Secret access key
 * @param config.forcePathStyle - Path-style addressing (default: `true`)
 * @param config.publicBaseUrl - Optional public base URL used by `url()`
 * @returns A MiraStorage preset
 *
 * @example
 * Mira.builder()
 *   .storage(
 *     S3CompatibleStorage({
 *       endpoint: Config.String("S3_ENDPOINT"),
 *       bucketName: Config.String("S3_BUCKET_NAME"),
 *       regionName: Config.String("S3_REGION_NAME").pipe(Config.withDefault("us-east-1")),
 *       accessKey: Config.Redacted("S3_ACCESS_KEY"),
 *       secret: Config.Redacted("S3_SECRET"),
 *     })
 *   )
 *
 * @see makeS3FileStorageLayer — underlying implementation
 * @see S3CompatibleStorageConfig — the full config shape
 * @see MiraStorage — the interface S3CompatibleStorage implements
 */
export const S3CompatibleStorage = (config: S3CompatibleStorageConfig): MiraStorage => ({
  layer: makeS3FileStorageLayer(config),
})
