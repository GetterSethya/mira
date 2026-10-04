/**
 * Options controlling how console telemetry output is rendered.
 */
export interface ConsolePrintOptions {
  /**
   * When `true`, logs and spans are printed with Chalk coloring for human
   * readability. When `false` (default), they are printed as raw JSON lines.
   */
  readonly pretty?: boolean
}
