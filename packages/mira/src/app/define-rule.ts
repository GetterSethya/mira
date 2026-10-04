import type { FieldDef,FieldsMap, RuleMap } from "@gettersethya/mira-client"
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

export function defineRule<F extends FieldsMap>(
  collection: { name: string; fields: F; schema: { "x-collection-kind": "auth" } },
  cb: (R: RuleBuilder<F & AuthSystemFieldDefs> & { selfId(): FieldOperand<any, string> }) => RuleMap
): RuleBinding

export function defineRule<F extends FieldsMap>(
  collection: { name: string; fields: F; schema: { "x-collection-kind": "view" } },
  cb: (R: RuleBuilder<F>) => ViewRuleMap
): RuleBinding

export function defineRule<F extends FieldsMap>(
  collection: { name: string; fields: F; schema: { "x-collection-kind": "base" } },
  cb: (R: RuleBuilder<F & BaseSystemFieldDefs>) => RuleMap
): RuleBinding

export function defineRule<F extends FieldsMap>(
  collection: { name: string; fields: F; schema: { "x-collection-kind": string } },
  cb: (R: any) => any
): RuleBinding {
  const kind = collection.schema["x-collection-kind"]

  if (kind === "auth") {
    const authBuilder = {
      ...makeRuleBuilder<F & AuthSystemFieldDefs>(),
      selfId(): FieldOperand<any, string> {
        return toChainable<any, string>({ kind: "authId", collection: collection.name })
      }
    }
    const result = cb(authBuilder)
    const ruleMap: RuleMap = {
      ...(result.list !== undefined ? { list: result.list } : {}),
      ...(result.view !== undefined ? { view: result.view } : {}),
      ...(result.create !== undefined ? { create: result.create } : {}),
      ...(result.update !== undefined ? { update: result.update } : {}),
      ...(result.delete !== undefined ? { delete: result.delete } : {}),
    }
    return { _tag: "RuleBinding", collectionName: collection.name, ruleMap }
  }

  if (kind === "view") {
    const viewBuilder = makeRuleBuilder<F>()
    const result = cb(viewBuilder)
    const ruleMap: RuleMap = {
      ...(result.list !== undefined ? { list: result.list } : {}),
      ...(result.view !== undefined ? { view: result.view } : {}),
    }
    return { _tag: "RuleBinding", collectionName: collection.name, ruleMap }
  }

  const baseBuilder = makeRuleBuilder<F & BaseSystemFieldDefs>()
  const result = cb(baseBuilder)
  const ruleMap: RuleMap = {
    ...(result.list !== undefined ? { list: result.list } : {}),
    ...(result.view !== undefined ? { view: result.view } : {}),
    ...(result.create !== undefined ? { create: result.create } : {}),
    ...(result.update !== undefined ? { update: result.update } : {}),
    ...(result.delete !== undefined ? { delete: result.delete } : {}),
  }
  return { _tag: "RuleBinding", collectionName: collection.name, ruleMap }
}
