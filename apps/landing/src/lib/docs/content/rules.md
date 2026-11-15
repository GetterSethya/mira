Write one `defineRule` binding per collection and name who may list, read, create, update, and delete each row. A rule is a per-action expression that the server compiles into a SQL `WHERE` fragment and evaluates on every request against the authenticated user, the request parameters, and the row being read or written. A collection with no rule for an action denies ordinary callers — nothing is open by default.

## Attach rules

`defineRule(Collection, (R) => ({ ... }))` returns a `RuleBinding` holding the per-action expressions. Rules are server-only, so import `defineRule` from `@gettersethya/mira` and attach the bindings with `.rules([...])` on the app builder.

```ts
import { AuthCollection, BaseCollection, defineRule, Field, Mira } from "@gettersethya/mira"

const Users = AuthCollection.define("users", {
  name: Field.text({ required: true })
})

const Posts = BaseCollection.define("posts", {
  title: Field.text({ required: true }),
  status: Field.text({ default: "draft" }),
  author: Field.relation(Users, { required: true })
})

const usersRules = defineRule(Users, (R) => ({
  list: R.public(),
  view: R.public(),
  create: R.public(),
  update: R.field("id").eq(R.selfId()),
  delete: R.field("id").eq(R.selfId())
}))

const postsRules = defineRule(Posts, (R) => ({
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
  .collections([Users, Posts])
  .rules([usersRules, postsRules])
```

The builder also needs `.platform()`, `.database()`, and `.storage()` before `.build()`; they are omitted here to keep the rule wiring visible. The [getting-started page](../getting-started/) shows the full required chain.

The bindings are merged into the collection schemas at build time and carried on the schema as `x-rules`. The builder rejects a second binding for the same collection and throws when a binding names a collection that is not in `.collections([...])`. Any action you omit stays closed. The rules above give every reader the public list, the published-or-own view, and owner-only writes; `usersRules` additionally relies on open signup, which the [auth](../auth/) page covers in full.

## Actions

| Action | Rule evaluated against | Result when the rule fails |
| --- | --- | --- |
| `list` | every row being read | a missing rule is 403; a false rule omits the row |
| `view` | the row with the requested id | a missing rule is 403; a false rule is 404 |
| `create` | the validated payload | 403 |
| `update` | the stored row (request-body operands see the merged patch) | 403 |
| `delete` | the stored row | 403 |
| `manage` | the payload or stored row (auth collections) | no manager privileges |

## manage

`manage` is auth-only. Base collections type it as `never` and view collections expose only `list`/`view`, so declaring it anywhere else is a compile error.

It is additive: it never grants create or update on its own — the base rule still decides whether the request is allowed — and it has no effect on list, view, or delete. On create it is evaluated against the payload with `emailVerified` forced to `false`, so the field it guards cannot satisfy the rule; on update it is evaluated against the stored row. What a matching manager may then write is on [auth](../auth/).

## Operands

`R` is a `RuleBuilder` narrowed to the collection: `R.field()` accepts only declared field names and types each comparison to the field. Base collections also expose `id`, `seqId`, `created`, and `updated`; auth collections add `email`, `emailVerified`, and `selfId()`.

### Record operands

- `R.field("status")` — a record column, chainable with `.eq`, `.neq`, `.gt`, `.gte`, `.lt`, `.lte`, `.in`, `.startsWith`, `.contains`. Comparisons take an operand, so wrap raw values in `R.literal`. `startsWith` and `contains` compile to `LIKE` with a concatenated `%` pattern.
- `R.literal(value)` — a bound value; every literal becomes a SQL parameter and is never interpolated into SQL.
- `R.subquery(Comments, "post").where((Q) => Q.field("author").eq(R.authId(Users)))` — an `IN (SELECT …)` operand; the callback is scoped to the target collection's fields. (Assume a `Comments` collection exists.)

### Auth operands

- `R.authId(Users)` — the authenticated user's `id`. The collection argument is a type/field reference, not a check that the session came from that collection; pair it with `R.authCollection()` when the app has more than one auth collection.
- `R.auth(Users, "emailVerified")` — a field from the authenticated user's record. The same collection caveat applies.
- `R.authCollection()` — the collection name of the authenticated user.
- `R.selfId()` — `authId` for the collection the rule belongs to; available only inside auth-collection rules. See [auth](../auth/) for the session it reads.

### Request operands

- `R.request("header" | "query" | "body", key)` — a request value. `body` is meaningful only for create and update; in list, view, and delete rules it resolves to `null` and never matches.

### Time operands

- `R.now()`, `R.dateAdd(operand, -30, "day")`, `R.dateDiff(left, right, "day")` — timestamp operands.

### Combinators

- `R.public()` — always true; compiles to `1 = 1`.
- `R.and(...)`, `R.or(...)`, `R.not(...)` — boolean combinators; sub-expressions are parenthesised so precedence is explicit.

## Evaluation order

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

## Admin bypass

**Admin bypass is a plugin concern.** `ctx.admin` skips rule compilation entirely — validation still applies. It is granted only when the presented token belongs to a collection a plugin declared as an admin collection; the dashboard's `_superadmin` is the built-in example. An app with no such plugin has an empty admin set and no bypass at all. Adding ordinary app collections to that list would disable their rules, so don't.

## Common mistakes

- A `404` on a record you expected to be `403`: a `view` rule that evaluates false returns 404, so an unreadable record is reported as missing. Only a missing `view` rule is 403.
- A rule on a boolean column does not behave like the record value: the typed `.eq()` does not accept a numeric literal, and rule parameters are bound directly rather than through the collection's boolean encoder. Use a text or numeric field in rule comparisons.
- A caller from a second auth collection satisfies a rule written for the first: `R.authId(Users)` and `R.auth(Users, …)` name a field, not the issuing collection. Pair them with `R.authCollection()`.

## Next

- [Auth collections and sessions](../auth/) for the credential side of a session.
- [Querying and pagination](../querying/) after your list rule decides which rows survive.
