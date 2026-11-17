import type { BaseRuleMap,FieldDef,FieldsMap, RuleMap } from "@gettersethya/mira-client"
import type { FieldOperand,RuleBuilder } from "@gettersethya/mira-client"
import { makeRuleBuilder, toChainable } from "@gettersethya/mira-client"

type BaseSystemFieldDefs = {
  id:      FieldDef & { kind: "text" }
  created: FieldDef & { kind: "date" }
  updated: FieldDef & { kind: "date" }
  seqId:   FieldDef & { kind: "seqId" }
}

type AuthSystemFieldDefs = {
  id:            FieldDef & { kind: "text" }
  email:         FieldDef & { kind: "email" }
  emailVerified: FieldDef & { kind: "boolean" }
  created:       FieldDef & { kind: "date" }
  updated:       FieldDef & { kind: "date" }
  seqId:         FieldDef & { kind: "seqId" }
}

export interface RuleBinding {
  readonly _tag: "RuleBinding"
  readonly collectionName: string
  readonly ruleMap: RuleMap
}

export type ViewRuleMap = {
  list?: RuleMap["list"]
  view?: RuleMap["view"]
}

type AuthRuleBuilder<F extends FieldsMap> = RuleBuilder<F & AuthSystemFieldDefs> & {
  selfId(): FieldOperand<string, string>
}

type RuleMapResult = RuleMap | ViewRuleMap | BaseRuleMap
// oxlint-disable-next-line typescript/no-explicit-any
type AnyRuleCallback = (R: any) => any

function collectRuleMap(result: RuleMapResult): RuleMap {
  const map: RuleMap = {}
  if (result.list !== undefined) map.list = result.list
  if (result.view !== undefined) map.view = result.view
  if ("create" in result && result.create !== undefined) map.create = result.create
  if ("update" in result && result.update !== undefined) map.update = result.update
  if ("delete" in result && result.delete !== undefined) map.delete = result.delete
  if ("manage" in result && result.manage !== undefined) map.manage = result.manage
  return map
}

export function defineRule<F extends FieldsMap>(
  collection: { name: string; fields: F; schema: { "x-collection-kind": "auth" } },
  cb: (R: AuthRuleBuilder<F>) => RuleMap
): RuleBinding

export function defineRule<F extends FieldsMap>(
  collection: { name: string; fields: F; schema: { "x-collection-kind": "view" } },
  cb: (R: RuleBuilder<F>) => ViewRuleMap
): RuleBinding

export function defineRule<F extends FieldsMap>(
  collection: { name: string; fields: F; schema: { "x-collection-kind": "base" } },
  cb: (R: RuleBuilder<F & BaseSystemFieldDefs>) => BaseRuleMap
): RuleBinding

export function defineRule<F extends FieldsMap>(
  collection: { name: string; fields: F; schema: { "x-collection-kind": string } },
  cb: AnyRuleCallback
): RuleBinding {
  const kind = collection.schema["x-collection-kind"]

  if (kind === "auth") {
    const authBuilder: AuthRuleBuilder<F> = {
      ...makeRuleBuilder<F & AuthSystemFieldDefs>(),
      selfId(): FieldOperand<string, string> {
        return toChainable<string, string>({ kind: "authId", collection: collection.name })
      }
    }
    return { _tag: "RuleBinding", collectionName: collection.name, ruleMap: collectRuleMap(cb(authBuilder)) }
  }

  if (kind === "view") {
    const viewBuilder = makeRuleBuilder<F>()
    return { _tag: "RuleBinding", collectionName: collection.name, ruleMap: collectRuleMap(cb(viewBuilder)) }
  }

  const baseBuilder = makeRuleBuilder<F & BaseSystemFieldDefs>()
  return { _tag: "RuleBinding", collectionName: collection.name, ruleMap: collectRuleMap(cb(baseBuilder)) }
}
