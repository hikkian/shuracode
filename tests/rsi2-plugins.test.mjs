// RSI2E: the mechanism plugins are off unless their flag is true; on, each announces itself in the system text (delivery proof), does its
// one thing, and writes an event line under <project>/.harness/events/<name>.jsonl (proof that it fired).
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import requirementsLock from "../plugin/rsi2/requirements-lock.ts"
import taskState from "../plugin/rsi2/task-state.ts"
import compactPreserve from "../plugin/rsi2/compact-preserve.ts"
import doneGate from "../plugin/rsi2/done-gate.ts"
import actionForcing from "../plugin/rsi2/action-forcing.ts"

async function project() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rsi2-"))
  const prompts = []
  const input = { directory: dir, worktree: dir, client: { session: { promptAsync: async (r) => { prompts.push(r); return { data: {} } } } } }
  return { dir, input, prompts }
}
const events = async (dir, name) => (await readFile(path.join(dir, ".harness", "events", `${name}.jsonl`), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(l => JSON.parse(l))
const chat = (text) => [{ sessionID: "s1" }, { message: {}, parts: [{ type: "text", text }] }]

test("every mechanism is off without its flag", async () => {
  const { input } = await project()
  for (const p of [requirementsLock, taskState, compactPreserve, doneGate, actionForcing]) {
    const hooks = await p.server(input, {})
    assert.deepEqual(Object.keys(hooks), [], p.id)
  }
})

test("requirements-lock writes the first user message verbatim, announces itself and refuses edits of the file", async () => {
  const { dir, input } = await project()
  const hooks = await requirementsLock.server(input, { requirementsLock: true })
  const sys = { system: [] }
  await hooks["experimental.chat.system.transform"]({ model: { id: "tiel-coder" } }, sys)
  assert.ok(sys.system.includes("shuracode-rsi2:requirements-lock: on"))
  await hooks["chat.message"](...chat("[Shura nudge] not the task"))
  await hooks["chat.message"](...chat("Implement parse(x): raise ValueError('bad') on None."))
  const text = await readFile(path.join(dir, "REQUIREMENTS.md"), "utf8")
  assert.ok(text.includes("raise ValueError('bad') on None"))
  await hooks["chat.message"](...chat("a later message must not overwrite"))
  assert.equal(await readFile(path.join(dir, "REQUIREMENTS.md"), "utf8"), text)
  await assert.rejects(hooks["tool.execute.before"]({ sessionID: "s1", tool: "edit" }, { args: { filePath: path.join(dir, "REQUIREMENTS.md") } }))
  await hooks["tool.execute.before"]({ sessionID: "s1", tool: "edit" }, { args: { filePath: path.join(dir, "other.py") } })
  const ev = await events(dir, "requirements-lock")
  assert.deepEqual(ev.map(e => e.event), ["written", "refused-edit"])
  await rm(dir, { recursive: true, force: true })
})

test("task-state seeds the file once and counts the model's updates", async () => {
  const { dir, input } = await project()
  const hooks = await taskState.server(input, { taskState: true })
  await hooks["chat.message"](...chat("task"))
  assert.ok((await readFile(path.join(dir, "TASK_STATE.md"), "utf8")).includes("# Acceptance criteria"))
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "edit", args: { filePath: path.join(dir, "TASK_STATE.md") } }, {})
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "edit", args: { filePath: path.join(dir, "a.py") } }, {})
  assert.deepEqual((await events(dir, "task-state")).map(e => e.event), ["seeded", "updated"])
  await rm(dir, { recursive: true, force: true })
})

test("compact-preserve appends the contract verbatim to the compaction context and re-injects it after", async () => {
  const { dir, input } = await project()
  await writeFile(path.join(dir, "REQUIREMENTS.md"), "R1 exact: raise KeyError('missing')\n")
  await writeFile(path.join(dir, "TASK_STATE.md"), "# Next action\nrun tests\n")
  const hooks = await compactPreserve.server(input, { compactPreserve: true })
  const before = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, before)
  assert.equal(before.system.filter(s => s.includes("KeyError")).length, 0, "nothing re-injected before a compaction")
  const out = { context: [] }
  await hooks["experimental.session.compacting"]({ sessionID: "s1" }, out)
  assert.ok(out.context.some(c => c.includes("raise KeyError('missing')")))
  const after = { system: [] }
  await hooks["experimental.chat.system.transform"]({ sessionID: "s1", model: {} }, after)
  assert.ok(after.system.some(s => s.includes("raise KeyError('missing')")))
  assert.ok(after.system.some(s => s.includes("run tests")))
  assert.deepEqual((await events(dir, "compact-preserve")).map(e => e.event), ["compacting"])
  await rm(dir, { recursive: true, force: true })
})

test("done-gate nudges only when an edit came after the last test run, at most N times", async () => {
  const { dir, input, prompts } = await project()
  const hooks = await doneGate.server(input, { doneGate: true, doneGateNudges: 1 })
  const idle = { event: { type: "session.idle", properties: { sessionID: "s1" } } }
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "edit", args: {} })
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "bash", args: { command: "python3 -m pytest -q" } })
  await hooks.event(idle)
  assert.equal(prompts.length, 0, "a test after the last edit: no nudge")
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "write", args: {} })
  await hooks.event(idle)
  assert.equal(prompts.length, 1)
  assert.match(prompts[0].body.parts[0].text, /done gate/)
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "write", args: {} })
  await hooks.event(idle)
  assert.equal(prompts.length, 1, "the nudge budget is spent")
  assert.deepEqual((await events(dir, "done-gate")).map(e => e.event), ["nudge"])
  await rm(dir, { recursive: true, force: true })
})

test("action-forcing caps the output tokens of a step and says so once per session", async () => {
  const { dir, input } = await project()
  const hooks = await actionForcing.server(input, { actionForcing: true, actionForcingMaxOutput: 4096 })
  const sys = { system: [] }
  await hooks["experimental.chat.system.transform"]({ model: {} }, sys)
  assert.ok(sys.system.some(s => s.includes("4096")))
  const params = { maxOutputTokens: 16384, options: {} }
  await hooks["chat.params"]({ sessionID: "s1" }, params)
  assert.equal(params.maxOutputTokens, 4096)
  const small = { maxOutputTokens: 1024, options: {} }
  await hooks["chat.params"]({ sessionID: "s1" }, small)
  assert.equal(small.maxOutputTokens, 1024, "a smaller limit is kept")
  assert.deepEqual((await events(dir, "action-forcing")).map(e => e.event), ["cap"])
  await rm(dir, { recursive: true, force: true })
})
