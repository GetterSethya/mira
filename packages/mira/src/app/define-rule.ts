import type { FieldsMap, RuleMap, AnyCollectionDef, FieldDef } from "@gettersethya/mira-client"
import type { RuleBuilder, OperandNode } from "@gettersethya/mira-client"
import { makeRuleBuilder } from "@gettersethya/mira-client"

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

export function defineRule<F extends FieldsMap>(
  collection: AnyCollectionDef & { fields: F; schema: { "x-collection-kind": "auth" } },
  cb: (R: RuleBuilder<F & AuthSystemFieldDefs> & { selfId(): OperandNode<any, string> }) => RuleMap
): RuleBinding

export function defineRule<F extends FieldsMap>(
  collection: AnyCollectionDef & { fields: F },
  cb: (R: RuleBuilder<F & BaseSystemFieldDefs>) => RuleMap
): RuleBinding

export function defineRule<F extends FieldsMap>(
  collection: AnyCollectionDef & { fields: F },
  cb: (R: any) => RuleMap
): RuleBinding {
  if (collection.schema["x-collection-kind"] === "auth") {
    const authBuilder = {
      ...makeRuleBuilder<F & AuthSystemFieldDefs>(),
      selfId(): OperandNode<any, string> { return { kind: "authId", collection: collection.name } }
    }
    const ruleMap = cb(authBuilder as any)
    return { _tag: "RuleBinding", collectionName: collection.name, ruleMap }
  }
  const builder = makeRuleBuilder<F & BaseSystemFieldDefs>()
  const ruleMap = (cb as (R: RuleBuilder<F & BaseSystemFieldDefs>) => RuleMap)(builder)
  return { _tag: "RuleBinding", collectionName: collection.name, ruleMap }
}
