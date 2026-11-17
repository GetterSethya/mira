# Linting

`pnpm lint` runs Oxlint over the collection, client, and mira packages. The
shared configuration is `.oxlintrc.json`; package scripts pass it explicitly so
each workspace package resolves the same rules.

## Custom rules

`tooling/oxlint-plugin-mira.ts` adds two project rules:

- `mira/no-unnecessary-return-type` flags primitive return annotations on
  non-exported functions when the body already makes the type obvious. Public
  exports are exempt because their annotation is the API contract.
- `mira/no-unnecessary-comment` flags comments that only restate code, comment
  out code, or carry no information. Comments that explain intent, trade-offs,
  or non-obvious constraints are allowed.

## Escape hatches

Use a directive comment directly above the function or statement:

```ts
// @explicit-return
function narrowsUnion(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}
```

The same rule also honors Oxlint's standard disable directive:

```ts
// oxlint-disable-next-line mira/no-unnecessary-return-type
function publicHelper(): number {
  return 1
}
```

Use the standard form for every other rule, for example:

```ts
// oxlint-disable-next-line typescript/no-explicit-any
const externalPayload: any = source
```

## AGENTS.md coverage

The configuration maps the enforceable TypeScript conventions from
`AGENTS.md`:

- no relative parent imports
- no type assertions (`as` and angle-bracket forms)
- no non-null assertions
- no explicit `any`
- no inferrable variable or parameter type annotations
- no inline `import()` type expressions
- no bare `TODO` / `FIXME` comments
- no `JSON.parse` / `JSON.stringify` in Effect code
- `@ts-expect-error` must include a description

Rules that need semantic knowledge of Effect generators, tagged errors, or
`sql.unsafe` call sites are not represented yet. Add custom rules when the
project is ready to handle their violation baseline.
