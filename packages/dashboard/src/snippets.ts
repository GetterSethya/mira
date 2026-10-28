import type { ApiCollectionSchema, ApiFieldSchema } from "@gettersethya/mira-client"

import { pascalCase } from "./codegen.js"
import { installCommand, type PackageManager } from "./package-manager.js"

export type SnippetLanguage = "ts" | "bash" | "json"

export type SnippetBlock = {
  readonly id: string
  /** Short label rendered in the block header (e.g. "list", "create", "install"). */
  readonly label: string
  readonly language: SnippetLanguage
  readonly code: string
}

export type SnippetSection = {
  readonly id: string
  readonly heading: string
  readonly description: string
  readonly blocks: ReadonlyArray<SnippetBlock>
}

export type SnippetOptions = {
  readonly schema: ApiCollectionSchema
  readonly allSchemas: ReadonlyArray<ApiCollectionSchema>
  readonly baseUrl: string
  /** Package manager used for install commands. Defaults to `"pnpm"`. */
  readonly packageManager?: PackageManager
}

type FieldInfo = {
  readonly name: string
  readonly field: ApiFieldSchema
}

type BodyEntry = readonly [name: string, value: unknown]

type SnippetKind =
  | "text"
  | "literalText"
  | "number"
  | "integer"
  | "boolean"
  | "email"
  | "date"
  | "json"
  | "relation"
  | "file"

const ERROR_LINE =
  "if (!res.ok) throw new Error(`Mira ${res.status}: ${await res.text()}`)"

/** Sections for the SDK tab: plain client, server client, TanStack adapter. */
export function sdkSections(options: SnippetOptions): ReadonlyArray<SnippetSection> {
  const { schema, baseUrl } = options
  const writable = schema.kind !== "view"
  const auth = schema.kind === "auth"
  const access = accessor(schema.name)
  const manager = options.packageManager ?? "pnpm"
  const install = installBlock(manager)

  const plain: Array<SnippetBlock> = [
    install,
    {
      id: "client",
      label: "client",
      language: "ts",
      code: [
        'import { createMiraClient } from "@gettersethya/mira-client"',
        "",
        'import { collections } from "./mira.generated.js"',
        "",
        `export const mira = createMiraClient(${JSON.stringify(baseUrl)}).withCollections(collections)`
      ].join("\n")
    }
  ]

  if (auth) {
    plain.push(
      {
        id: "register",
        label: "register",
        language: "ts",
        code: [
          "// register() creates the account. It does not log in automatically.",
          `const user = await ${access}.register().raw(${tsObject(createBody(schema), 0)})`
        ].join("\n")
      },
      {
        id: "login",
        label: "login",
        language: "ts",
        code: [
          `const { token, record } = await ${access}.authWithPassword().raw({`,
          '  email: "user@example.com",',
          '  password: "secret123"',
          "})",
          "",
          "// Browser: the server sets an HttpOnly mira_token cookie.",
          "// Server: call mira.auth.setToken(token)."
        ].join("\n")
      },
      {
        id: "me",
        label: "me",
        language: "ts",
        code: `const me = await ${access}.me().raw()`
      }
    )
  }

  plain.push({
    id: "list",
    label: "list",
    language: "ts",
    code: sdkListCode(schema)
  })

  if (writable) {
    plain.push({
      id: "create",
      label: "create",
      language: "ts",
      code: `const created = await ${access}.create().raw(${tsObject(createBody(schema), 0)})`
    })
    plain.push({
      id: "update",
      label: "update",
      language: "ts",
      code: [
        `const updated = await ${access}.update().raw({`,
        "  id: created.id,",
        `  data: ${tsObject(updateBody(schema), 2)}`,
        "})"
      ].join("\n")
    })
    plain.push({
      id: "delete",
      label: "delete",
      language: "ts",
      code: `await ${access}.delete().raw(created.id)`
    })
  } else {
    plain.push({
      id: "get-one",
      label: "get one",
      language: "ts",
      code: [
        'const recordId = "record-id"',
        "",
        `const record = await ${access}.getOne(recordId).raw()`
      ].join("\n")
    })
    plain.push({
      id: "note",
      label: "read-only",
      language: "ts",
      code: `// "${schema.name}" is a view collection — list and getOne only.`
    })
  }

  const file = firstFileField(schema)
  if (writable && file !== undefined) {
    plain.push({
      id: "upload",
      label: "upload",
      language: "ts",
      code: [
        "// `file` is a File or Blob picked from an <input type=\"file\">",
        `const updated = await ${access}.update().raw({`,
        "  id: created.id,",
        `  data: { ${formatKey(file.name)}: file }`,
        "})"
      ].join("\n")
    })
  }

  const serverBlocks: Array<SnippetBlock> = [
    {
      id: "server-client",
      label: "client",
      language: "ts",
      code: [
        'import { createMiraClient } from "@gettersethya/mira-client"',
        "",
        'import { collections } from "./mira.generated.js"',
        "",
        `const mira = createMiraClient(${JSON.stringify(baseUrl)}, { type: "server" }).withCollections(collections)`
      ].join("\n")
    }
  ]

  if (auth) {
    serverBlocks.push({
      id: "server-token",
      label: "set token",
      language: "ts",
      code: [
        `const { token } = await ${access}.authWithPassword().raw({`,
        '  email: "user@example.com",',
        '  password: "secret123"',
        "})",
        "",
        "mira.auth.setToken(token)"
      ].join("\n")
    })
  } else {
    serverBlocks.push({
      id: "server-token",
      label: "set token",
      language: "ts",
      code: 'mira.auth.setToken("eyJhbGciOi...")'
    })
  }

  const adapterBlocks: Array<SnippetBlock> = [
    {
      id: "adapter-install",
      label: "install",
      language: "bash",
      code: installCommand(manager, [
        "@gettersethya/mira-tanstack-adapter",
        "@tanstack/svelte-query"
      ])
    },
    {
      id: "adapter-setup",
      label: "setup",
      language: "ts",
      code: [
        'import { createMiraClient } from "@gettersethya/mira-client"',
        'import { collectionAdapter } from "@gettersethya/mira-tanstack-adapter"',
        "",
        'import { collections } from "./mira.generated.js"',
        "",
        `export const mira = createMiraClient(${JSON.stringify(baseUrl)}).withCollections(collections, {`,
        "  adapter: collectionAdapter",
        "})"
      ].join("\n")
    },
    {
      id: "adapter-query",
      label: "query",
      language: "ts",
      code: [
        'import { createQuery } from "@tanstack/svelte-query"',
        "",
        `const ${camelCase(schema.name)}Query = createQuery(() => ${access}.getList().queryOptions)`
      ].join("\n")
    }
  ]

  if (writable) {
    adapterBlocks.push({
      id: "adapter-mutation",
      label: "mutation",
      language: "ts",
      code: [
        'import { createMutation } from "@tanstack/svelte-query"',
        "",
        `const create${pascalCase(schema.name)} = createMutation(() => ${access}.create().mutationOptions)`
      ].join("\n")
    })
  }

  return [
    {
      id: "plain",
      heading: "Plain client",
      description: auth
        ? "Browser client with cookie-based auth. register() creates the account (it does not log in); authWithPassword() logs in and the server sets an HttpOnly cookie."
        : "Browser client with cookie-based auth. Import the generated collection map, then call typed methods.",
      blocks: plain
    },
    {
      id: "server",
      heading: "Server-to-server",
      description:
        "Server-side client using a Bearer token. Set the token once per request context.",
      blocks: serverBlocks
    },
    {
      id: "adapter",
      heading: "With TanStack Query",
      description:
        "TanStack Query integration. Every query and mutation exposes ready-made options.",
      blocks: adapterBlocks
    }
  ]
}

/** Sections for the fetch tab, `fetch` flavour. */
export function fetchSections(options: SnippetOptions): ReadonlyArray<SnippetSection> {
  const { schema, allSchemas, baseUrl } = options
  const writable = schema.kind !== "view"
  const auth = schema.kind === "auth"
  const collectionUrl = joinUrl(baseUrl, `/api/collections/${schema.name}`)
  const filterNode = buildFilterNode(schema)

  const readBlocks: Array<SnippetBlock> = [
    {
      id: "list",
      label: "list",
      language: "ts",
      code: fetchListCode(schema, collectionUrl, allSchemas)
    },
    {
      id: "filter",
      label: "filter",
      language: "json",
      code: JSON.stringify(filterNode, null, 2)
    },
    {
      id: "filter-url",
      label: "filter url",
      language: "bash",
      code: `${collectionUrl}?filter=${encodeURIComponent(JSON.stringify(filterNode))}`
    },
    {
      id: "get-one",
      label: "get one",
      language: "ts",
      code: fetchGetOneCode(collectionUrl)
    }
  ]

  if (!writable) {
    readBlocks.push({
      id: "note",
      label: "read-only",
      language: "ts",
      code: `// "${schema.name}" is a view collection — list and getOne only.`
    })
  }

  const sections: Array<SnippetSection> = [
    {
      id: "read",
      heading: "Read",
      description: writable
        ? "Read records over HTTP. Browser calls use the session cookie; server calls send a Bearer token. Query parameters are encoded with URLSearchParams."
        : "Read records over HTTP. View collections are read-only: list and getOne only.",
      blocks: readBlocks
    }
  ]

  if (auth) {
    sections.push({
      id: "auth",
      heading: "Authentication",
      description:
        "Register an account, log in, and fetch the current user. The browser keeps the session cookie.",
      blocks: [
        {
          id: "register",
          label: "register",
          language: "ts",
          code: fetchRegisterCode(schema, collectionUrl)
        },
        {
          id: "login",
          label: "login",
          language: "ts",
          code: fetchLoginCode(collectionUrl)
        },
        {
          id: "me",
          label: "me",
          language: "ts",
          code: fetchMeCode(baseUrl)
        }
      ]
    })
  }

  if (writable) {
    const writeBlocks: Array<SnippetBlock> = [
      {
        id: "create",
        label: "create",
        language: "ts",
        code: fetchCreateCode(schema, collectionUrl)
      },
      {
        id: "update",
        label: "update",
        language: "ts",
        code: fetchUpdateCode(schema, collectionUrl)
      },
      {
        id: "delete",
        label: "delete",
        language: "ts",
        code: fetchDeleteCode(collectionUrl)
      }
    ]

    if (firstFileField(schema) !== undefined) {
      writeBlocks.push({
        id: "upload",
        label: "upload",
        language: "ts",
        code: fetchUploadCode(schema, collectionUrl)
      })
    }

    sections.push({
      id: "write",
      heading: "Write",
      description: "Write records over HTTP. JSON bodies carry the required fields.",
      blocks: writeBlocks
    })
  }

  return sections
}

/** Sections for the fetch tab, `curl` flavour. */
export function curlSections(options: SnippetOptions): ReadonlyArray<SnippetSection> {
  const { schema, allSchemas, baseUrl } = options
  const writable = schema.kind !== "view"
  const auth = schema.kind === "auth"
  const collectionUrl = joinUrl(baseUrl, `/api/collections/${schema.name}`)
  const filterNode = buildFilterNode(schema)

  const readBlocks: Array<SnippetBlock> = [
    {
      id: "list",
      label: "list",
      language: "bash",
      code: curlGet(`${collectionUrl}?${queryString(listParams(schema, allSchemas))}`, true)
    },
    {
      id: "filter",
      label: "filter",
      language: "bash",
      code: curlGet(
        `${collectionUrl}?filter=${encodeURIComponent(JSON.stringify(filterNode))}`,
        true
      )
    },
    {
      id: "get-one",
      label: "get one",
      language: "bash",
      code: curlGet(`${collectionUrl}/record-id`, true)
    }
  ]

  if (!writable) {
    readBlocks.push({
      id: "note",
      label: "read-only",
      language: "bash",
      code: `# "${schema.name}" is a view collection — list and getOne only.`
    })
  }

  const sections: Array<SnippetSection> = [
    {
      id: "read",
      heading: "Read",
      description: writable
        ? "The same requests as curl. Replace <token> with a JWT or use the session cookie."
        : "The same requests as curl. View collections are read-only.",
      blocks: readBlocks
    }
  ]

  if (auth) {
    sections.push({
      id: "auth",
      heading: "Authentication",
      description:
        "Register an account, exchange credentials for a JWT, then send it as a Bearer token.",
      blocks: [
        {
          id: "register",
          label: "register",
          language: "bash",
          code: [
            "# register = a create on an auth collection; it does not log in automatically",
            curlJson("POST", collectionUrl, createBody(schema), false)
          ].join("\n")
        },
        {
          id: "login",
          label: "login",
          language: "bash",
          code: curlJson(
            "POST",
            `${collectionUrl}/auth-with-password`,
            [
              ["email", "user@example.com"],
              ["password", "secret123"]
            ],
            false
          )
        },
        {
          id: "me",
          label: "me",
          language: "bash",
          code: curlGet(joinUrl(baseUrl, "/api/auth/me"), true)
        }
      ]
    })
  }

  if (writable) {
    const writeBlocks: Array<SnippetBlock> = [
      {
        id: "create",
        label: "create",
        language: "bash",
        code: curlJson("POST", collectionUrl, createBody(schema), true)
      },
      {
        id: "update",
        label: "update",
        language: "bash",
        code: curlJson("PATCH", `${collectionUrl}/record-id`, updateBody(schema), true)
      },
      {
        id: "delete",
        label: "delete",
        language: "bash",
        code: curlRequest(`${collectionUrl}/record-id`, ["-X DELETE"], true)
      }
    ]

    const file = firstFileField(schema)
    if (file !== undefined) {
      writeBlocks.push({
        id: "upload",
        label: "upload",
        language: "bash",
        code: curlRequest(
          `${collectionUrl}/record-id`,
          ["-X PATCH", `-F "${file.name}=@${file.name}.png"`],
          true
        )
      })
    }

    sections.push({
      id: "write",
      heading: "Write",
      description: "JSON writes; upload a file with multipart/form-data.",
      blocks: writeBlocks
    })
  }

  return sections
}

function installBlock(manager: PackageManager): SnippetBlock {
  return {
    id: "install",
    label: "install",
    language: "bash",
    code: installCommand(manager, ["@gettersethya/mira-client"])
  }
}

function sdkListCode(schema: ApiCollectionSchema): string {
  const access = accessor(schema.name)
  const filter = filterField(schema)
  const lines = [`const { items, nextCursor } = await ${access}.getList({`]

  if (filter !== undefined) {
    lines.push(
      `  filter: (f) => f.field(${JSON.stringify(filter.name)}).eq(${tsValue(sampleValue(filter.name, filter.field))}),`
    )
    lines.push(`  sort: ${JSON.stringify(filter.name)},`)
    lines.push('  order: "desc",')
  }

  lines.push("  limit: 25")
  lines.push("}).raw()")
  return lines.join("\n")
}

function fetchListCode(
  schema: ApiCollectionSchema,
  collectionUrl: string,
  allSchemas: ReadonlyArray<ApiCollectionSchema>
): string {
  return [
    '// Browser: session cookie. Server: headers: { authorization: "Bearer <token>" }',
    `const params = new URLSearchParams(${tsObject(listParams(schema, allSchemas), 0)})`,
    "",
    `const res = await fetch(\`${collectionUrl}?\${params}\`, {`,
    '  credentials: "include"',
    "})",
    ERROR_LINE,
    "const { items, nextCursor } = await res.json()"
  ].join("\n")
}

function fetchGetOneCode(collectionUrl: string): string {
  return [
    `const res = await fetch(\`${collectionUrl}/record-id\`, {`,
    '  credentials: "include"',
    "})",
    ERROR_LINE,
    "const record = await res.json()"
  ].join("\n")
}

function fetchCreateCode(schema: ApiCollectionSchema, collectionUrl: string): string {
  return fetchJsonWrite("POST", collectionUrl, createBody(schema))
}

function fetchUpdateCode(schema: ApiCollectionSchema, collectionUrl: string): string {
  return fetchJsonWrite("PATCH", `${collectionUrl}/record-id`, updateBody(schema))
}

function fetchJsonWrite(
  method: "POST" | "PATCH",
  url: string,
  body: ReadonlyArray<BodyEntry>
): string {
  return [
    `const res = await fetch(\`${url}\`, {`,
    `  method: ${JSON.stringify(method)},`,
    '  credentials: "include",',
    '  headers: { "content-type": "application/json" },',
    `  body: JSON.stringify(${tsObject(body, 2)})`,
    "})",
    ERROR_LINE,
    "const record = await res.json()"
  ].join("\n")
}

function fetchDeleteCode(collectionUrl: string): string {
  return [
    `const res = await fetch(\`${collectionUrl}/record-id\`, {`,
    '  method: "DELETE",',
    '  credentials: "include"',
    "})",
    ERROR_LINE
  ].join("\n")
}

function fetchUploadCode(schema: ApiCollectionSchema, collectionUrl: string): string {
  const file = firstFileField(schema)
  const fieldName = file === undefined ? "file" : file.name

  return [
    "const form = new FormData()",
    `form.set(${JSON.stringify(fieldName)}, file)`,
    "",
    `const res = await fetch(\`${collectionUrl}/record-id\`, {`,
    '  method: "PATCH",',
    '  credentials: "include",',
    "  body: form",
    "})",
    ERROR_LINE,
    "const record = await res.json()"
  ].join("\n")
}

function fetchRegisterCode(
  schema: ApiCollectionSchema,
  collectionUrl: string
): string {
  return [
    "// register = a create on an auth collection; it does not log in automatically",
    fetchJsonWrite("POST", collectionUrl, createBody(schema))
  ].join("\n")
}

function fetchLoginCode(collectionUrl: string): string {
  return [
    `const res = await fetch(\`${collectionUrl}/auth-with-password\`, {`,
    '  method: "POST",',
    '  credentials: "include",',
    '  headers: { "content-type": "application/json" },',
    '  body: JSON.stringify({ email: "user@example.com", password: "secret123" })',
    "})",
    ERROR_LINE,
    "const { token, record } = await res.json()"
  ].join("\n")
}

function fetchMeCode(baseUrl: string): string {
  return [
    `const res = await fetch(${JSON.stringify(joinUrl(baseUrl, "/api/auth/me"))}, {`,
    '  credentials: "include"',
    "})",
    ERROR_LINE,
    "const me = await res.json()"
  ].join("\n")
}

function curlGet(url: string, auth: boolean): string {
  return curlRequest(url, [], auth)
}

function curlJson(
  method: "POST" | "PATCH",
  url: string,
  body: ReadonlyArray<BodyEntry>,
  auth: boolean
): string {
  return curlRequest(
    url,
    [`-X ${method}`, '-H "content-type: application/json"', `-d '${jsonBody(body)}'`],
    auth
  )
}

function curlRequest(
  url: string,
  options: ReadonlyArray<string>,
  auth: boolean
): string {
  const parts = [`curl "${url}"`, ...options]
  if (auth) parts.push('-H "authorization: Bearer <token>"')
  if (parts.length > 1) return parts.join(" \\\n  ")
  return parts[0] ?? `curl "${url}"`
}

function listParams(
  schema: ApiCollectionSchema,
  allSchemas: ReadonlyArray<ApiCollectionSchema>
): ReadonlyArray<readonly [string, string]> {
  const params: Array<readonly [string, string]> = [["limit", "25"]]
  const sort = filterField(schema)

  if (sort !== undefined) {
    params.push(["sort", sort.name])
    params.push(["order", "desc"])
  }

  const select = selectFieldNames(schema)
  if (select.length > 0) params.push(["select", select.join(",")])

  const expand = relationFieldNames(schema, allSchemas)
  if (expand.length > 0) params.push(["expand", expand.join(",")])

  return params
}

function queryString(params: ReadonlyArray<readonly [string, string]>): string {
  return params
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&")
}

function buildFilterNode(schema: ApiCollectionSchema): {
  readonly op: "eq"
  readonly field: string
  readonly value: unknown
} {
  const filter = filterField(schema)
  if (filter === undefined) {
    return { op: "eq", field: "id", value: "record-id" }
  }
  return {
    op: "eq",
    field: filter.name,
    value: sampleValue(filter.name, filter.field)
  }
}

function filterField(schema: ApiCollectionSchema): FieldInfo | undefined {
  for (const [name, field] of Object.entries(schema.fields)) {
    if (field["x-system"] === true) continue
    if (field["x-hidden"] === true) continue
    if (name === "id") continue

    const kind = fieldKind(field)
    if (
      kind === "text" ||
      kind === "literalText" ||
      kind === "number" ||
      kind === "integer" ||
      kind === "boolean" ||
      kind === "email" ||
      kind === "date"
    ) {
      return { name, field }
    }
  }

  return undefined
}

function selectFieldNames(schema: ApiCollectionSchema): ReadonlyArray<string> {
  const names: Array<string> = []

  for (const [name, field] of Object.entries(schema.fields)) {
    if (field["x-system"] === true) continue
    if (field["x-hidden"] === true) continue
    if (fieldKind(field) === "file") continue
    if (field["x-kind"] === "seqId") continue

    names.push(name)
    if (names.length === 3) break
  }

  return names
}

function relationFieldNames(
  schema: ApiCollectionSchema,
  allSchemas: ReadonlyArray<ApiCollectionSchema>
): ReadonlyArray<string> {
  const known = new Set<string>()
  for (const candidate of allSchemas) known.add(candidate.name)

  const names: Array<string> = []

  for (const [name, field] of Object.entries(schema.fields)) {
    if (field["x-kind"] !== "relation") continue
    if (field["x-hidden"] === true) continue
    const target = field["x-collection"]
    if (target === undefined || !known.has(target)) continue
    names.push(name)
  }

  return names
}

function firstFileField(schema: ApiCollectionSchema): FieldInfo | undefined {
  for (const [name, field] of Object.entries(schema.fields)) {
    if (fieldKind(field) === "file") return { name, field }
  }
  return undefined
}

function createBody(schema: ApiCollectionSchema): ReadonlyArray<BodyEntry> {
  const body: Array<BodyEntry> = []
  const required = new Set(schema.required ?? [])
  const included = new Set<string>()

  if (schema.kind === "auth") {
    body.push(["email", "user@example.com"])
    body.push(["password", "secret123"])
    body.push(["passwordConfirm", "secret123"])
    included.add("email")
    included.add("password")
    included.add("passwordConfirm")
  }

  for (const [name, field] of Object.entries(schema.fields)) {
    if (field["x-system"] === true) continue
    if (fieldKind(field) === "file") continue
    if (!required.has(name)) continue
    if (included.has(name)) continue

    body.push([name, sampleValue(name, field)])
    included.add(name)
  }

  for (const [name, field] of Object.entries(schema.fields)) {
    if (field["x-system"] === true) continue
    if (field["x-hidden"] === true) continue
    if (required.has(name)) continue
    if (included.has(name)) continue
    if (fieldKind(field) === "file") continue

    body.push([name, sampleValue(name, field)])
    break
  }

  return body
}

function updateBody(schema: ApiCollectionSchema): ReadonlyArray<BodyEntry> {
  for (const [name, field] of Object.entries(schema.fields)) {
    if (field["x-system"] === true) continue
    if (field["x-hidden"] === true) continue
    if (fieldKind(field) === "file") continue
    return [[name, sampleValue(name, field)]]
  }
  return []
}

function sampleValue(name: string, field: ApiFieldSchema): unknown {
  const kind = fieldKind(field)

  if (kind === "text") return `<${name}>`
  if (kind === "email") return "user@example.com"
  if (kind === "literalText") {
    const literals = field["x-literal"]
    return literals !== undefined && literals.length > 0 ? literals[0] : `<${name}>`
  }
  if (kind === "number" || kind === "integer") return 0
  if (kind === "boolean") return true
  if (kind === "date") return "2026-01-01T00:00:00.000Z"
  if (kind === "json") return {}
  if (kind === "relation") {
    const target = field["x-collection"] ?? "records"
    const targetField = field["x-field"] ?? "id"
    return `<${target}.${targetField}>`
  }
  if (kind === "file") return "file.png"
  return name
}

function fieldKind(field: ApiFieldSchema): SnippetKind {
  const xKind = field["x-kind"]

  if (xKind === "literalText") return "literalText"
  if (xKind === "relation") return "relation"
  if (xKind === "file") return "file"
  if (xKind === "date") return "date"
  if (xKind === "json") return "json"
  if (xKind === "seqId") return "integer"

  if (field.format === "email") return "email"
  if (field.type === "number") return "number"
  if (field.type === "integer") return "integer"
  if (field.type === "boolean") return "boolean"
  if (field.type === "object") return "json"

  return "text"
}

function accessor(collectionName: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(collectionName)) {
    return `mira.${collectionName}`
  }
  return `mira[${JSON.stringify(collectionName)}]`
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "")
  const suffix = path.startsWith("/") ? path : `/${path}`
  return `${base}${suffix}`
}

function tsObject(
  entries: ReadonlyArray<BodyEntry>,
  closingIndent: number
): string {
  if (entries.length === 0) return "{}"

  const indent = " ".repeat(closingIndent)
  const fields = entries
    .map(([name, value]) => `${indent}  ${formatKey(name)}: ${tsValue(value)}`)
    .join(",\n")

  return `{\n${fields}\n${indent}}`
}

function tsValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === null) return "null"
  return JSON.stringify(value) ?? "undefined"
}

function jsonBody(entries: ReadonlyArray<BodyEntry>): string {
  const body: Record<string, unknown> = {}
  for (const [name, value] of entries) body[name] = value
  return JSON.stringify(body)
}

function formatKey(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)
}

function pascal(name: string): string {
  return pascalCase(name)
}

function camelCase(name: string): string {
  const value = pascalCase(name)
  return value.charAt(0).toLowerCase() + value.slice(1)
}
