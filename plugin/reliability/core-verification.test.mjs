import test from "node:test"
import assert from "node:assert/strict"
import completionGate from "./completion-gate.ts"
import { isSuccessfulCheck, isVerificationCommand } from "./core.ts"

test("FABLE3 recognizes project test commands and rejects ad-hoc checks", () => {
  for (const command of [
    "python3 -m unittest discover -s tests -q",
    "python3 test_repro.py",
    "node --test public-repro.test.js",
    "node public-repro.test.js",
    "cd proj && npx vitest run",
    "bun test",
    "unittest discover",
  ]) assert.equal(isVerificationCommand("bash", { command }), true, command)

  for (const command of ["python3 check.py", "node -e \"console.log(1)\"", "python3 - <<'PY'\nprint(1)\nPY", "ls -la", "node verify.js"])
    assert.equal(isVerificationCommand("bash", { command }), false, command)
})

test("FABLE3 reads unittest and node:test success output and rejects failures", () => {
  assert.equal(isSuccessfulCheck({ output: "Ran 2 tests in 0.001s\n\nOK\n", metadata: {} }), true)
  assert.equal(isSuccessfulCheck({ output: "# tests 3\n# pass 3\n# fail 0\n", metadata: {} }), true)
  assert.equal(isSuccessfulCheck({ output: "# tests 3\n# pass 2\n# fail 1\n", metadata: {} }), false)
  assert.equal(isSuccessfulCheck({ output: "Ran 2 tests\n\nFAILED (failures=1)\n", metadata: {} }), false)
})

test("completion gate requires a recognized successful verification command", async () => {
  const prompts = []
  const input = { client: { session: { promptAsync: async (request) => prompts.push(request) } } }
  const hooks = await completionGate.server(input, { completionGate: true })
  const chat = (text) => [{ sessionID: "s1" }, { message: {}, parts: [{ type: "text", text }] }]

  await hooks["chat.message"](...chat("Implement a parser"))
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "edit", args: {} }, { output: "Edit applied", metadata: {} })
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "bash", args: { command: "python3 check.py" } },
    { output: "ok", metadata: { exit: 0 } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  assert.equal(prompts.length, 1, "an ad-hoc script must not satisfy the gate")

  await hooks["chat.message"](...chat("Run the project tests"))
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "edit", args: {} }, { output: "Edit applied", metadata: {} })
  await hooks["tool.execute.after"]({ sessionID: "s1", tool: "bash", args: { command: "python3 -m unittest test_probe -v" } },
    { output: "Ran 1 test in 0.001s\n\nOK\n", metadata: { exit: 0 } })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
  assert.equal(prompts.length, 1, "a successful project test run satisfies the gate")
})
