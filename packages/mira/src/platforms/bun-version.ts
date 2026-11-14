/** First Bun release with the native `Bun.Image` pipeline. */
export const MINIMUM_BUN_VERSION = "1.3.14"

const parsePart = (value: string | undefined): number => {
  if (value === undefined) return 0
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Whether a Bun version string satisfies the platform's minimum. Prereleases
 * such as `1.3.14-canary.1` compare by their numeric prefix.
 */
export const isSupportedBunVersion = (version: string): boolean => {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map(parsePart)
  const [minimumMajor = 0, minimumMinor = 0, minimumPatch = 0] =
    MINIMUM_BUN_VERSION.split(".").map(parsePart)
  if (major !== minimumMajor) return major > minimumMajor
  if (minor !== minimumMinor) return minor > minimumMinor
  return patch >= minimumPatch
}
