import type {
  CollectionSchema,
  EmailTemplateSource,
  RuleAction,
  SchemaIndex,
  SchemaRuleSummary
} from "$lib/dashboard-api.js"

export type RuleKind = "deny" | "public" | "expr"

export interface RuleRow {
  action: RuleAction
  label: string
  kind: RuleKind
  /** Human-readable verdict; never blank, even when the action has no rule. */
  verdict: string
  fields: string[]
  /** Raw expression from `x-rules`, or `null` when the action has no rule. */
  raw: unknown
}

export interface RuleInspection {
  rows: RuleRow[]
  /** True when at least one action carries a rule. */
  rulesConfigured: boolean
  /** False when the server sent neither `rules` nor `ruleSummary`. */
  rulesReported: boolean
}

export interface IndexRow {
  fields: string[]
  unique: boolean
  system: boolean
  kind: "single" | "composite"
  /** The parsed index, used by `indexFindings()`. */
  index: SchemaIndex
}

const RULE_ACTIONS: ReadonlyArray<RuleAction> = ["list", "view", "create", "update", "delete", "manage"]

const ACTION_LABELS: Record<RuleAction, string> = {
  list: "List",
  view: "View",
  create: "Create",
  update: "Update",
  delete: "Delete",
  manage: "Manage"
}

/** Keys that can hold a nested boolean expression inside a rule node. */
const BOOLEAN_KEYS = ["left", "right", "expr", "where", "operand"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isRuleAction(value: unknown): value is RuleAction {
  return typeof value === "string" && RULE_ACTIONS.some((action) => action === value)
}

function pushUnique(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value)
}

function parseRuleSummary(value: unknown): SchemaRuleSummary | null {
  if (!isRecord(value)) return null
  const action = value["action"]
  const kind = value["kind"]
  if (!isRuleAction(action)) return null
  if (kind !== "deny" && kind !== "public" && kind !== "expr") return null
  const rawFields = value["fields"]
  const fields: string[] = []
  if (Array.isArray(rawFields)) {
    for (const field of rawFields) {
      if (typeof field === "string") fields.push(field)
    }
  }
  return { action, kind, fields }
}

function summaryRows(schema: CollectionSchema): Map<RuleAction, SchemaRuleSummary> {
  const map = new Map<RuleAction, SchemaRuleSummary>()
  for (const entry of schema.ruleSummary ?? []) {
    const summary = parseRuleSummary(entry)
    if (summary !== null) map.set(summary.action, summary)
  }
  return map
}

function ruleMap(schema: CollectionSchema): Record<string, unknown> | null {
  return isRecord(schema.rules) ? schema.rules : null
}

function collectRuleFields(value: unknown, out: string[]): void {
  if (!isRecord(value)) return
  const kind = value["kind"]
  const field = value["field"]
  if (typeof field === "string") {
    if (kind === "field") pushUnique(out, field)
    else if (kind === "auth") pushUnique(out, `auth.${field}`)
  }
  for (const key of BOOLEAN_KEYS) collectRuleFields(value[key], out)
}

function deriveRule(raw: unknown): { kind: RuleKind; fields: string[] } {
  if (!isRecord(raw) || typeof raw["op"] !== "string") return { kind: "deny", fields: [] }
  if (raw["op"] === "public") return { kind: "public", fields: [] }
  const fields: string[] = []
  collectRuleFields(raw, fields)
  return { kind: "expr", fields }
}

function hasBooleanCombinator(value: unknown): boolean {
  if (!isRecord(value)) return false
  const op = value["op"]
  if (op === "and" || op === "or" || op === "not") return true
  return BOOLEAN_KEYS.some((key) => hasBooleanCombinator(value[key]))
}

/** Verdict text for a row. Deny/public are fixed; expressions split on nesting. */
export function ruleVerdict(kind: RuleKind, raw: unknown): string {
  if (kind === "deny") return "Denied — no rule"
  if (kind === "public") return "Public — allows everyone"
  return hasBooleanCombinator(raw) ? "Nested condition" : "Restricted"
}

/** The fixed action list for a collection kind. View collections are read-only. */
export function ruleActions(kind: CollectionSchema["kind"]): RuleAction[] {
  if (kind === "view") return ["list", "view"]
  if (kind === "auth") return ["list", "view", "create", "update", "delete", "manage"]
  return ["list", "view", "create", "update", "delete"]
}

/**
 * Build one row per action. Prefers the server-computed `ruleSummary`; when an
 * older server omits it, derives the verdict from the raw `x-rules` payload.
 * A missing rule is always a visible `deny` row — never blank.
 */
export function ruleRows(schema: CollectionSchema): RuleInspection {
  const rules = ruleMap(schema)
  const summaries = summaryRows(schema)

  const rows = ruleActions(schema.kind).map((action): RuleRow => {
    const raw = rules === null ? undefined : rules[action]
    const summary = summaries.get(action)
    const derived = deriveRule(raw)
    const kind = summary?.kind ?? derived.kind
    const fields = summary?.fields ?? derived.fields
    return {
      action,
      label: ACTION_LABELS[action],
      kind,
      verdict: ruleVerdict(kind, raw),
      fields,
      raw: raw === undefined ? null : raw
    }
  })

  return {
    rows,
    rulesConfigured: (rules !== null && Object.keys(rules).length > 0) || rows.some((row) => row.kind !== "deny"),
    rulesReported: rules !== null || schema.ruleSummary !== undefined
  }
}

function parseIndex(value: unknown): SchemaIndex | null {
  if (!isRecord(value)) return null
  const rawFields = value["fields"]
  const unique = value["unique"]
  if (!Array.isArray(rawFields) || typeof unique !== "boolean") return null
  const fields: string[] = []
  for (const field of rawFields) {
    if (typeof field !== "string") return null
    fields.push(field)
  }
  return value["system"] === true ? { fields, unique, system: true } : { fields, unique }
}

/** Normalize the loosely-typed `x-indexes` payload into typed rows. */
export function schemaIndexes(schema: CollectionSchema): SchemaIndex[] {
  const rawIndexes = schema.indexes
  if (!Array.isArray(rawIndexes)) return []
  const indexes: SchemaIndex[] = []
  for (const entry of rawIndexes) {
    const index = parseIndex(entry)
    if (index !== null) indexes.push(index)
  }
  return indexes
}

export function indexRows(schema: CollectionSchema): IndexRow[] {
  return schemaIndexes(schema).map(
    (index): IndexRow => ({
      fields: index.fields,
      unique: index.unique,
      system: index.system === true,
      kind: index.fields.length > 1 ? "composite" : "single",
      index
    })
  )
}

function sameIndex(left: SchemaIndex, right: SchemaIndex): boolean {
  if (left.unique !== right.unique) return false
  if (left.fields.length !== right.fields.length) return false
  return left.fields.every((field, position) => field === right.fields[position])
}

function isLeftPrefix(prefix: SchemaIndex, index: SchemaIndex): boolean {
  if (prefix.fields.length >= index.fields.length) return false
  return prefix.fields.every((field, position) => field === index.fields[position])
}

/**
 * Only findings the dashboard can decide without a query planner: references
 * to fields that do not exist or are hidden, exact duplicates, and indexes
 * wholly covered by another index's left prefix. Never claims an index
 * "serves" a particular query.
 */
export function indexFindings(schema: CollectionSchema, index: SchemaIndex): string[] {
  const findings: string[] = []
  const indexes = schemaIndexes(schema)

  for (const field of index.fields) {
    const definition = schema.fields[field]
    if (definition === undefined) {
      pushUnique(findings, `Unknown field \`${field}\` — this collection has no such field.`)
    } else if (definition["x-hidden"] === true) {
      pushUnique(findings, `References hidden field \`${field}\`.`)
    }
  }

  const duplicates = indexes.filter((other) => sameIndex(other, index)).length
  if (duplicates > 1) {
    pushUnique(findings, "Duplicate index — another index covers the same fields.")
  }

  const covering = indexes.find((other) => other.unique === index.unique && isLeftPrefix(other, index))
  if (covering !== undefined) {
    pushUnique(findings, `Redundant left prefix — an index on (${covering.fields.join(", ")}) already covers it.`)
  }

  return findings
}

/** Human label for where an email template's content came from. */
export function templateSourceLabel(source: EmailTemplateSource): string {
  switch (source) {
    case "builtin":
      return "Built-in"
    case "global":
      return "Global override"
    case "collection":
      return "Collection override"
  }
}
