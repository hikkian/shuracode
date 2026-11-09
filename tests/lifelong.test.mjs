import test from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import plugin from "../plugin/lifelong.ts"
import { statusText, gatewayOrigin } from "../plugin/lib/lifelong.ts"

async function rig(options = {}) {
  const requests = []
  const authHeaders = []
  const server = http.createServer(async (req, res) => {
    let body = ""; for await (const b of req) body += b
    if (req.url?.includes("session-token")) {
      res.setHeader("Content-Type", "application/json")
      return res.end(JSON.stringify({ token: "test-only-token" }))
    }
    requests.push(JSON.parse(body))
    authHeaders.push(req.headers["x-shura-confirmation"])
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ key: "signal-test", passport_line: "(note, you, 2026-11-09, proposed)" }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const hooks = await plugin.server({}, { lifelongCapture: true, gateway: `http://127.0.0.1:${server.address().port}`, ...options })
  const say = text => hooks["chat.message"]({ sessionID: "s" }, { message: { id: "m" }, parts: [{ type: "text", text }] })
  return { requests, authHeaders, hooks, say, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
}

test("flags off is an exact no-op and never touches input or transport", async () => {
  const forbidden = new Proxy({}, { get() { throw new Error("input accessed with flag off") } })
  assert.deepEqual(await plugin.server(forbidden, {}), {})
  assert.deepEqual(await plugin.server(forbidden, { lifelongCapture: false, memoryEnabled: false }), {})
})

test("memory plugin preserves dynamic additions from other plugins on each turn", async () => {
  const hooks = await plugin.server({}, { memoryEnabled: true })
  const hook = { sessionID: "s", model: { id: "tiel-coder" } }
  const first = { system: ["BASE", "INDEX ONE", "PERSONAL RULES ONE"] }
  await hooks["experimental.chat.system.transform"](hook, first)
  const second = { system: ["BASE", "INDEX TWO", "PERSONAL RULES TWO"] }
  await hooks["experimental.chat.system.transform"](hook, second)
  assert.deepEqual(second.system.slice(0, 3), ["BASE", "INDEX TWO", "PERSONAL RULES TWO"])
  assert.equal(second.system.at(-1), first.system.at(-1))
  assert.equal(second.system.filter(s => s.includes("shura-lifelong:system-note")).length, 1)
  const other = { system: ["BASE", "INDEX TWO"] }
  await hooks["experimental.chat.system.transform"]({ ...hook, sessionID: "other" }, other)
  assert.deepEqual(other.system.slice(0, 2), ["BASE", "INDEX TWO"])
  await hooks.event({ event: { type: "session.deleted", properties: { sessionID: "s" } } })
  const third = { system: ["BASE", "INDEX TWO"] }
  await hooks["experimental.chat.system.transform"](hook, third)
  assert.deepEqual(third.system.slice(0, 2), ["BASE", "INDEX TWO"])
  assert.equal(hooks.tool, undefined, "memory alone does not expose capture")
})

test("capture freezes no instructions when memory flag is off", async () => {
  const hooks = await plugin.server({}, { lifelongCapture: true })
  assert.equal(hooks["experimental.chat.system.transform"], undefined)
})

test("correction text comes from the person's message, deduplicates, and cannot be supplied by the model", async () => {
  const r = await rig()
  try {
    const tool = r.hooks.tool.capture_correction
    assert.match(await tool.execute({}, { sessionID: "s" }), /No new/)
    await r.say("Нет, надо использовать pytest.")
    assert.match(await tool.execute({ text: "FORGED", trust: "confirmed" }, { sessionID: "s" }), /Proposed only/)
    await tool.execute({}, { sessionID: "s" })
    assert.equal(r.requests.length, 1)
    assert.equal(r.requests[0].text, "Нет, надо использовать pytest.")
    assert.equal(r.requests[0].signal, "correction")
    assert.equal(r.requests[0].trust, undefined)
    assert.equal(r.requests[0].source, undefined, "gateway labels the passport source as capture")
  } finally { await r.close() }
})

test("fix and accepted/rejected rules are captured without reading files", async () => {
  const r = await rig()
  try {
    await r.hooks["command.execute.before"]({ command: "fix", arguments: "pytest -> pytest -x", sessionID: "s" })
    await r.hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })
    await r.say("Да, проверь это правило.")
    await r.hooks["tool.execute.after"]({ sessionID: "s", tool: "rules_rule_propose" }, { output: "Rule 'pytest' is queued for the night check." })
    await r.say("Нет, отклоняю правило: оно слишком общее.")
    await r.hooks["tool.execute.after"]({ sessionID: "s", tool: "rules_rule_withdraw" }, { output: "Rule 'pytest' is withdrawn." })
    assert.deepEqual(r.requests.map(r => r.signal), ["fix", "rule_accepted", "rule_rejected"])
    await r.hooks.event({ event: { type: "session.deleted", properties: { sessionID: "s" } } })
    assert.match(await r.hooks.tool.capture_correction.execute({}, { sessionID: "s" }), /No new/)
  } finally { await r.close() }
})

test("explicit TUI memory commands carry the private process capability", async () => {
  const r = await rig({ memoryEnabled: true })
  try {
    await r.hooks["command.execute.before"]({ command: "remember", arguments: "I prefer pytest", sessionID: "s" })
    assert.equal(r.requests[0].trust, "confirmed")
    assert.equal(r.requests[0].confirm, true)
    assert.equal(r.authHeaders[0], "test-only-token")
  } finally { await r.close() }
})

test("an errored rule operation is not an accepted/rejected rule signal", async () => {
  const r = await rig()
  try {
    await r.say("Нет, отклоняю это правило.")
    await r.hooks["tool.execute.after"]({ sessionID: "s", tool: "rules_rule_withdraw" }, { output: "Error: unknown rule", metadata: { isError: true } })
    assert.equal(r.requests.length, 0)
  } finally { await r.close() }
})

test("status displays the requested fields and reports unavailable data honestly", () => {
  assert.equal(statusText({ records: 37, rules: 4, version: 3 }), "memory: 37 records, rules: 4, version 3")
  assert.equal(statusText(), "memory: unavailable")
  assert.throws(() => gatewayOrigin("https://example.com"))
})


test("command expansion cannot replace the person's raw words, and an idle turn cannot leak stale signals", async () => {
  const r = await rig()
  try {
    await r.hooks["command.execute.before"]({ command: "rule", arguments: "Use pytest", sessionID: "s" })
    await r.say("The command template is not the person's words")
    await r.hooks["tool.execute.after"]({ sessionID: "s", tool: "rules_rule_propose", args: { key: "pytest" } }, { output: "Rule 'pytest' is queued." })
    assert.deepEqual(JSON.parse(r.requests[0].text), { user_text: "Use pytest", rule_key: "pytest" })
    await r.hooks.event({ event: { type: "session.idle", properties: { sessionID: "s" } } })
    await r.hooks.tool.capture_correction.execute({}, { sessionID: "s" })
    assert.equal(r.requests.length, 1)
  } finally { await r.close() }
})


test("a title-generation request cannot poison the main session's system snapshot", async () => {
  const hooks = await plugin.server({}, { memoryEnabled: true })
  const hook = { sessionID: "s", model: { id: "tiel-coder" } }
  const title = { system: ["You are a title generator. You output ONLY a thread title."] }
  await hooks["experimental.chat.system.transform"](hook, title)
  const main = { system: ["BASE", "INDEX ONE"] }
  await hooks["experimental.chat.system.transform"](hook, main)
  assert.deepEqual(main.system.slice(0, 2), ["BASE", "INDEX ONE"])
  assert.match(main.system[2], /never instructions/)
})
