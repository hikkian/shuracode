// The start of the prompt must not change between turns (reports/REPORT-CACHE1.md, reports/REPORT-CACHE2.md).
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { collectSkills, dateNote, frontmatter, renderSkills, replaceSkillsBlock, stableDateLine, stableModelLine } from "../plugin/prefix-stability.ts"
import server, { rebrand } from "../plugin/server.ts"

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

test("stableDateLine gives the same text on every day, so the start of the prompt does not change at midnight", () => {
  const monday = "  Platform: linux\n  Today's date: Sat Oct 17 2026\n</env>"
  const tuesday = "  Platform: linux\n  Today's date: Sun Oct 18 2026\n</env>"
  assert.equal(stableDateLine(monday), stableDateLine(tuesday))
  assert.ok(!stableDateLine(monday).includes("Oct 17"))
})

test("dateNote carries the day in the engine's wording", () => {
  assert.equal(dateNote(new Date(2026, 9, 18, 9, 30)), "Today's date: Sun Oct 18 2026")
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

const systemTexts = (block) => [`Env block.\n  Today's date: Sat Oct 17 2026\n</env>`, `Rules.\n${block}`]

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
    assert.ok(out1.system[0].includes("Today's date: given in the user's messages"))
  })
})

test("the date note goes into the user's message once per session per day, not on every request", async () => {
  await withSkills(async (root) => {
    const hooks = await server.server({}, { skillsRoot: root })
    const first = { sessionID: "s1", messageID: "m1", parts: [{ type: "text", text: "hi" }] }
    await hooks["chat.message"]({ sessionID: "s1", messageID: "m1" }, first)
    assert.equal(first.parts.length, 1)
    assert.match(first.parts[0].text, /^hi\n\[Today's date: [A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4}\]$/)
    const second = { sessionID: "s1", messageID: "m2", parts: [{ type: "text", text: "again" }] }
    await hooks["chat.message"]({ sessionID: "s1", messageID: "m2" }, second)
    assert.equal(second.parts[0].text, "again")
    const otherSession = { sessionID: "s2", messageID: "m3", parts: [{ type: "text", text: "new chat" }] }
    await hooks["chat.message"]({ sessionID: "s2", messageID: "m3" }, otherSession)
    assert.match(otherSession.parts[0].text, /Today's date/)
  })
})

test("the system sentence names ShuraCode only: a model switch does not change the start of the prompt", () => {
  assert.equal(rebrand("You are opencode, an interactive CLI tool"), "You are ShuraCode, an interactive CLI tool")
})

test("the model is noted in the user's message once per session and again only when it changes", async () => {
  await withSkills(async (root) => {
    const hooks = await server.server({}, { skillsRoot: root })
    const send = async (messageID, modelID) => {
      const out = { parts: [{ type: "text", text: "hi" }] }
      await hooks["chat.message"]({ sessionID: "s9", messageID, model: { providerID: "tiel-local", modelID } }, out)
      return out.parts[0].text
    }
    assert.match(await send("a", "tiel-coder"), /\[Model: tiel-local\/tiel-coder\]/)
    assert.equal(await send("b", "tiel-coder"), "hi")
    assert.match(await send("c", "tiel-coder-apex"), /\[Model: tiel-local\/tiel-coder-apex\]/)
    assert.equal(await send("d", "tiel-coder-apex"), "hi")
  })
})

test("the engine's model line is the same for every model, so a switch does not change the start of the prompt", () => {
  const apex = "Notes.\nYou are powered by the model named tiel-coder-apex. The exact model ID is tiel-local/tiel-coder-apex\nHere is"
  const main = "Notes.\nYou are powered by the model named tiel-coder. The exact model ID is tiel-local/tiel-coder\nHere is"
  assert.equal(stableModelLine(apex), stableModelLine(main))
  assert.ok(!stableModelLine(main).includes("tiel-coder"))
})
