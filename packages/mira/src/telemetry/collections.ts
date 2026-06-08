import type { AnyCollectionDef } from "@gettersethya/mira-client"
import { BaseCollection, Field } from "@gettersethya/mira-client"

export const LogsCollection: AnyCollectionDef = BaseCollection.define("logs", {
  level:   Field.text(),
  message: Field.text(),
  traceId: Field.text({ required: false }),
  spanId:  Field.text({ required: false }),
})

export const SpansCollection: AnyCollectionDef = BaseCollection.define("spans", {
  name:         Field.text(),
  traceId:      Field.text(),
  spanId:       Field.text(),
  parentSpanId: Field.text({ required: false }),
  kind:         Field.text(),
  durationMs:   Field.number(),
  status:       Field.text(),
  error:        Field.text({ required: false }),
  attributes:   Field.text(),
})
