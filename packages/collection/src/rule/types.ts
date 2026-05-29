/**
 * A value node in a rule expression — can be a field reference, literal, auth context, subquery, date operation, or request value.
 *
 * - `field` — a record field (e.g., `Rule.field("ownerId")`)
 * - `literal` — a static value (e.g., `Rule.literal(42)`)
 * - `auth` — a field from the authenticated user record (e.g., `Rule.auth(Users, "role")`)
 * - `authId` — the ID of the authenticated user (e.g., `Rule.authId(Users)`)
 * - `subquery` — a subquery into another collection (e.g., `Rule.subquery(Members, "teamId")`)
 * - `request` — a value from the incoming request (header, query, body)
 * - `now` — current timestamp (e.g., `Rule.now()`)
 * - `dateAdd` — date arithmetic (e.g., `Rule.dateAdd(Rule.now(), 7, "day")`)
 * - `dateDiff` — difference between two dates (e.g., `Rule.dateDiff(Rule.field("created"), Rule.now(), "day")`)
 */
export type OperandNode<K extends string = string, V = unknown> =
  | { kind: "field"; collection?: string; field: K }
  | { kind: "literal"; value: V }
  | { kind: "auth"; collection: string; field: string }
  | { kind: "authId"; collection: string }
  | { kind: "subquery"; collection: string; field: string; where: ExprNode<any> }
  | { kind: "request"; source: "header" | "query" | "body"; key: string }
  | { kind: "now" }
  | { kind: "dateAdd"; operand: OperandNode<any>; amount: number; unit: "day" | "hour" | "minute" }
  | { kind: "dateDiff"; left: OperandNode<any>; right: OperandNode<any>; unit: "day" | "hour" | "minute" }

/**
 * A boolean expression node in a rule — the result of comparing operands or combining sub-expressions.
 *
 * - `eq` / `neq` / `gt` / `gte` / `lt` / `lte` — comparison operators
 * - `in` — membership test (literal array or subquery)
 * - `and` / `or` / `not` — boolean combinators
 * - `startsWith` / `contains` — string pattern matching
 * - `public` — always-true marker
 */
export type ExprNode<K extends string = string> =
  | { op: "eq"; left: OperandNode<K>; right: OperandNode<any> }
  | { op: "neq"; left: OperandNode<K>; right: OperandNode<any> }
  | { op: "gt"; left: OperandNode<K>; right: OperandNode<any> }
  | { op: "gte"; left: OperandNode<K>; right: OperandNode<any> }
  | { op: "lt"; left: OperandNode<K>; right: OperandNode<any> }
  | { op: "lte"; left: OperandNode<K>; right: OperandNode<any> }
  | { op: "in"; left: OperandNode<K>; right: OperandNode<any> }
  | { op: "and"; left: ExprNode<K>; right: ExprNode<K> }
  | { op: "or"; left: ExprNode<K>; right: ExprNode<K> }
  | { op: "not"; expr: ExprNode<K> }
  | { op: "startsWith"; left: OperandNode<K>; right: OperandNode<any> }
  | { op: "contains"; left: OperandNode<K>; right: OperandNode<any> }
  | { op: "public" }

/**
 * A map of access rules keyed by action.
 * Used in `CollectionSchema["x-rules"]`. Actions without a rule deny all access by default.
 *
 * @example
 * {
 *   list: Rule.public(),                          // anyone can list
 *   view: Rule.field("ownerId").eq(Rule.authId(Users)), // owner only
 *   create: Rule.field("ownerId").eq(Rule.authId(Users)),
 *   update: Rule.field("ownerId").eq(Rule.authId(Users)),
 *   delete: Rule.field("ownerId").eq(Rule.authId(Users))
 * }
 */
export type RuleMap<K extends string = string> = {
  list?: ExprNode<K>
  view?: ExprNode<K>
  create?: ExprNode<K>
  update?: ExprNode<K>
  delete?: ExprNode<K>
}
