// The session header is a stable uuid per engine session, valid for the gateway, and reveals nothing about the session id.
import { test } from "node:test"
import assert from "node:assert/strict"
import { sessionHeader } from "../plugin/session-header.ts"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/

test("stable for one engine session and different across sessions", () => {
  const a = sessionHeader("ses_abc123")
  assert.match(a, UUID)
  assert.equal(sessionHeader("ses_abc123"), a)
  assert.notEqual(sessionHeader("ses_other"), a)
})

test("reveals nothing of the engine session id", () => {
  const a = sessionHeader("ses_abc123")
  assert.equal(a.includes("abc123"), false)
  assert.equal(a.includes("ses"), false)
})
