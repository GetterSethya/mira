import assert from "node:assert/strict"
import { test } from "node:test"

import { summarizeHeapProfile } from "../src/analyze-heapprofile.ts"

test("sums selfSize and groups by call frame", () => {
  const summary = summarizeHeapProfile({
    head: {
      callFrame: { functionName: "root", url: "root.js", lineNumber: 1 },
      selfSize: 100,
      children: [
        {
          callFrame: { functionName: "child", url: "child.js", lineNumber: 2 },
          selfSize: 50
        },
        {
          callFrame: { functionName: "root", url: "root.js", lineNumber: 1 },
          selfSize: 25
        }
      ]
    }
  })

  assert.equal(summary.totalBytes, 175)
  assert.deepEqual(summary.byFunction, [
    { key: "root @ root.js:1", bytes: 125 },
    { key: "child @ child.js:2", bytes: 50 }
  ])
})

test("empty or zero-size profiles report zero", () => {
  assert.deepEqual(summarizeHeapProfile({}), { totalBytes: 0, byFunction: [] })
  assert.deepEqual(summarizeHeapProfile({ head: { selfSize: 0 } }), {
    totalBytes: 0,
    byFunction: []
  })
})

test("unknown call frames use stable labels", () => {
  const summary = summarizeHeapProfile({ head: { selfSize: 8 } })
  assert.deepEqual(summary.byFunction, [{ key: "(anonymous) @ (unknown):0", bytes: 8 }])
})
