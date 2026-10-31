import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import completionGate from "../plugin/reliability/completion-gate.ts"
import softEdit from "../plugin/reliability/soft-edit.ts"
import loopDetector from "../plugin/reliability/loop-detector.ts"
import taskCard from "../plugin/reliability/task-card.ts"
import interruptRetry from "../plugin/reliability/interrupt-retry.ts"

function fakeInput(overrides = {}) {
  const prompts = []
  const input = {
    directory: "/tmp/project",
    worktree: "/tmp/project",
    client: {
      session: { promptAsync: async (request) => { prompts.push(request); return { data: {} } } },
      file: { read: async () => ({ data: { content: "" } }) },
    },
    ...overrides,
  }
  return { input, prompts }
}

const chat = (text) => [{ sessionID: "s1" }, { message: {}, parts: [{ type: "text", text }] }]
const idle = { event: { type: "session.idle", properties: { sessionID: "s1" } } }

test("completion gate stays off unless its own config flag is true", async () => {
  const { input, prompts } = fakeInput()
  const hooks = await completionGate.server(input, { completionGate: false })
  await hooks["chat.message"](...chat("change a file"))
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "edit", args: {} }, { output: "ok", metadata: {} })
  await hooks.event(idle)
  assert.equal(prompts.length, 0)
})

test("task card tool is opt-in and updates its session state", async () => {
  const { input } = fakeInput()
  const disabled = await taskCard.server(input, { taskCard: false })
  assert.equal(disabled.tool, undefined)
  const enabled = await taskCard.server(input, { taskCard: true })
  assert.equal(typeof enabled.tool.shura_task_card.execute, "function")
  await enabled.tool.shura_task_card.execute({ goal: "Build parser", plan: ["Inspect", "Implement"], done: ["Inspect"], next: "Implement" }, { sessionID: "s1" })
  const system = { system: [] }
  await enabled["experimental.chat.system.transform"]({ sessionID: "s1" }, system)
  assert.match(system.system[0], /Goal: Build parser/)
  assert.match(system.system[0], /2\. Implement/)
})

test("repository config template keeps all reliability flags off by default", async () => {
  const config = JSON.parse(await readFile(new URL("../config/shuracode.json.in", import.meta.url), "utf8"))
  const defaults = Object.fromEntries(config.plugin.filter(Array.isArray).map(([path, options]) => [path.split("/").at(-1), options]))
  assert.equal(defaults["completion-gate.ts"].completionGate, false)
  assert.equal(defaults["soft-edit.ts"].softEdit, false)
  assert.equal(defaults["loop-detector.ts"].loopDetector, false)
  assert.equal(defaults["task-card.ts"].taskCard, false)
  assert.equal(defaults["interrupt-retry.ts"].interruptRetry, false)
})

test("completion gate nudges only edited, unverified work and caps at two", async () => {
  const { input, prompts } = fakeInput()
  const hooks = await completionGate.server(input, { completionGate: true })
  await hooks["chat.message"](...chat("Implement a parser"))
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "edit", args: {} }, { output: "Edit applied", metadata: {} })
  await hooks.event(idle)
  await hooks.event(idle)
  await hooks.event(idle)
  assert.equal(prompts.length, 2)
  assert.match(prompts[0].body.parts[0].text, /run the most relevant verification/i)
  assert.match(prompts[1].body.parts[0].text, /2\/2/)
})

test("successful test command satisfies the completion gate", async () => {
  const { input, prompts } = fakeInput()
  const hooks = await completionGate.server(input, { completionGate: true })
  await hooks["chat.message"](...chat("Fix the module"))
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "edit", args: {} }, { output: "Edit applied", metadata: {} })
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "bash", args: { command: "pytest -q" } },
    { output: "3 passed", metadata: { exit: 0 } })
  await hooks.event(idle)
  assert.equal(prompts.length, 0)
})

test("soft edit accepts one whitespace-normalized block, refuses ambiguous and distant matches", async () => {
  const { input } = fakeInput()
  input.client.file.read = async () => ({ data: { content: "def f():\n    return 1\n" } })
  const hooks = await softEdit.server(input, { softEdit: true })
  const args = { filePath: "/tmp/project/a.py", oldString: "def f():\n return   1", newString: "def f():\n    return 2" }
  await hooks["tool.execute.before"]({ sessionID: "s1", tool: "edit", callID: "1" }, { args })
  assert.equal(args.oldString, "def f():\n    return 1")

  input.client.file.read = async () => ({ data: { content: "function f() {\n  return 1\n}\n\nfunction f() {\n  return 1\n}\n" } })
  await assert.rejects(hooks["tool.execute.before"]({ sessionID: "s1", tool: "edit", callID: "2" }, {
    args: { filePath: "/tmp/project/a.py", oldString: "function f() {\n    return 1\n }", newString: "changed" },
  }), /more than one place/)
  input.client.file.read = async () => ({ data: { content: "def other():\n    totally different\n" } })
  await assert.rejects(hooks["tool.execute.before"]({ sessionID: "s1", tool: "edit", callID: "3" }, {
    args: { filePath: "/tmp/project/a.py", oldString: "def expected():\n    return a very long value", newString: "changed" },
  }), /Closest fragment/)
})

test("loop detector warns after the third consecutive identical call", async () => {
  const { input } = fakeInput()
  const hooks = await loopDetector.server(input, { loopDetector: true })
  let output
  for (let i = 1; i <= 3; i++) {
    await hooks["tool.execute.before"]({ sessionID: "s1", tool: "bash", callID: String(i) }, { args: { command: "pytest -q" } })
    output = { output: "same failure", metadata: { output: "same failure" } }
    await hooks["tool.execute.after"]({ sessionID: "s1", tool: "bash", callID: String(i), args: { command: "pytest -q" } }, output)
  }
  assert.match(output.output, /loop detector/)
  assert.match(output.metadata.output, /different approach/)
  const system = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, system)
  assert.match(system.system[0], /repeated 3 times/)
})

test("task card is reinjected, compaction keeps its template, and large output becomes a file link", async () => {
  const root = await mkdtemp(path.join("/dev/shm", "shura-card-"))
  try {
    const { input } = fakeInput({ directory: root, worktree: root })
    const hooks = await taskCard.server(input, { taskCard: true })
    await hooks["chat.message"]({ sessionID: "s1" }, { message: {}, parts: [{ type: "text", text: "Build a parser" }] })
    await hooks.event({ event: { type: "todo.updated", properties: { sessionID: "s1", todos: [
      { id: "1", content: "Write parser", status: "completed" },
      { id: "2", content: "Add edge cases", status: "in_progress" },
    ] } } })
    const system = { system: [] }
    await hooks["experimental.chat.system.transform"]({ sessionID: "s1" }, system)
    assert.match(system.system[0], /Goal: Build a parser/)
    assert.match(system.system[0], /Write parser/)
    const compact = { context: [] }
    await hooks["experimental.session.compacting"]({ sessionID: "s1" }, compact)
    assert.match(compact.context[0], /Preserve the current task card/)
    const output = { title: "tool", output: "x".repeat(80001), metadata: { output: "x".repeat(80001) } }
    await hooks["tool.execute.after"]({ sessionID: "s1", callID: "large-result", tool: "bash", args: {} }, output)
    assert.match(output.output, /\.shuracode\/tool-results/)
    assert.match(output.metadata.shuracodeLargeOutput.path, /large-result\.txt$/)
    const saved = await readFile(path.join(root, output.metadata.shuracodeLargeOutput.path), "utf8")
    assert.equal(saved.length, 80001)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

const interrupted = { event: { type: "session.error", properties: { sessionID: "s1", error: { name: "UnknownError", data: { message: JSON.stringify({ message: "llama-server stopped mid-response; the answer is incomplete.", type: "api_error", code: "SHURA_RESPONSE_INTERRUPTED" }) } } } } }

test("interrupt retry stays off unless its own config flag is true", async () => {
  const { input, prompts } = fakeInput()
  const hooks = await interruptRetry.server(input, { interruptRetry: false })
  await hooks.event(interrupted)
  assert.equal(prompts.length, 0)
})

test("interrupt retry asks the model to go on once per user message, and only for the gateway's cut-off code", async () => {
  const { input, prompts } = fakeInput()
  const hooks = await interruptRetry.server(input, { interruptRetry: true, interruptRetrySettleMs: 0 })
  await hooks["chat.message"](...chat("Read the file and explain add"))
  await hooks.event({ event: { type: "session.error", properties: { sessionID: "s1", error: { name: "UnknownError", data: { message: "Rate limit exceeded" } } } } })
  assert.equal(prompts.length, 0, "an error without the gateway code is not retried")
  await hooks.event(interrupted)
  assert.equal(prompts.length, 0, "the retry waits for the session to go idle")
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].body.parts[0].text, /^\[Shura retry\]/)
  // the retry's own message is not a new user message: a second cut in the same answer is left to the user
  await hooks["chat.message"](...chat("[Shura retry] The previous answer was cut off by a server failure."))
  await hooks.event(interrupted)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  assert.equal(prompts.length, 1)
  // a new user message gets its own retry
  await hooks["chat.message"](...chat("Now change the function"))
  await hooks.event(interrupted)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  assert.equal(prompts.length, 2)
})
