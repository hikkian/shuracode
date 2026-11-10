import test from "node:test"
import assert from "node:assert/strict"
import { applyThinkingDefault, DEFAULT_DONE_KEY, THINKING_KEY } from "../plugin/thinking-default.ts"

function memoryKv(initial = {}) {
  const store = new Map(Object.entries(initial))
  return {
    store,
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    set: (key, value) => store.set(key, value),
  }
}

test("first run with no choice made: thinking is shown and the default is marked done", () => {
  const kv = memoryKv()
  assert.equal(applyThinkingDefault(kv), true)
  assert.equal(kv.store.get(THINKING_KEY), "show")
  assert.equal(kv.store.get(DEFAULT_DONE_KEY), true)
})

test("a mode the user already chose (hide) is never overridden", () => {
  const kv = memoryKv({ [THINKING_KEY]: "hide" })
  assert.equal(applyThinkingDefault(kv), false)
  assert.equal(kv.store.get(THINKING_KEY), "hide")
  assert.equal(kv.store.get(DEFAULT_DONE_KEY), true)
})

test("after the first run a later choice of the toggle is kept", () => {
  const kv = memoryKv()
  applyThinkingDefault(kv)
  kv.set(THINKING_KEY, "hide")
  assert.equal(applyThinkingDefault(kv), false)
  assert.equal(kv.store.get(THINKING_KEY), "hide")
})
