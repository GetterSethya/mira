import type { Effect } from "effect";
import { Context } from "effect"

export class CryptoService extends Context.Service<
  CryptoService,
  {
    /** Synchronous variant — for use in callbacks that cannot yield an Effect. */
    randomBytesSync(size: number): Uint8Array
    randomBytes(size: number): Effect.Effect<Uint8Array>
    randomUUID(): Effect.Effect<string>
  }
>()("CryptoService") {}
