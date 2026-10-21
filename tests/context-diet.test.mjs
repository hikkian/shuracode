// MASK1: the context diet masks old tool outputs past a threshold, keeps the masking for the session, and never changes stored parts.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applyMasks, newMasks, optionsFrom, stubFor } from "../plugin/lib/context-diet.ts"
import plugin from "../plugin/context-diet.ts"

const SID = "ses_test_1"

function tool(id, outputLen) {
  return {
    id,
    type: "tool",
    callID: `call_${id}`,
    tool: "read",
    state: { status: "completed", input: { filePath: `f${id}.txt` }, output: "x".repeat(outputLen), title: "read", metadata: {}, time: { start: 1, end: 2 } },
  }
}

function message(n, parts) {
  return { info: { id: `msg_${n}`, sessionID: SID, role: n % 2 ? "user" : "assistant" }, parts }
}

// twenty tool calls: t0 is short (kept); t1..t19 are 8000 characters each. The last 8 are protected, t1..t11 (88k) are removable.
function bigDialogue() {
  const parts = [tool("t0", 100)]
  for (let i = 1; i < 20; i++) parts.push(tool(`t${i}`, 8000))
  return [message(1, [{ id: "p_user", type: "text", text: "read the files" }]), message(2, parts)]
}

async function withStateDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ctxdiet-"))
  const saved = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = dir
  try {
    await fn(dir)
  } finally {
    if (saved === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = saved
    await rm(dir, { recursive: true, force: true })
  }
}

async function hookFor(options) {
  const hooks = await plugin.server({}, options)
  return hooks["experimental.chat.messages.transform"]
}

test("off by default: the plugin adds no hook", async () => {
  assert.deepEqual(Object.keys(await plugin.server({}, {})), [])
  assert.deepEqual(Object.keys(await plugin.server({}, { contextDiet: false })), [])
})

test("options default to the card's values, and bad values fall back to them", () => {
  assert.deepEqual(optionsFrom({}), { maskStartChars: 60000, keepLastTools: 8, minChars: 300 })
  assert.deepEqual(optionsFrom({ keepLastTools: 3.7, maskStartChars: "x" }), { maskStartChars: 60000, keepLastTools: 3, minChars: 300 })
})

test("under the threshold nothing is masked and the messages are left as they are", async () => {
  await withStateDir(async () => {
    const messages = [message(1, [{ id: "p", type: "text", text: "hi" }]), message(2, [tool("a", 1000), tool("b", 1000)])]
    const before = JSON.stringify(messages)
    const hook = await hookFor({ contextDiet: true })
    await hook({}, { messages })
    assert.equal(JSON.stringify(messages), before)
  })
})

test("past the threshold the old long outputs are masked as one batch; the last 8 tool calls and the short ones are not", () => {
  const masks = newMasks(bigDialogue(), new Set(), optionsFrom({}))
  assert.deepEqual(masks, ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"])
})

test("a protected window that is over the threshold by itself does not cause masking on every turn", () => {
  // eight recent outputs of 9000 (72k, all protected) and one old output of 500: nothing removable is big enough
  const parts = [tool("old", 500)]
  for (let i = 0; i < 8; i++) parts.push(tool(`r${i}`, 9000))
  assert.deepEqual(newMasks([message(2, parts)], new Set(), optionsFrom({})), [])
})

test("the masked output is the stub with the original size; the stored parts keep their full output", () => {
  const messages = bigDialogue()
  const applied = applyMasks(messages, new Set(["t1"]))
  const masked = applied[1].parts.find((p) => p.id === "t1")
  assert.equal(masked.state.output, stubFor(8000))
  assert.equal(masked.state.input.filePath, "ft1.txt")
  assert.equal(messages[1].parts.find((p) => p.id === "t1").state.output.length, 8000)
  assert.equal(applied[1].parts.find((p) => p.id === "t2").state.output.length, 8000)
})

test("masking is batched and sticky: after the first masking, the same request prefix comes back on the next turn", async () => {
  await withStateDir(async () => {
    const hook = await hookFor({ contextDiet: true })
    const first = { messages: bigDialogue() }
    await hook({}, first)
    const afterFirst = JSON.stringify(first.messages)
    assert.ok(first.messages[1].parts.find((p) => p.id === "t1").state.output.startsWith("[tool output elided"))

    // the engine sends the stored messages again next turn, plus a small addition
    const next = { messages: [...bigDialogue(), message(3, [{ id: "p_small", type: "text", text: "ok" }])] }
    await hook({}, next)
    assert.equal(JSON.stringify(next.messages.slice(0, 2)), afterFirst)
    assert.equal(next.messages[1].parts.find((p) => p.id === "t3").state.output.startsWith("[tool output elided"), true)
  })
})

test("outputs already masked are not returned again", async () => {
  await withStateDir(async () => {
    const hook = await hookFor({ contextDiet: true })
    const first = { messages: bigDialogue() }
    await hook({}, first)
    const masked = new Set(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"])
    const again = bigDialogue()
    again.push(message(3, [{ id: "p_small", type: "text", text: "ok" }]))
    assert.deepEqual(newMasks(again, masked, optionsFrom({})), [])
  })
})

test("the state file is written when the set changes only, and a restart keeps the masking", async () => {
  await withStateDir(async (dir) => {
    const hook = await hookFor({ contextDiet: true })
    await hook({}, { messages: bigDialogue() })
    const file = path.join(dir, "shuracode", "context-diet", `${SID}.json`)
    const written = await stat(file)
    await new Promise((r) => setTimeout(r, 20))
    await hook({}, { messages: bigDialogue() })
    assert.equal((await stat(file)).mtimeMs, written.mtimeMs, "no new masks, so no write")

    // a new engine process: the set comes back from the file, and a short dialogue is masked the same way
    const restarted = await hookFor({ contextDiet: true })
    const short = { messages: [message(1, [tool("t1", 8000)]), message(2, [tool("t20", 50)])] }
    await restarted({}, short)
    assert.equal(short.messages[0].parts[0].state.output, stubFor(8000))
    assert.equal(short.messages[1].parts[0].state.output.length, 50)
  })
})

