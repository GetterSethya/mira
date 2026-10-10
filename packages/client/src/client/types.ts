import type { FieldsMap } from "@gettersethya/mira-collection"

import type { ProtectedFileFieldClient, PublicFileFieldClient } from "./file.js"

export type {
  AnyAuthCollectionDef,
  AuthCreateInput,
  AuthUpdateInput,
  CollectionKind,
  CreateInput,
  FileKeys,
  InferCreateInput,
  InferMutationInput,
  InferRecord,
  RegisterInput,
  RelationKeys,
  UpdateInput,
  WithExpand
} from "@gettersethya/mira-collection"

/**
 * Maps file-type fields in a FieldsMap to their corresponding client interfaces.
 * Protected file fields get `ProtectedFileFieldClient`; public file fields get
 * `PublicFileFieldClient`.
 *
 * @example
 * // For { avatar: Field.file({ protected: true }), cover: Field.file() }
 * // CollectionFileFields resolves to:
 * // { avatar: ProtectedFileFieldClient; cover: PublicFileFieldClient }
 *
 * @see PublicFileFieldClient — synchronous URL builder
 * @see ProtectedFileFieldClient — async URL builder with token acquisition
 */
export type CollectionFileFields<F extends FieldsMap> = {
  [K in keyof F as F[K]["kind"] extends "file" ? K : never]:
    F[K] extends { protected: true } ? ProtectedFileFieldClient : PublicFileFieldClient
}
