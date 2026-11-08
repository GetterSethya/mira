Rules decide what each caller may do with a record. Each collection action carries its own rule, the server compiles that rule into a SQL `WHERE` fragment, and the fragment is evaluated on every request against the authenticated user, the request parameters, and the row being read or written. A collection with no rule for an action denies ordinary callers — nothing is open by default.

## Define rules on the server

`defineRule(Collection, (R) => ({ ... }))` returns a `RuleBinding` holding the per-action expressions. Collection definitions can stay in code shared with the client; rules are server-only, so import `defineRule` from `@gettersethya/mira` and attach the bindings with `.rules([...])` on the app builder.

```ts
import { AuthCollection, BaseCollection, Field } from "@gettersethya/mira-client"
import { defineRule, Mira } from "@gettersethya/mira"

const Users = AuthCollection.define("users", {
  name: Field.text({ required: true })
})

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true }),
  status: Field.text({ default: "draft" }),
  author: Field.relation(Users, { required: true })
})

const userRules = defineRule(Users, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  delete: R.field("id").eq(R.selfId())
}))

const postRules = defineRule(Posts, (R) => ({
  list: R.public(),
  view: R.or(
    R.field("status").eq(R.literal("published")),
    R.field("author").eq(R.authId(Users))
  ),
  create: R.field("author").eq(R.authId(Users)),
  update: R.field("author").eq(R.authId(Users)),
  delete: R.field("author").eq(R.authId(Users))
}))

Mira.builder()
  // .platform(NodePlatform).database(SqliteDatabase()).storage(LocalFileStorage())
  .collections([Users, Posts])
  .rules([userRules, postRules])
```

The builder also needs `platform`, `database`, and `storage` before `build()`; they are commented out here to keep the rule wiring visible. The [getting-started page](../getting-started/) shows the full required chain.

The bindings are merged into the collection schemas at build time and carried on the schema as `x-rules`. The builder rejects a second binding for the same collection and throws when a binding names a collection that is not in `.collections([...])`. Any action you omit stays closed. The rules above give every reader the public list, the published-or-own view, and owner-only writes; `userRules` additionally relies on open signup, which the [auth](../auth/) page covers in full.

## Actions

| Action | Rule evaluated against | Result when the rule fails |
| --- | --- | --- |
| `list` | every row being read | a missing rule is 403; a false rule omits the row |
| `view` | the row with the requested id | a missing rule is 403; a false rule is 404 |
| `create` | the validated payload | 403 |
| `update` | the stored row (request-body operands see the merged patch) | 403 |
| `delete` | the stored row | 403 |
| `manage` | the payload or stored row (auth collections) | no manager privileges |

### `manage`

`manage` is auth-only. Base collections type it as `never` and view collections expose only `list`/`view`, so declaring it anywhere else is a compile error. It is additive: it never grants create or update on its own — the base rule still decides whether the request is allowed — and it has no effect on list, view, or delete. When both rules allow, `manage` lifts the credential restrictions: a manager may set `email` and `emailVerified`, and change a password without `oldPassword`. A matching `passwordConfirm` is still required, and the create-time check evaluates the payload with `emailVerified` forced to `false` so the field it guards cannot game the rule.

## Operands

`R` is a `RuleBuilder` narrowed to the collection: `R.field()` accepts only declared field names and types each comparison to the field. Base collections also expose `id`, `seqId`, `created`, and `updated`; auth collections add `email`, `emailVerified`, and `selfId()`.

- `R.public()` — always true; compiles to `1 = 1`.
- `R.field("status")` — a record column, chainable with `.eq`, `.neq`, `.gt`, `.gte`, `.lt`, `.lte`, `.in`, `.startsWith`, `.contains`. Comparisons take an operand, so wrap raw values in `R.literal`. `startsWith` and `contains` compile to `LIKE` with a concatenated `%` pattern.
- `R.literal(value)` — a bound value; every literal becomes a SQL parameter and is never interpolated into SQL.
- `R.authId(Users)` — the authenticated user's `id`. The collection argument is a type/field reference, not a check that the session came from that collection; pair it with `R.authCollection()` when the app has more than one auth collection.
- `R.auth(Users, "emailVerified")` — a field from the authenticated user's record. The same collection caveat applies.
- `R.authCollection()` — the collection name of the authenticated user.
- `R.selfId()` — `authId` for the collection the rule belongs to; available only inside auth-collection rules.
- `R.and(...)`, `R.or(...)`, `R.not(...)` — boolean combinators; sub-expressions are parenthesised so precedence is explicit.
- `R.subquery(Comments, "post").where((Q) => Q.field("author").eq(R.authId(Users)))` — an `IN (SELECT …)` operand; the callback is scoped to the target collection's fields. (Assume a `Comments` collection exists.)
- `R.request("header" | "query" | "body", key)` — a request value. `body` is meaningful only for create and update; in list, view, and delete rules it resolves to `null` and never matches.
- `R.now()`, `R.dateAdd(operand, -30, "day")`, `R.dateDiff(left, right, "day")` — timestamp operands.

Use a text or numeric field in rule examples when possible; the typed `.eq()` on a boolean field does not accept a numeric literal, and rule parameters are bound directly rather than through the collection's boolean encoder.

## Evaluation order and bypasses

A rule is looked up by action, compiled, and then bound in this order:

1. `list` compiles to a `WHERE` clause ANDed with your filter and cursor; the sort is applied to the rows that survive. A missing rule is 403; a rule that evaluates false omits the row rather than rejecting the page.
2. `view` ANDs the rule with `t.id = ?`. A missing rule is 403; a false rule returns 404, so an invisible record is indistinguishable from a missing one.
3. `create` evaluates the rule against the validated payload with `SELECT 1 WHERE …` before inserting.
4. `update` checks the stored row by id before writing; `R.request("body", …)` sees the merged patch, not the stored row.
5. `delete` checks the stored row by id.
6. `manage` is evaluated together with `create` and `update` on auth collections; it never replaces the base action rule.

The missing-rule check for update and delete runs before any row is loaded, so a closed action cannot leak existence. A rule that references the authenticated user fails closed with 403 when the request has no session. A body reference in a list, view, or delete rule can never match, and the server logs one warning per collection and action at startup.

The `view` rule from `Posts` above compiles to roughly:

```sql
WHERE ((t.status = ?) OR (t.author = ?)) AND (t.id = ?)
```

**Admin bypass is a plugin concern.** `ctx.admin` skips rule compilation entirely — validation still applies. It is granted only when the presented token belongs to a collection a plugin declared as an admin collection; the dashboard's `_superadmin` is the built-in example. An app with no such plugin has an empty admin set and no bypass at all. Adding ordinary app collections to that list would disable their rules, so don't.

Rules govern row access, not credentials. Password confirmation, `oldPassword`, and `emailVerified` are enforced at the collection service write chokepoint — see [auth](../auth/) — and the request status mapping for 403, 404, and 422 is in [http-api](../http-api/).
