// The start of the prompt must not change between turns (reports/REPORT-CACHE1.md, reports/REPORT-CACHE2.md).
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { collectSkills, frontmatter, renderSkills, replaceSkillsBlock } from "../plugin/prefix-stability.ts"
import server from "../plugin/server.ts"

const skill = (name, description, location) => ({ location, text: `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n` })

test("frontmatter reads plain, quoted and folded descriptions and skips files without a name", () => {
  assert.deepEqual(frontmatter("---\nname: pdf\ndescription: Read PDFs\n---\nbody"), { name: "pdf", description: "Read PDFs" })
  assert.deepEqual(frontmatter('---\nname: xlsx\ndescription: "Use it, when: needed"\n---'), { name: "xlsx", description: "Use it, when: needed" })
  assert.deepEqual(frontmatter("---\nname: deck\ndescription: >\n  first line\n  second line\n---"), { name: "deck", description: "first line second line" })
  assert.deepEqual(frontmatter("no frontmatter here"), {})
})

test("collectSkills keeps one entry per name, prefers a copy outside .trash, and sorts by name", () => {
  const files = [
    skill("pptx", "slides", "/home/u/.agents/skills/.trash/171-1/pptx/SKILL.md"),
    skill("pptx", "slides", "/home/u/.agents/skills/synced/abc/pptx/SKILL.md"),
    skill("chrome-browser", "browser", "/home/u/.agents/skills/.trash/171-2/chrome-browser/SKILL.md"),
    skill("morning", "brief", "/home/u/.agents/skills/synced/abc/morning/SKILL.md"),
  ]
  const picked = collectSkills(files)
  assert.deepEqual(picked.map((e) => e.name), ["chrome-browser", "morning", "pptx"])
  assert.equal(picked.find((e) => e.name === "pptx").location, "/home/u/.agents/skills/synced/abc/pptx/SKILL.md")
  // a name that exists only in .trash is still listed (its copy is the only one)
  assert.equal(picked[0].location, "/home/u/.agents/skills/.trash/171-2/chrome-browser/SKILL.md")
})

test("collectSkills does not depend on the order the files were found in", () => {
  const files = [
    skill("a", "one", "/s/.trash/x/a/SKILL.md"),
    skill("a", "one", "/s/synced/y/a/SKILL.md"),
    skill("b", "two", "/s/b/SKILL.md"),
    skill("c", "three", "/s/synced/z/c/SKILL.md"),
  ]
  const forward = renderSkills(collectSkills(files))
  const backward = renderSkills(collectSkills([...files].reverse()))
  assert.equal(forward, backward)
})

test("renderSkills uses the engine's layout", () => {
  const text = renderSkills([{ name: "pdf", description: "Read PDFs", location: "/h/.agents/skills/pdf/SKILL.md" }])
  assert.equal(
    text,
    "<available_skills>\n  <skill>\n    <name>pdf</name>\n    <description>Read PDFs</description>\n    <location>/h/.agents/skills/pdf/SKILL.md</location>\n  </skill>\n</available_skills>",
  )
})

test("replaceSkillsBlock swaps only the skill list and leaves the rest of the text alone", () => {
  const before = "Intro.\n<available_skills>\n  old\n</available_skills>\nOutro."
  assert.equal(replaceSkillsBlock(before, "<available_skills>NEW</available_skills>"), "Intro.\n<available_skills>NEW</available_skills>\nOutro.")
  assert.equal(replaceSkillsBlock("no list here", "<available_skills>NEW</available_skills>"), "no list here")
})

async function withSkills(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "shuracode-skills-"))
  try {
    const put = async (rel, name, description) => {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
      await writeFile(path.join(root, rel), `---\nname: ${name}\ndescription: ${description}\n---\n`)
    }
    await put("synced/abc/pptx/SKILL.md", "pptx", "slides")
    await put(".trash/171-1/pptx/SKILL.md", "pptx", "slides")
    await put("webapp-testing/SKILL.md", "webapp-testing", "playwright")
    await fn(root, put)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const systemTexts = (block) => [`Env block.\n  Platform: linux\n</env>`, `Rules.\n${block}`]

test("two plugin instances over the same folder produce the same skill list (a restart changes nothing)", async () => {
  await withSkills(async (root) => {
    const hooks1 = await server.server({}, { skillsRoot: root })
    const hooks2 = await server.server({}, { skillsRoot: root })
    const out1 = { system: systemTexts("<available_skills>\n</available_skills>") }
    const out2 = { system: systemTexts("<available_skills>\n</available_skills>") }
    await hooks1["experimental.chat.system.transform"]({ model: { name: "tiel" } }, out1)
    await hooks2["experimental.chat.system.transform"]({ model: { name: "tiel" } }, out2)
    assert.deepEqual(out1.system, out2.system)
    const list = out1.system[1]
    assert.equal((list.match(/<skill>/g) ?? []).length, 2) // pptx once, webapp-testing once
    assert.ok(!list.includes("/.trash/"))
  })
})

