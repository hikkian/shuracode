// RSIL0: the per-model harness picks the folder by the model id, and an edit for one model does not change another model's text.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { harnessKeyFor } from "../plugin/lib/model-harness.ts"
import plugin from "../plugin/model-harness.ts"

test("the model id picks the harness folder; unknown ids get none", () => {
  assert.equal(harnessKeyFor("tiel-coder"), "tiel")
  assert.equal(harnessKeyFor("sage"), "sage")
  assert.equal(harnessKeyFor("occamy"), null)
  assert.equal(harnessKeyFor("gemma"), "gemma")
  assert.equal(harnessKeyFor("claude-opus-5-5"), null)
  assert.equal(harnessKeyFor(undefined), null)
})

test("an edit to one model's harness does not change another model's system text", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-harness-"))
  try {
    for (const k of ["tiel", "sage"]) await mkdir(path.join(dir, k), { recursive: true })
    await writeFile(path.join(dir, "tiel", "harness.md"), "TIEL RULE v1\n")
    await writeFile(path.join(dir, "sage", "harness.md"), "SAGE RULE v1\n")
    const hooks = await plugin.server({}, { harnessDir: dir })
    const hook = hooks["experimental.chat.system.transform"]
    const sageBefore = { system: ["base"] }
    await hook({ model: { id: "sage" } }, sageBefore)
    await writeFile(path.join(dir, "tiel", "harness.md"), "TIEL RULE v2, edited\n")
    const sageAfter = { system: ["base"] }
    await hook({ model: { id: "sage" } }, sageAfter)
    assert.deepEqual(sageBefore.system, sageAfter.system)
    const tiel = { system: ["base"] }
    await hook({ model: { id: "tiel-coder" } }, tiel)
    assert.match(tiel.system[1], /TIEL RULE v2/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("no harness option or an empty file adds nothing", async () => {
  assert.deepEqual(await plugin.server({}, {}), {})
  const dir = await mkdtemp(path.join(os.tmpdir(), "model-harness-empty-"))
  try {
    await mkdir(path.join(dir, "gemma"), { recursive: true })
    await writeFile(path.join(dir, "gemma", "harness.md"), "")
    const hook = (await plugin.server({}, { harnessDir: dir }))["experimental.chat.system.transform"]
    const out = { system: ["base"] }
    await hook({ model: { id: "gemma" } }, out)
    assert.deepEqual(out.system, ["base"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
