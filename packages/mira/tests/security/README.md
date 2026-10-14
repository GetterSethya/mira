# Security regression tests

These tests run against the **real** production code paths — `makeCollectionRouter` → `CollectionService` →
`Repository` → SQLite, plus the real on-disk `FileStorage` where relevant — and guard against regressions in
previously-fixed security issues.

The whole suite is expected to be **green**. A failure means a regression in hardened behaviour, so fix the
server code rather than relaxing the assertion.

```powershell
cd C:\ProjectCode\mira\packages\mira
npx vitest run tests/security --reporter=verbose
npx tsc --noEmit                                   # must stay clean (exit 0)
```

## Files

| File | Purpose |
|---|---|
| `_harness.ts` | Shared harness (collections, layers, seeds, HTTP helpers). Not a test. |
| `smoke.test.ts` | Harness health check. |
| `auth-token-scope.test.ts` | JWT / file-token scoping, privileged endpoints. |
| `file-handling.test.ts` | Upload, storage, serving, path traversal, stored XSS. |
| `rule-bypass.test.ts` | Rule enforcement, relation `expand`, hidden fields. |
| `injection.test.ts` | SQL injection, mass assignment, auth logic. |
| `fuzz-http.test.ts` | HTTP robustness fuzzing / error-leak checks. |
| `cache-probe.test.ts` | Cached collection service + cache-key scoping. |

`.tmp/` holds scratch files created by the file-handling and fuzz suites.
