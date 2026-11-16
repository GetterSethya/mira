import type { ExprNode, OperandNode, RuleMap } from "@gettersethya/mira-client"

/** A rule action exposed by the schema inspector. */
export type RuleAction = "list" | "view" | "create" | "update" | "delete" | "manage"

/** Display-only verdict for one action. Missing rules are `deny`, never blank. */
export type RuleSummaryKind = "deny" | "public" | "expr"

/**
 * A human-readable rule summary row.
 *
 * `fields` lists the record fields referenced by the expression so the
 * dashboard can point at them; it never executes or evaluates the rule.
 */
export interface RuleSummary {
  readonly action: RuleAction
  readonly kind: RuleSummaryKind
  readonly fields: Array<string>
}

const CRUD_ACTIONS: ReadonlyArray<RuleAction> = ["list", "view", "create", "update", "delete"]

const actionsFor = (kind: "base" | "auth" | "view"): ReadonlyArray<RuleAction> => {
  if (kind === "view") return ["list", "view"]
  if (kind === "auth") return [...CRUD_ACTIONS, "manage"]
  return CRUD_ACTIONS
}

const collectOperand = (operand: OperandNode, fields: Set<string>) => {
  switch (operand.kind) {
    case "field":
      fields.add(operand.field)
      return
    case "dateAdd":
      collectOperand(operand.operand, fields)
      return
    case "dateDiff":
      collectOperand(operand.left, fields)
      collectOperand(operand.right, fields)
      return
    // `subquery` conditions refer to another collection; their field names are
    // not fields of this record, so they are intentionally not reported.
    default:
      return
  }
}

const collectFields = (expr: ExprNode, fields: Set<string>) => {
  switch (expr.op) {
    case "and":
    case "or":
      collectFields(expr.left, fields)
      collectFields(expr.right, fields)
      return
    case "not":
      collectFields(expr.expr, fields)
      return
    case "public":
      return
    default:
      collectOperand(expr.left, fields)
      collectOperand(expr.right, fields)
  }
}

const summarize = (action: RuleAction, expr: ExprNode | undefined): RuleSummary => {
  if (expr === undefined) return { action, kind: "deny", fields: [] }
  if (expr.op === "public") return { action, kind: "public", fields: [] }
  const fields = new Set<string>()
  collectFields(expr, fields)
  return { action, kind: "expr", fields: [...fields] }
}

/**
 * Structural, display-only summary of a collection's `x-rules`. Walks each
 * action's expression to collect referenced field names; it does not execute
 * rules or validate them against the database.
 */
export const makeRuleSummary = (
  kind: "base" | "auth" | "view",
  rules: RuleMap | undefined
): ReadonlyArray<RuleSummary> => actionsFor(kind).map((action) => summarize(action, rules?.[action]))
