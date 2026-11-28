import type { Schema } from "effect"
import { SchemaAST } from "effect"
import { SchemaJITCompiler } from "effect/schema"

/** Parser operations the Effect schema compiler can pre-generate. */
export type SchemaCompilerOperation = "decode" | "encode" | "is" | "make"

/**
 * Mira's schema-compiler configuration.
 *
 * `off` (the default) interprets every schema AST. `jit` lets Effect generate a
 * JavaScript fast path for supported nodes on first use. The compiler is
 * process-wide and is never unloaded, so the mode is a startup decision.
 */
export interface MiraSchemaCompilerConfig {
  readonly mode?: "off" | "jit"
}

type JitEntry = {
  readonly schema: Schema.Constraint
  readonly operations: ReadonlyArray<SchemaCompilerOperation>
}

const DEFAULT_OPERATIONS: ReadonlyArray<SchemaCompilerOperation> = ["decode"]

const pending: Array<JitEntry> = []
let enabled = false

function astFor(root: Schema.Constraint, operation: SchemaCompilerOperation) {
  switch (operation) {
    case "decode":
      return root.ast
    case "encode":
      return SchemaAST.flip(root.ast)
    case "is":
    case "make":
      return SchemaAST.toType(root.ast)
  }
}

function compile(entry: JitEntry): void {
  for (const operation of entry.operations) {
    SchemaJITCompiler.enable(astFor(entry.schema, operation))
  }
}

/**
 * Registers a schema root for compilation when `.schemaCompiler({ mode: "jit" })`
 * is active. Registration is a no-op until JIT is enabled, and enabling is
 * process-wide, matching Effect's compiler registry.
 *
 * Only the roots a schema is actually used with need registering: decoding uses
 * `schema.ast`, encoding uses its flipped AST, and guards/constructors use the
 * decoded (`toType`) projection.
 */
export function registerSchemaJitRoot(
  schema: Schema.Constraint,
  operations: ReadonlyArray<SchemaCompilerOperation> = DEFAULT_OPERATIONS
): void {
  const entry: JitEntry = { schema, operations }
  if (enabled) compile(entry)
  else pending.push(entry)
}

/**
 * Enables the Effect JIT schema compiler for every registered root, plus any
 * root registered later.
 *
 * The Effect compiler registry is global to the process, so this cannot be
 * undone. Call it before the first decode of a root; a parser that has already
 * captured an entry keeps that entry.
 */
export function enableSchemaJit(): void {
  if (enabled) return
  enabled = true
  for (const entry of pending) compile(entry)
  pending.length = 0
}

/** Whether JIT compilation has been enabled in this process. */
export function isSchemaJitEnabled(): boolean {
  return enabled
}
