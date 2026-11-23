import type { ViewShape } from "./dialect.js"

type Token =
  | { readonly kind: "word"; readonly value: string }
  | { readonly kind: "quoted"; readonly value: string }
  | { readonly kind: "punct"; readonly value: "(" | ")" | "," | "." | ";" }

const TERMINATORS = new Set([
  "WHERE",
  "GROUP",
  "HAVING",
  "WINDOW",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "FETCH",
  "FOR",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "RETURNING"
])

const isWordStart = (ch: string) => /[A-Za-z_]/.test(ch)
const isWordPart = (ch: string) => /[A-Za-z0-9_$]/.test(ch)

const previousNonSpace = (sql: string, from: number) => {
  let index = from - 1
  while (index >= 0 && /\s/.test(sql[index] ?? "")) index--
  return index
}

/**
 * Tokenizes enough SQL to find table references. It deliberately skips strings,
 * dollar-quoted bodies, and comments so a keyword inside a literal cannot be
 * mistaken for a clause.
 */
function tokenize(sql: string): Array<Token> {
  const tokens: Array<Token> = []
  let index = 0

  while (index < sql.length) {
    const ch = sql[index] ?? ""
    const next = sql[index + 1] ?? ""

    if (ch === "-" && next === "-") {
      index += 2
      while (index < sql.length && sql[index] !== "\n") index++
      continue
    }

    if (ch === "/" && next === "*") {
      index += 2
      let depth = 1
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth++
          index += 2
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth--
          index += 2
        } else {
          index++
        }
      }
      continue
    }

    if (ch === "'") {
      const before = previousNonSpace(sql, index)
      const escapeString =
        before >= 0 &&
        (sql[before] === "E" || sql[before] === "e") &&
        (before === 0 || !isWordPart(sql[before - 1] ?? ""))
      index++
      while (index < sql.length) {
        if (escapeString && sql[index] === "\\") {
          index += 2
          continue
        }
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            index += 2
            continue
          }
          index++
          break
        }
        index++
      }
      continue
    }

    if (ch === "$") {
      const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))
      if (match !== null) {
        const tag = match[0]
        const end = sql.indexOf(tag, index + tag.length)
        index = end === -1 ? sql.length : end + tag.length
        continue
      }
      index++
      continue
    }

    if (ch === '"') {
      index++
      let value = ""
      while (index < sql.length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') {
            value += '"'
            index += 2
            continue
          }
          index++
          break
        }
        value += sql[index]
        index++
      }
      tokens.push({ kind: "quoted", value })
      continue
    }

    if (isWordStart(ch)) {
      let value = ch
      index++
      while (index < sql.length && isWordPart(sql[index] ?? "")) {
        value += sql[index]
        index++
      }
      tokens.push({ kind: "word", value })
      continue
    }

    if (ch === "(" || ch === ")" || ch === "," || ch === "." || ch === ";") {
      tokens.push({ kind: "punct", value: ch })
      index++
      continue
    }

    index++
  }

  return tokens
}

/** Lowercases an identifier for dependency lookups. */
export function normalizeIdentifier(name: string): string {
  return name.toLowerCase()
}

const skipSpaces = (sql: string, from: number) => {
  let index = from
  while (index < sql.length && /\s/.test(sql[index] ?? "")) index++
  return index
}

const readWord = (
  sql: string,
  from: number
): { readonly value: string; readonly next: number } | null => {
  if (!isWordStart(sql[from] ?? "")) return null
  let index = from + 1
  while (index < sql.length && isWordPart(sql[index] ?? "")) index++
  return { value: sql.slice(from, index), next: index }
}

const readQuotedName = (sql: string, from: number): { readonly next: number } | null => {
  const open = sql[from] ?? ""
  if (open !== '"' && open !== "`" && open !== "[") return null
  const close = open === "[" ? "]" : open
  const doubledEscape = open !== "["
  let index = from + 1
  while (index < sql.length) {
    if (sql[index] === close) {
      if (doubledEscape && sql[index + 1] === close) {
        index += 2
        continue
      }
      return { next: index + 1 }
    }
    index++
  }
  return null
}

/** Consumes one view name: plain, double-quoted, backtick, or bracket form. */
const readName = (sql: string, from: number): { readonly next: number } | null => {
  const word = readWord(sql, from)
  if (word !== null) return { next: word.next }
  return readQuotedName(sql, from)
}

/**
 * Reports whether a stored `CREATE VIEW` front matter declares an explicit
 * column list, such as `CREATE VIEW v (a, b) AS SELECT ...`.
 *
 * The scanner consumes only the front matter: `CREATE`, an optional
 * `TEMP`/`TEMPORARY`, `VIEW`, an optional `IF NOT EXISTS`, and one name in plain,
 * double-quoted, backtick-quoted, bracket-quoted, or schema-qualified form. It
 * then reports whether the next significant character is `(` before the `AS`
 * keyword. The direction is explicit: a column list is missed only when the
 * front matter is unparsable, which returns `false`; the text came from
 * `sqlite_master`, so a non-`CREATE VIEW` statement is not a user view.
 */
export function viewDeclaresColumnList(sql: string): boolean {
  let index = skipSpaces(sql, 0)
  const create = readWord(sql, index)
  if (create === null || create.value.toUpperCase() !== "CREATE") return false
  index = skipSpaces(sql, create.next)

  const temp = readWord(sql, index)
  if (temp !== null) {
    const keyword = temp.value.toUpperCase()
    if (keyword === "TEMP" || keyword === "TEMPORARY") index = skipSpaces(sql, temp.next)
  }

  const view = readWord(sql, index)
  if (view === null || view.value.toUpperCase() !== "VIEW") return false
  index = skipSpaces(sql, view.next)

  const ifKeyword = readWord(sql, index)
  if (ifKeyword !== null && ifKeyword.value.toUpperCase() === "IF") {
    index = skipSpaces(sql, ifKeyword.next)
    const notKeyword = readWord(sql, index)
    if (notKeyword === null || notKeyword.value.toUpperCase() !== "NOT") return false
    index = skipSpaces(sql, notKeyword.next)
    const existsKeyword = readWord(sql, index)
    if (existsKeyword === null || existsKeyword.value.toUpperCase() !== "EXISTS") return false
    index = skipSpaces(sql, existsKeyword.next)
  }

  const name = readName(sql, index)
  if (name === null) return false
  index = skipSpaces(sql, name.next)
  if (sql[index] === ".") {
    const qualified = readName(sql, skipSpaces(sql, index + 1))
    if (qualified === null) return false
    index = skipSpaces(sql, qualified.next)
  }

  const asKeyword = readWord(sql, index)
  if (asKeyword !== null && asKeyword.value.toUpperCase() === "AS") return false
  return sql[index] === "("
}

type FromContext = {
  readonly depth: number
  expectReference: boolean
}

/**
 * Collects identifiers used as table references in `FROM` and `JOIN` positions.
 *
 * The scan is conservative: aliases are ignored, a `TABLE <name>` body is
 * collected, and a comma at the same depth as the active `FROM` starts another
 * reference. `FROM ONLY (table)` and table-valued functions are not modeled.
 * A false positive costs an unnecessary view drop/recreate; a false negative
 * surfaces as PostgreSQL's dependency error.
 */
export function fromJoinReferences(query: string): ReadonlySet<string> {
  const tokens = tokenize(query)
  const references = new Set<string>()
  const stack: Array<FromContext> = []
  let depth = 0

  const top = () => stack[stack.length - 1]

  const collect = (start: number) => {
    let name = tokens[start]?.value ?? ""
    let index = start + 1
    while (
      index + 1 < tokens.length &&
      tokens[index]?.kind === "punct" &&
      tokens[index]?.value === "." &&
      (tokens[index + 1]?.kind === "word" || tokens[index + 1]?.kind === "quoted")
    ) {
      name = tokens[index + 1]?.value ?? name
      index += 2
    }
    if (name.length > 0) references.add(normalizeIdentifier(name))
    return index - 1
  }

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === undefined) continue

    if (token.kind === "punct") {
      if (token.value === "(") {
        const context = top()
        if (context !== undefined && context.depth === depth && context.expectReference) {
          // A subquery or a parenthesized table. Nested FROM tokens are
          // collected by the recursive scan; a bare `(table)` form is a
          // documented miss.
          context.expectReference = false
        }
        depth++
        continue
      }
      if (token.value === ")") {
        depth = Math.max(0, depth - 1)
        while (stack.length > 0 && (top()?.depth ?? 0) > depth) stack.pop()
        continue
      }
      if (token.value === ",") {
        const context = top()
        if (context !== undefined && context.depth === depth) context.expectReference = true
        continue
      }
      if (token.value === ";") {
        stack.length = 0
        continue
      }
      continue
    }

    const word = token.value.toUpperCase()

    if (word === "FROM" || word === "JOIN") {
      const context = top()
      if (context !== undefined && context.depth === depth) {
        context.expectReference = true
      } else {
        stack.push({ depth, expectReference: true })
      }
      continue
    }

    if (word === "TABLE" && (top() === undefined || (top()?.depth ?? 0) < depth)) {
      stack.push({ depth, expectReference: true })
      continue
    }

    const context = top()
    if (context === undefined) continue

    if (context.depth === depth && TERMINATORS.has(word)) {
      stack.pop()
      continue
    }

    if (!context.expectReference) continue

    if (token.kind === "word" && (word === "ONLY" || word === "LATERAL")) {
      continue
    }

    if (token.kind === "word" || token.kind === "quoted") {
      index = collect(index)
      context.expectReference = false
    }
  }

  return references
}

/**
 * Builds a view-to-view dependency graph from one query source.
 *
 * The source is explicit: drop detection uses stored queries, while creation
 * order uses desired queries. Only known view names become edges; table
 * references are handled by `affectedViews`.
 */
export function viewDependencies(
  views: ReadonlyMap<string, ViewShape>,
  source: "stored" | "desired"
): ReadonlyMap<string, ReadonlySet<string>> {
  const known = new Map<string, ViewShape>()
  for (const [name, shape] of views) known.set(normalizeIdentifier(name), shape)

  const graph = new Map<string, ReadonlySet<string>>()
  for (const [name, shape] of known) {
    const query = source === "stored" ? shape.stored?.query : shape.desired?.query
    if (query === undefined || query === null) continue
    const dependencies = new Set<string>()
    for (const reference of fromJoinReferences(query)) {
      if (reference !== name && known.has(reference)) dependencies.add(reference)
    }
    graph.set(name, dependencies)
  }
  return graph
}

/**
 * Returns every view that must be dropped before the plan's destructive table
 * changes, including transitive dependents.
 *
 * All inputs are normalized with {@link normalizeIdentifier}. The closure uses
 * the stored graph because that is the view that exists in the database now.
 */
export function affectedViews(
  views: ReadonlyMap<string, ViewShape>,
  droppedViews: ReadonlySet<string>,
  changedTables: ReadonlySet<string>
): ReadonlySet<string> {
  const known = new Map<string, ViewShape>()
  for (const [name, shape] of views) known.set(normalizeIdentifier(name), shape)

  const changed = new Set([...changedTables].map(normalizeIdentifier))
  const affected = new Set([...droppedViews].map(normalizeIdentifier))
  const graph = viewDependencies(views, "stored")

  for (const [name, shape] of known) {
    const query = shape.stored?.query
    if (query === undefined || query === null) continue
    const references = fromJoinReferences(query)
    for (const reference of references) {
      if (changed.has(reference)) {
        affected.add(name)
        break
      }
    }
  }

  let grew = true
  while (grew) {
    grew = false
    for (const [name, dependencies] of graph) {
      if (affected.has(name)) continue
      for (const dependency of dependencies) {
        if (affected.has(dependency)) {
          affected.add(name)
          grew = true
          break
        }
      }
    }
  }

  return affected
}

/**
 * Orders view names so dependencies are created first. A back edge is ignored:
 * PostgreSQL rejects true view cycles, and a false edge from the conservative
 * scanner must not block a valid plan.
 */
export function topologicalViewOrder(
  names: ReadonlySet<string>,
  dependencies: ReadonlyMap<string, ReadonlySet<string>>
): Array<string> {
  const result: Array<string> = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  const visit = (name: string) => {
    if (visited.has(name) || visiting.has(name)) return
    visiting.add(name)
    for (const dependency of dependencies.get(name) ?? []) {
      if (names.has(dependency)) visit(dependency)
    }
    visiting.delete(name)
    visited.add(name)
    result.push(name)
  }

  for (const name of names) visit(name)
  return result
}
