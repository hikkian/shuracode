// RSIL0c: a model's skills are pointed to (name, description, file, scripts); a skill of another model is not visible; the pointer is the
// same on every request while the folder is unchanged.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { frontmatter, skillsPointer } from "../plugin/lib/model-harness.ts"
import plugin from "../plugin/model-harness.ts"

async function folder(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "skills-pointer-"))
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), text)
  }
  return dir
}

const SKILL = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`

test("the frontmatter gives its key-value lines", () => {
  assert.deepEqual(frontmatter(SKILL("verify", "Run the tests")), { name: "verify", description: "Run the tests" })
  assert.deepEqual(frontmatter("no frontmatter here"), {})
})

test("the pointer lists each skill with its file and its scripts; a skill whose name is not its folder is not listed", async () => {
  const dir = await folder({
    "tiel/skills/verify/SKILL.md": SKILL("verify", "Run the project tests after the last edit"),
    "tiel/skills/verify/scripts/check.py": "print('ok')\n",
    "tiel/skills/broken/SKILL.md": SKILL("other-name", "Wrong name"),
  })
  const text = await skillsPointer(path.join(dir, "tiel"))
  assert.match(text, /verify: Run the project tests after the last edit/)
  assert.ok(text.includes(path.join(dir, "tiel/skills/verify/SKILL.md")))
  assert.ok(text.includes(path.join(dir, "tiel/skills/verify/scripts/check.py")))
  assert.ok(!text.includes("other-name"))
  await rm(dir, { recursive: true, force: true })
})

test("a folder without skills gives no pointer", async () => {
  const dir = await folder({ "tiel/harness.md": "rule\n" })
  assert.equal(await skillsPointer(path.join(dir, "tiel")), "")
  await rm(dir, { recursive: true, force: true })
})

test("the plugin adds the model's harness and its pointer, and never another model's skills", async () => {
  const dir = await folder({
    "tiel/harness.md": "Tiel rule.\n",
    "tiel/skills/verify/SKILL.md": SKILL("verify", "Run the tests"),
    "sage/harness.md": "Sage rule.\n",
    "sage/skills/plan/SKILL.md": SKILL("plan", "Plan the steps"),
  })
  const hooks = await plugin.server({}, { harnessDir: dir })
  const hook = hooks["experimental.chat.system.transform"]
  const tiel = { system: [] }
  await hook({ model: { id: "tiel-coder" } }, tiel)
  assert.equal(tiel.system[0], "Tiel rule.\n")
  assert.match(tiel.system[1], /verify: Run the tests/)
  assert.ok(!tiel.system.join("\n").includes("plan"))
  const sage = { system: [] }
  await hook({ model: { id: "sage" } }, sage)
  assert.equal(sage.system[0], "Sage rule.\n")
  assert.ok(!sage.system.join("\n").includes("verify"))
  await rm(dir, { recursive: true, force: true })
})

test("the pointer is the same on every request while the folder does not change", async () => {
  const dir = await folder({ "tiel/skills/verify/SKILL.md": SKILL("verify", "Run the tests") })
  const hook = (await plugin.server({}, { harnessDir: dir }))["experimental.chat.system.transform"]
  const first = { system: [] }
  const second = { system: [] }
  await hook({ model: { id: "tiel-coder" } }, first)
  await hook({ model: { id: "tiel-coder" } }, second)
  assert.deepEqual(first.system, second.system)
  await rm(dir, { recursive: true, force: true })
})
