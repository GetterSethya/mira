import { Layer } from "effect"

import { AuthService } from "./auth.js"
import { hashScryptPassword, verifyScryptPassword } from "./password-scrypt.js"

/** Node auth layer: scrypt hashing with the durable `scrypt$<salt>$<hash>` format. */
export const NodeAuthServiceLayer = Layer.succeed(
  AuthService,
  AuthService.of({
    hashPassword: hashScryptPassword,
    verifyPassword: verifyScryptPassword,
    needsRehash: () => false
  })
)
