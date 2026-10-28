/**
 * Package managers supported by the Connect sheet install snippets.
 *
 * The order is the order rendered in the dashboard dropdown.
 */
export const PACKAGE_MANAGERS = ["pnpm", "npm", "yarn", "bun"] as const

/** A package manager the dashboard can generate install commands for. */
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]

const INSTALL_SUBCOMMAND: Record<PackageManager, string> = {
  pnpm: "add",
  npm: "install",
  yarn: "add",
  bun: "add"
}

/**
 * Narrow an arbitrary value (a `localStorage` entry, a query param) to a
 * supported package manager.
 *
 * @example
 * isPackageManager("bun")   // true
 * isPackageManager("deno")  // false
 */
export function isPackageManager(value: unknown): value is PackageManager {
  return typeof value === "string" && PACKAGE_MANAGERS.some((manager) => manager === value)
}

/**
 * Build the install command for a package manager.
 *
 * @example
 * installCommand("pnpm", ["@gettersethya/mira-client"])
 * // "pnpm add @gettersethya/mira-client"
 *
 * installCommand("npm", ["@gettersethya/mira-client"])
 * // "npm install @gettersethya/mira-client"
 */
export function installCommand(
  manager: PackageManager,
  packages: ReadonlyArray<string>
): string {
  return [manager, INSTALL_SUBCOMMAND[manager], ...packages].join(" ")
}
