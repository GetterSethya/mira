import { makeFileStorageLayer } from "./storage.js"
import type { MiraStorage } from "@/app/types.js"

/**
 * Local file storage preset using the filesystem.
 *
 * Creates a `MiraStorage` using the local disk-based `FileStorage` implementation.
 * Files are stored in the specified directory, with automatic subdirectory creation.
 *
 * @param config.directory - The root directory for file storage
 * @returns A MiraStorage preset
 *
 * @example
 * Mira.builder()
 *   .storage(LocalFileStorage({ directory: "./uploads" }))
 *
 * @see makeFileStorageLayer — underlying implementation
 * @see MiraStorage — the interface LocalFileStorage implements
 */
export const LocalFileStorage = (config: { directory: string }): MiraStorage => ({
  layer: makeFileStorageLayer("local", { directory: config.directory }),
})
