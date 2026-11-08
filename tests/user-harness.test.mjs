// LL4: the person's own layer (userHarnessDir/<model>/) is added after the base harness as its own system messages, can only add to
// the base, follows a CURRENT version pointer, and is never another model's.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expandHome, personalLayerDir } from "../plugin/lib/model-harness.ts"
import plugin from "../plugin/model-harness.ts"

async function folder(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "user-harness-"))
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), text)
  }
  return dir
}

const SKILL = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`

test("the personal layer comes after the base layer and the base text is untouched", async () => {
  const base = await folder({ "tiel/harness.md": "BASE TIEL\n", "tiel/skills/verify/SKILL.md": SKILL("verify", "Run the tests") })
  const user = await folder({ "tiel/harness.md": "Personal rules of this model:\n- When done: run the tests.\n",
                              "tiel/skills/deploy/SKILL.md": SKILL("deploy", "Deploy with make deploy") })
  const hook = (await plugin.server({}, { harnessDir: base, userHarnessDir: user }))["experimental.chat.system.transform"]
  const out = { system: ["system prompt"] }
  await hook({ model: { id: "tiel-coder" } }, out)
  assert.equal(out.system[0], "system prompt")
  assert.equal(out.system[1], "BASE TIEL\n")
  assert.match(out.system[2], /verify: Run the tests/)
  assert.equal(out.system[3], "Personal rules of this model:\n- When done: run the tests.\n")
  assert.match(out.system[4], /deploy: Deploy with make deploy/)
  assert.equal(out.system.length, 5)
  await rm(base, { recursive: true, force: true })
  await rm(user, { recursive: true, force: true })
})

test("a missing or empty personal layer adds nothing; the base layer is as before", async () => {
  const base = await folder({ "tiel/harness.md": "BASE TIEL\n" })
  const user = await folder({ "sage/harness.md": "Sage personal\n", "tiel/harness.md": "   \n" })
  const hook = (await plugin.server({}, { harnessDir: base, userHarnessDir: path.join(user, "nowhere") }))["experimental.chat.system.transform"]
  const out = { system: [] }
  await hook({ model: { id: "tiel-coder" } }, out)
  assert.deepEqual(out.system, ["BASE TIEL\n"])
  const hook2 = (await plugin.server({}, { harnessDir: base, userHarnessDir: user }))["experimental.chat.system.transform"]
  const out2 = { system: [] }
  await hook2({ model: { id: "tiel-coder" } }, out2)
  assert.deepEqual(out2.system, ["BASE TIEL\n"], "an empty personal harness adds nothing and Sage's layer is not Tiel's")
  await rm(base, { recursive: true, force: true })
  await rm(user, { recursive: true, force: true })
})

test("the personal layer alone works without a base folder; no folders at all means no hook", async () => {
  const user = await folder({ "gemma/harness.md": "Gemma personal\n" })
  const hook = (await plugin.server({}, { userHarnessDir: user }))["experimental.chat.system.transform"]
  const out = { system: [] }
  await hook({ model: { id: "gemma" } }, out)
  assert.deepEqual(out.system, ["Gemma personal\n"])
  assert.deepEqual(await plugin.server({}, {}), {})
  await rm(user, { recursive: true, force: true })
})

test("CURRENT points at a version folder; a bad pointer falls back to the model folder", async () => {
  const user = await folder({
    "tiel/harness.md": "working copy\n",
    "tiel/versions/002/harness.md": "version two\n",
    "tiel/CURRENT": "002\n",
  })
  assert.equal(await personalLayerDir(path.join(user, "tiel")), path.join(user, "tiel/versions/002"))
  const hook = (await plugin.server({}, { userHarnessDir: user }))["experimental.chat.system.transform"]
  const out = { system: [] }
  await hook({ model: { id: "tiel-coder" } }, out)
  assert.deepEqual(out.system, ["version two\n"])
  await writeFile(path.join(user, "tiel/CURRENT"), "../../etc\n")
  assert.equal(await personalLayerDir(path.join(user, "tiel")), path.join(user, "tiel"))
  await writeFile(path.join(user, "tiel/CURRENT"), "009\n")
  assert.equal(await personalLayerDir(path.join(user, "tiel")), path.join(user, "tiel"))
  await rm(user, { recursive: true, force: true })
})

test("~ in the option means the home folder", () => {
  assert.equal(expandHome("~/.local/share/shura/skills"), path.join(os.homedir(), ".local/share/shura/skills"))
  assert.equal(expandHome("/abs/path"), "/abs/path")
  assert.equal(expandHome("~"), os.homedir())
})

test("the plugin records the model of the request in CURRENT_MODEL, rewriting it only when it changes", async () => {
  const user = await folder({ "tiel/harness.md": "x\n" })
  const hook = (await plugin.server({}, { userHarnessDir: user }))["experimental.chat.system.transform"]
  await hook({ model: { id: "tiel-coder" } }, { system: [] })
  assert.equal((await readFile(path.join(user, "CURRENT_MODEL"), "utf8")).trim(), "tiel")
  assert.equal((await readFile(path.join(user, `CURRENT_MODEL.${process.pid}`), "utf8")).trim(), "tiel", "a per-process file for the rules server")
  const before = (await stat(path.join(user, "CURRENT_MODEL"), { bigint: true })).mtimeNs
  assert.equal(typeof before, "bigint")
  await new Promise((r) => setTimeout(r, 20))
  await hook({ model: { id: "tiel-coder" } }, { system: [] })
  assert.equal((await stat(path.join(user, "CURRENT_MODEL"), { bigint: true })).mtimeNs, before)
  await hook({ model: { id: "sage" } }, { system: [] })
  assert.equal((await readFile(path.join(user, "CURRENT_MODEL"), "utf8")).trim(), "sage")
  assert.equal((await readFile(path.join(user, `CURRENT_MODEL.${process.pid}`), "utf8")).trim(), "sage")
  await rm(user, { recursive: true, force: true })
})
