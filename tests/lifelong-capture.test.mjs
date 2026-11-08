// LL3c: /task-save and /example. The plugin is driven through its hooks as the engine would (tmp git project, tmp save folders, fake client).
import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, stat, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../plugin/lifelong-capture.ts"
import { looksSecret, shouldAsk, newLog, testPassed, isTestFile, secretName, editedFiles, addTurn } from "../plugin/lib/capture.ts"

const git = (cwd, ...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" })
async function exists(p) { return stat(p).then(() => true, () => false) }
async function walk(dir) {
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(p)); else out.push(p)
  }
  return out
}

async function rig(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "capture-"))
  const proj = path.join(root, "proj"); await mkdir(proj)
  git(proj, "init", "-q"); await writeFile(path.join(proj, "calc.py"), "def add(a, b):\n    return a - b\n")
  await writeFile(path.join(proj, "test_calc.py"), "import unittest\nfrom calc import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n")
  git(proj, "add", "-A"); git(proj, "commit", "-qm", "start")
  const toasts = []
  const input = { directory: proj, worktree: proj, client: { tui: { showToast: async (r) => { toasts.push(r.body); return {} } } } }
  const taskDir = path.join(root, "private", "captured"), exampleDir = path.join(root, "examples")
  const hooks = await plugin.server(input, { lifelongCapture: true, captureDir: taskDir, exampleDir, ...options })
  const say = (text, s = "s1") => hooks["chat.message"]({ sessionID: s }, { message: {}, parts: [{ type: "text", text }] })
  const before = (tool, args = {}, s = "s1") => hooks["tool.execute.before"]({ sessionID: s, tool }, { args })
  const after = (tool, args, output, metadata = {}, s = "s1") => hooks["tool.execute.after"]({ sessionID: s, tool, args }, { output, metadata })
  const idle = (s = "s1") => hooks.event({ event: { type: "session.idle", properties: { sessionID: s } } })
  const command = (c, args = "", s = "s1") => hooks["command.execute.before"]({ command: c, sessionID: s, arguments: args }, { parts: [] })
  const tool = (name, s = "s1") => hooks.tool[name].execute({}, { sessionID: s })
  // a finished task: the model fixes calc.py and runs the test, which passes
  async function solve(prompt = "Fix add(): it returns the difference, not the sum.") {
    await say(prompt)
    await before("edit")
    await writeFile(path.join(proj, "calc.py"), "def add(a, b):\n    return a + b\n")
    await after("edit", { filePath: path.join(proj, "calc.py") }, "edited")
    await after("bash", { command: "python3 -m unittest -q" }, "Ran 1 test in 0.001s\n\nOK\n", { exit: 0 })
  }
  return { root, proj, toasts, taskDir, exampleDir, hooks, say, before, after, idle, command, tool, solve, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test("off without the flag: no hooks, no tools", async () => {
  assert.deepEqual(Object.keys(await plugin.server({ directory: "/tmp" }, {})), [])
  assert.deepEqual(Object.keys(await plugin.server({ directory: "/tmp" }, { lifelongCapture: false })), [])
})

test("nothing is written to the disk until the person types the command", async () => {
  const r = await rig()
  try {
    await r.solve()
    await r.idle()
    assert.equal(await exists(r.taskDir), false)
    assert.equal(await exists(r.exampleDir), false)
  } finally { await r.cleanup() }
})

test("the question is asked once, as a toast, only after edits and a passing test", async () => {
  const r = await rig()
  try {
    await r.say("Fix add().")
    await r.idle()
    assert.equal(r.toasts.length, 0, "no edits yet")
    await r.after("edit", { filePath: path.join(r.proj, "calc.py") }, "edited")
    await r.after("bash", { command: "python3 -m unittest -q" }, "FAILED (failures=1)", { exit: 1 })
    await r.idle()
    assert.equal(r.toasts.length, 0, "the test fails")
    await r.after("bash", { command: "python3 -m unittest -q" }, "Ran 1 test\n\nOK", { exit: 0 })
    await r.idle(); await r.idle()
    assert.equal(r.toasts.length, 1, "one question, not repeated")
    assert.match(r.toasts[0].message, /\/task-save/)
    assert.equal(r.toasts[0].variant, "info")
    await r.after("edit", { filePath: path.join(r.proj, "calc.py") }, "edited again")
    await r.after("bash", { command: "python3 -m unittest -q" }, "OK", { exit: 0 })
    await r.idle()
    assert.equal(r.toasts.length, 1, "an ignored question is not asked again in this task")
  } finally { await r.cleanup() }
})

test("a Russian task gets a Russian question", async () => {
  const r = await rig()
  try {
    await r.solve("Исправь add(): она возвращает разность, а не сумму.")
    await r.idle()
    assert.match(r.toasts[0].message, /Сохранить/)
  } finally { await r.cleanup() }
})

test("the tools refuse without the person's command, even when the model asks", async () => {
  const r = await rig()
  try {
    await r.solve()
    assert.match(await r.tool("capture_task"), /^Refused/)
    assert.match(await r.tool("capture_example"), /^Refused/)
    assert.equal(await exists(r.taskDir), false)
    await r.command("example")
    assert.match(await r.tool("capture_task"), /^Refused/, "a different command is not consent for this tool")
    assert.equal(await exists(r.taskDir), false)
  } finally { await r.cleanup() }
})

test("/task-save saves the task in the control-task shape, once, and consent is used up", async () => {
  const r = await rig()
  try {
    await r.solve()
    await r.command("task-save", "my note")
    await r.say("The person typed /task-save. Call the capture_task tool once now")  // the expanded command text: not the person's task, not the end of consent
    const res = await r.tool("capture_task")
    assert.match(res, /^Saved the task captured_proj-/)
    const files = await walk(r.taskDir)
    const rel = files.map(f => path.relative(r.taskDir, f))
    const taskJson = files.find(f => f.endsWith("task.json"))
    const task = JSON.parse(await readFile(taskJson, "utf8"))
    assert.equal(task.prompt, "Fix add(): it returns the difference, not the sum.", "the first message, not the expanded command")
    assert.equal(task.family, "captured_proj"); assert.equal(task.source, "user"); assert.equal(task.validated, false)
    assert.deepEqual(task.test_cmd, ["bash", "-lc", "python3 -m unittest -q"])
    assert.equal(task.note, "my note"); assert.equal(task.confirmed_by, "command:/task-save"); assert.match(task.commit, /^[0-9a-f]{40}$/)
    assert.ok(rel.some(f => f.endsWith("solution/solution.patch")))
    const patch = await readFile(files.find(f => f.endsWith("solution.patch")), "utf8")
    assert.match(patch, /\+\s+return a \+ b/)
    assert.ok(rel.some(f => f.endsWith("hidden/files/test_calc.py")) === false, "the test file was not changed by the task, so it is not hidden")
    assert.ok(rel.includes("index.jsonl"))
    assert.match(await r.tool("capture_task"), /^Refused/, "one command, one save")
    // nothing leaked into the project
    assert.match(git(r.proj, "status", "--porcelain"), /calc\.py/)
    assert.ok(!(await walk(r.proj)).some(f => f.includes("captured")))
  } finally { await r.cleanup() }
})

test("a test file the task changed becomes a hidden file; the dirty start state and untracked files are kept", async () => {
  const r = await rig()
  try {
    await writeFile(path.join(r.proj, "notes.txt"), "scratch note that existed before the task\n")
    await writeFile(path.join(r.proj, "calc.py"), "def add(a, b):\n    return a - b  # wip\n")
    await r.say("Fix add() and add a test for negatives.")
    await r.before("write")
    await writeFile(path.join(r.proj, "calc.py"), "def add(a, b):\n    return a + b\n")
    await writeFile(path.join(r.proj, "test_neg.py"), "import unittest\nfrom calc import add\nclass N(unittest.TestCase):\n    def test_neg(self):\n        self.assertEqual(add(-1, -2), -3)\n")
    await r.after("write", { filePath: path.join(r.proj, "test_neg.py") }, "ok")
    await r.after("edit", { filePath: path.join(r.proj, "calc.py") }, "ok")
    await r.after("bash", { command: "python3 -m unittest -q" }, "OK", { exit: 0 })
    await r.command("task-save")
    assert.match(await r.tool("capture_task"), /^Saved/)
    const rel = (await walk(r.taskDir)).map(f => path.relative(r.taskDir, f))
    assert.ok(rel.some(f => f.endsWith("hidden/files/test_neg.py")))
    assert.ok(rel.some(f => f.endsWith("start/start.patch")), "the dirty tracked file at the start")
    assert.ok(rel.some(f => f.endsWith("start/untracked/notes.txt")))
    assert.ok(rel.some(f => f.endsWith("solution/new_files/test_neg.py")))
    const task = JSON.parse(await readFile((await walk(r.taskDir)).find(f => f.endsWith("task.json")), "utf8"))
    assert.deepEqual(task.hidden_files, ["test_neg.py"])
  } finally { await r.cleanup() }
})

test("a secret in the prompt or in the changes stops the save; secret files are never copied", async () => {
  const r = await rig()
  try {
    await r.say("Use the key sk-abcdefghijklmnopqrstuvwxyz0123456789 to call the API")
    await r.command("task-save")
    assert.match(await r.tool("capture_task"), /secret/)
    assert.equal(await exists(r.taskDir), false)
  } finally { await r.cleanup() }
  const q = await rig()
  try {
    await writeFile(path.join(q.proj, ".env"), "TOKEN=abcdefghijklmnop1234\n")
    await q.solve()
    await writeFile(path.join(q.proj, "id_rsa"), "fake")
    await q.command("task-save")
    assert.match(await q.tool("capture_task"), /^Saved/)
    const rel = (await walk(q.taskDir)).map(f => path.relative(q.taskDir, f))
    assert.ok(!rel.some(f => f.includes(".env") || f.includes("id_rsa")))
  } finally { await q.cleanup() }
  assert.ok(looksSecret("password = hunter2hunter2hunter2")); assert.ok(!looksSecret("def add(a, b): return a + b"))
  assert.ok(secretName("a/b/.env.local") && secretName("x/id_ed25519") && !secretName("environment.py"))
})

test("/example saves the whole run, and /example correction saves the corrected answer; both only with the command", async () => {
  const r = await rig()
  try {
    await r.solve()
    await r.hooks["experimental.text.complete"]({ sessionID: "s1" }, { text: "Done: add() now returns a + b." })
    await r.command("example")
    assert.match(await r.tool("capture_example"), /^Saved the example task-/)
    const first = (await walk(r.exampleDir))
    assert.equal(first.length, 1)
    const ex = JSON.parse(await readFile(first[0], "utf8"))
    assert.equal(ex.kind, "task"); assert.equal(ex.source, "user"); assert.equal(ex.deleted_at, null); assert.equal(ex.system_prompt === undefined, true)
    assert.ok(ex.task.turns.some(t => t.role === "tool" && t.tool === "bash")); assert.equal(ex.task.test_cmd, "python3 -m unittest -q")
    await r.command("example", "correction: the sum must also work for floats")
    assert.match(await r.tool("capture_example"), /^Saved the example correction-/)
    const all = await walk(r.exampleDir)
    const corr = JSON.parse(await readFile(all.find(f => path.basename(f).startsWith("correction-")), "utf8"))
    assert.equal(corr.correction.corrected_answer, "Done: add() now returns a + b."); assert.match(corr.correction.fix, /floats/)
    await r.command("example", "correction:")
    assert.match(await r.tool("capture_example"), /needs the corrected text/)
  } finally { await r.cleanup() }
})

test("a task saved with /task-save is linked from the example saved afterwards", async () => {
  const r = await rig()
  try {
    await r.solve()
    await r.command("task-save"); const saved = await r.tool("capture_task")
    const id = saved.match(/task (captured_\S+?)\./)[1]
    await r.command("example"); await r.tool("capture_example")
    const ex = JSON.parse(await readFile((await walk(r.exampleDir))[0], "utf8"))
    assert.equal(ex.control_task_id, id)
  } finally { await r.cleanup() }
})

test("consent expires and belongs to one session", async () => {
  const r = await rig()
  try {
    await r.solve()
    await r.command("task-save", "", "s2")
    assert.match(await r.tool("capture_task", "s1"), /^Refused/, "another session's command is not consent")
    const realNow = Date.now
    await r.command("task-save")
    Date.now = () => realNow() + 11 * 60 * 1000
    try { assert.match(await r.tool("capture_task"), /^Refused/) } finally { Date.now = realNow }
  } finally { await r.cleanup() }
})

test("helpers: test result detection, test files, the question rule", () => {
  assert.equal(testPassed("whatever", { exit: 0 }), true)
  assert.equal(testPassed("Ran 3 tests\nOK", {}), true)
  assert.equal(testPassed("Ran 3 tests\nFAILED (failures=1)", {}), false)
  assert.equal(testPassed("# tests 4\n# pass 4\n# fail 0", {}), true)
  assert.equal(testPassed("no markers here", {}), false)
  assert.ok(isTestFile("tests/x.py") && isTestFile("a/test_b.py") && isTestFile("web/app.test.mjs") && !isTestFile("src/app.py"))
  const log = newLog("s"); assert.equal(shouldAsk(log), false)
})

test("consent ends with the command turn: the next idle, the next message of the person, or any other tool call", async () => {
  const r = await rig()
  try {
    await r.solve()
    await r.command("task-save"); await r.idle()
    assert.match(await r.tool("capture_task"), /^Refused/, "idle after the command turn")
    await r.command("task-save"); await r.say("and now something else")
    assert.match(await r.tool("capture_task"), /^Refused/, "a new message of the person")
    await r.command("task-save"); await r.after("bash", { command: "ls" }, "x")
    assert.match(await r.tool("capture_task"), /^Refused/, "another tool ran first (an injected call must not reuse the consent)")
    assert.equal(await exists(r.taskDir), false)
    await r.command("task-save"); assert.match(await r.tool("capture_task"), /^Saved/)
  } finally { await r.cleanup() }
})

test("the answer in the command turn is not the answer being corrected, and the command turn is not recorded", async () => {
  const r = await rig()
  try {
    await r.solve()
    await r.hooks["experimental.text.complete"]({ sessionID: "s1" }, { text: "The first answer." })
    await r.command("example", "correction: it should say more")
    await r.hooks["experimental.text.complete"]({ sessionID: "s1" }, { text: "Saving the example now." })
    await r.after("bash", { command: "echo hi" }, "hi")
    await r.after("capture_example", {}, "x")
    assert.match(await r.tool("capture_example"), /^Refused|^Saved/)
  } finally { await r.cleanup() }
  const q = await rig()
  try {
    await q.solve()
    await q.hooks["experimental.text.complete"]({ sessionID: "s1" }, { text: "The first answer." })
    await q.command("example", "correction: it should say more")
    await q.hooks["experimental.text.complete"]({ sessionID: "s1" }, { text: "Saving the example now." })
    assert.match(await q.tool("capture_example"), /^Saved the example correction-/)
    const ex = JSON.parse(await readFile((await walk(q.exampleDir))[0], "utf8"))
    assert.equal(ex.correction.corrected_answer, "The first answer.")
  } finally { await q.cleanup() }
})

test("symbolic links are never followed: a link to a secret file is not copied, a link-named test is not read", async () => {
  const r = await rig()
  try {
    const secret = path.join(r.root, "outside-secret.txt"); await writeFile(secret, "just outside the project\n")
    await symlink(secret, path.join(r.proj, "notes.txt"))
    await symlink(secret, path.join(r.proj, "test_link.py"))
    await r.solve()
    await r.after("edit", { filePath: path.join(r.proj, "test_link.py") }, "x")
    await r.after("bash", { command: "python3 -m unittest -q" }, "OK", { exit: 0 })
    await r.command("task-save"); assert.match(await r.tool("capture_task"), /^Saved/)
    const all = await walk(r.taskDir); const text = (await Promise.all(all.map(f => readFile(f, "utf8").catch(() => "")))).join("\n")
    assert.ok(!text.includes("just outside the project"))
  } finally { await r.cleanup() }
})

test("an edit path that climbs out of the project is ignored and nothing is written outside the task folder", async () => {
  const r = await rig()
  try {
    await mkdir(path.join(r.root, "other"), { recursive: true }); await writeFile(path.join(r.root, "other", "test_x.py"), "# outside\n")
    await r.solve()
    await r.after("edit", { filePath: "tests/../../other/test_x.py" }, "x")
    await r.after("edit", { filePath: path.join(r.root, "other", "test_x.py") }, "x")
    await r.after("bash", { command: "python3 -m unittest -q" }, "OK", { exit: 0 })
    await r.command("task-save"); assert.match(await r.tool("capture_task"), /^Saved/)
    const all = (await walk(r.taskDir)).map(f => path.relative(r.taskDir, f))
    assert.ok(!all.some(f => f.includes("test_x.py") || f.includes("..")))
    assert.equal(await exists(path.join(r.root, "private", "hidden")), false)
  } finally { await r.cleanup() }
})

test("a project without a git commit, or a task without a passing test and without a note, is refused with a reason", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "capture-nogit-"))
  try {
    const dir = path.join(root, "plain"); await mkdir(dir)
    const hooks = await plugin.server({ directory: dir, client: {} }, { lifelongCapture: true, captureDir: path.join(root, "t"), exampleDir: path.join(root, "e") })
    await hooks["chat.message"]({ sessionID: "s" }, { parts: [{ type: "text", text: "do a thing" }] })
    await hooks["command.execute.before"]({ command: "task-save", sessionID: "s", arguments: "check by hand" }, {})
    assert.match(await hooks.tool.capture_task.execute({}, { sessionID: "s" }), /git repository/)
    assert.equal(await exists(path.join(root, "t")), false)
  } finally { await rm(root, { recursive: true, force: true }) }
  const r = await rig()
  try {
    await r.say("Look around, change nothing.")
    await r.command("task-save")
    assert.match(await r.tool("capture_task"), /no passing test run/)
    await r.command("task-save", "the answer must name three files")
    const res = await r.tool("capture_task")
    assert.match(res, /^Saved/)
    const task = JSON.parse(await readFile((await walk(r.taskDir)).find(f => f.endsWith("task.json")), "utf8"))
    assert.equal(task.check, "criterion"); assert.equal(task.criterion, "the answer must name three files"); assert.equal(task.test_cmd, null)
  } finally { await r.cleanup() }
})

test("in a subfolder of a bigger repository only that folder is captured", async () => {
  const r = await rig()
  try {
    await mkdir(path.join(r.proj, "app"), { recursive: true }); await mkdir(path.join(r.proj, "other-team"), { recursive: true })
    await writeFile(path.join(r.proj, "app", "a.py"), "x = 1\n"); await writeFile(path.join(r.proj, "other-team", "b.py"), "y = 1\n")
    git(r.proj, "add", "-A"); git(r.proj, "commit", "-qm", "two folders")
    await writeFile(path.join(r.proj, "other-team", "b.py"), "y = 2  # someone else's work\n")
    await writeFile(path.join(r.proj, "other-team", "scratch.txt"), "someone else's untracked file\n")
    const hooks = await plugin.server({ directory: path.join(r.proj, "app"), client: {} }, { lifelongCapture: true, captureDir: r.taskDir, exampleDir: r.exampleDir })
    await hooks["chat.message"]({ sessionID: "s" }, { parts: [{ type: "text", text: "Change x." }] })
    await hooks["tool.execute.before"]({ sessionID: "s", tool: "edit" }, {})
    await writeFile(path.join(r.proj, "app", "a.py"), "x = 2\n")
    await hooks["tool.execute.after"]({ sessionID: "s", tool: "edit", args: { filePath: path.join(r.proj, "app", "a.py") } }, { output: "ok" })
    await hooks["tool.execute.after"]({ sessionID: "s", tool: "bash", args: { command: "python3 -m unittest -q" } }, { output: "OK", metadata: { exit: 0 } })
    await hooks["command.execute.before"]({ command: "task-save", sessionID: "s", arguments: "" }, {})
    assert.match(await hooks.tool.capture_task.execute({}, { sessionID: "s" }), /^Saved/)
    const text = (await Promise.all((await walk(r.taskDir)).map(f => readFile(f, "utf8")))).join("\n")
    assert.ok(text.includes("x = 2") && !text.includes("someone else"))
  } finally { await r.cleanup() }
})

test("test-result detection: a hidden exit code (|| true, a pipe) does not count as a pass", () => {
  assert.equal(testPassed("FAILED (failures=1)", { exit: 0 }, "python3 -m unittest || true"), false)
  assert.equal(testPassed("Ran 3 tests\nFAILED (failures=1)", { exit: 0 }, "python3 -m unittest 2>&1 | tail -5"), false)
  assert.equal(testPassed("Ran 3 tests\nOK", { exit: 0 }, "python3 -m unittest 2>&1 | tail -5"), true)
  assert.equal(editedFiles({ patchText: "*** Begin Patch\n*** Update File: src/a.py\n@@\n*** Add File: tests/test_b.py\n*** End Patch" }).join(), "src/a.py,tests/test_b.py")
})

test("the transcript limit keeps the end of the run and says that something was cut; the session log is freed when the session is deleted", async () => {
  const log = newLog("s")
  for (let i = 0; i < 300; i++) addTurn(log, { role: "tool", tool: "read", args: "x", output: "y".repeat(2000), at: i })
  assert.equal(log.turnsTruncated, true)
  assert.ok(log.transcriptBytes <= 400_000)
  assert.equal(log.turns[log.turns.length - 1].at, 299)
  const r = await rig()
  try {
    await r.solve()
    await r.hooks.event({ event: { type: "session.deleted", properties: { info: { id: "s1" } } } })
    await r.command("task-save")
    assert.match(await r.tool("capture_task"), /no start snapshot/, "the deleted session has no log any more")
  } finally { await r.cleanup() }
})
