/**
 * SQL text scanning helpers.
 *
 * Generated SQL contains quoted identifiers and, in tests or view queries,
 * string literals. Token work such as placeholder renumbering, context
 * placeholder replacement, and table-alias rebinding must never touch text
 * inside those regions. These helpers split the statement into code segments
 * and quoted regions, and apply the callback only to code.
 *
 * Supported quoted regions:
 * - double-quoted identifiers (`"name"`), with `""` as an escaped quote
 * - backtick identifiers (`` `name` ``), with ``` `` ``` as an escaped backtick
 * - single-quoted strings (`'text'`), with `''` as an escaped quote
 */

const isQuote = (char: string) =>
  char === '"' || char === "`" || char === "'"

/**
 * Returns the index just past the quoted region that starts at `start`.
 * The opening quote is at `statement[start]`. A doubled delimiter is treated as
 * an escaped character inside the same region.
 */
function skipQuoted(statement: string, start: number): number {
  const quote = statement.charAt(start)
  let index = start + 1

  while (index < statement.length) {
    const char = statement[index]
    if (char !== quote) {
      index++
      continue
    }

    if (statement[index + 1] === quote) {
      index += 2
      continue
    }

    return index + 1
  }

  return statement.length
}

/**
 * Applies `transform` to every code segment and leaves quoted regions
 * byte-for-byte unchanged.
 */
export function transformSqlCode(
  statement: string,
  transform: (code: string) => string
): string {
  let result = ""
  let codeStart = 0
  let index = 0

  while (index < statement.length) {
    const char = statement.charAt(index)
    if (!isQuote(char)) {
      index++
      continue
    }

    result += transform(statement.slice(codeStart, index))
    const end = skipQuoted(statement, index)
    result += statement.slice(index, end)
    index = end
    codeStart = end
  }

  result += transform(statement.slice(codeStart))
  return result
}

/** Visits every code segment in order. */
export function forEachSqlCode(
  statement: string,
  visit: (code: string) => void
): void {
  let codeStart = 0
  let index = 0

  while (index < statement.length) {
    const char = statement.charAt(index)
    if (!isQuote(char)) {
      index++
      continue
    }

    visit(statement.slice(codeStart, index))
    index = skipQuoted(statement, index)
    codeStart = index
  }

  visit(statement.slice(codeStart))
}

/** Whether a pattern occurs in a code segment, never inside a quoted region. */
export function sqlCodeMatches(statement: string, pattern: RegExp): boolean {
  let matched = false
  forEachSqlCode(statement, (code) => {
    if (!matched && pattern.test(code)) matched = true
  })
  return matched
}
