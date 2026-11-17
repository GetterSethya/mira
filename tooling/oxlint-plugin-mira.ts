const PRIMITIVE_RETURN_TYPES = new Set([
  "TSBigIntKeyword",
  "TSBooleanKeyword",
  "TSNumberKeyword",
  "TSStringKeyword",
  "TSSymbolKeyword"
])

const BANNED_COMMENTS = new Set([
  "call",
  "calculate",
  "check",
  "compute",
  "constructor",
  "create",
  "declare",
  "decrement",
  "define",
  "delete",
  "entry point",
  "execute",
  "export",
  "fetch",
  "get",
  "get the value",
  "handle",
  "handle the error",
  "import",
  "increment",
  "increment the counter",
  "initialize",
  "initialize the variable",
  "initialise",
  "iterate",
  "iterate over",
  "loop",
  "loop through",
  "main function",
  "process",
  "process the data",
  "return",
  "return the result",
  "run",
  "set",
  "set the value",
  "set up",
  "setup",
  "update",
  "validate",
  "validate the input"
])

const COMMENTED_CODE =
  /^(?:await|class|const|declare|enum|export|for|function|if|import|interface|let|return|switch|try|type|var|while|yield)\b/

const DIRECTIVE_COMMENT =
  /^(?:#(?:end)?region|@explicit-return|@ts-|c8 |eslint-|istanbul|oxlint-|prettier-|v8 )/i

const EXPLICIT_RETURN_ESCAPE = /@(?:allow-)?explicit-return\b/

const isExported = (node) => {
  const parent = node.parent
  if (parent?.type === "ExportNamedDeclaration" || parent?.type === "ExportDefaultDeclaration") {
    return true
  }
  if (parent?.type === "VariableDeclarator") {
    const declaration = parent.parent
    return (
      declaration?.type === "VariableDeclaration" &&
      (declaration.parent?.type === "ExportNamedDeclaration" ||
        declaration.parent?.type === "ExportDefaultDeclaration")
    )
  }
  return false
}

const hasExplicitReturnEscape = (context, node) =>
  context.sourceCode
    .getCommentsBefore(node)
    .some((comment) => EXPLICIT_RETURN_ESCAPE.test(comment.value))

const noUnnecessaryReturnType = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Prefer inferred return types unless an explicit annotation narrows a public API or union."
    },
    messages: {
      unnecessary:
        "Remove this explicit return type; TypeScript infers it. Use `// @explicit-return` or `// oxlint-disable-next-line mira/no-unnecessary-return-type` when the annotation is necessary."
    }
  },
  create(context) {
    const check = (node) => {
      if (node.returnType === null || node.body === null) return
      if (isExported(node)) return
      if (hasExplicitReturnEscape(context, node)) return

      const type = node.returnType.typeAnnotation
      if (type === null || !PRIMITIVE_RETURN_TYPES.has(type.type)) return

      if (node.body.type === "BlockStatement") {
        const statements = node.body.body
        if (statements.length !== 1 || statements[0].type !== "ReturnStatement") return
      }

      context.report({ node: node.returnType, messageId: "unnecessary" })
    }

    return {
      ArrowFunctionExpression: check,
      FunctionDeclaration: check,
      FunctionExpression: check
    }
  }
}

const noUnnecessaryComment = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Reject comments that restate code, comment out code, or carry no information."
    },
    messages: {
      unnecessary:
        "Remove this comment or explain why the code cannot say it. Keep comments that explain intent, trade-offs, or non-obvious constraints."
    }
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type === "Block" && comment.value.trimStart().startsWith("*")) continue

          const text = comment.value.trim().replace(/^\/\/\s*/, "")
          if (text.length === 0 || DIRECTIVE_COMMENT.test(text)) continue

          const normalized = text.toLowerCase().replace(/[.!]+$/, "")
          if (BANNED_COMMENTS.has(normalized) || COMMENTED_CODE.test(text)) {
            context.report({ loc: comment.loc, messageId: "unnecessary" })
          }
        }
      }
    }
  }
}

export default {
  meta: {
    name: "mira"
  },
  rules: {
    "no-unnecessary-comment": noUnnecessaryComment,
    "no-unnecessary-return-type": noUnnecessaryReturnType
  }
}
