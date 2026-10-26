// EFFORT1: the pure part of the effort slider in the plugin.
import test from "node:test"
import assert from "node:assert/strict"
import { EFFORT_LEVELS, budgetText, describeLevel, effortChip, fallbackOf, pickerTitle, promptLineGroup, rereadNeeded, titleFor } from "../plugin/lib/effort.ts"

const tiel = { level: "medium", effective: "medium", available: ["off", "low", "medium", "high", "max"], isDefault: true }
const occamy = { level: "max", effective: "high", available: ["low", "medium", "high"], isDefault: false }

test("five levels, medium in the middle", () => {
  assert.deepEqual([...EFFORT_LEVELS], ["off", "low", "medium", "high", "max"])
})

test("the chip always names the effective level, in the user's language", () => {
  assert.equal(effortChip(tiel, "en"), "effort: medium")
  assert.equal(effortChip({ ...tiel, effective: "max" }, "ru"), "усилие: максимум")
  assert.equal(effortChip(occamy, "ru"), "усилие: высокое")
  assert.equal(effortChip({ ...tiel, effective: null }, "en"), "")
  assert.equal(effortChip(undefined, "en"), "")
})

test("the re-read notice follows the prompt line, not the level name", () => {
  assert.equal(promptLineGroup("high"), promptLineGroup("max"))      // one template line for both
  assert.equal(promptLineGroup("off"), promptLineGroup("medium"))    // no line for either
  assert.equal(rereadNeeded("medium", "low"), true)
  assert.equal(rereadNeeded("high", "max"), false)
  assert.equal(rereadNeeded("off", "medium"), false)
  assert.equal(rereadNeeded("low", "high"), true)
})

test("a level the model lacks is described with its fallback; the budget sits in the dialog title and the toast", () => {
  assert.equal(fallbackOf("max", occamy.available), "high")
  assert.equal(fallbackOf("off", occamy.available), "low")
  assert.equal(fallbackOf("off", ["medium", "high"]), "medium")
  assert.match(describeLevel("max", occamy, "en"), /no such level; it runs at high/)
  assert.equal(titleFor("medium", tiel, "en"), "medium (current)")
  assert.equal(titleFor("max", occamy, "ru"), "максимум")
  assert.equal(budgetText({ target: 400, ceiling: 1500 }, "ru"), "~400–1500 токенов")
  assert.equal(budgetText({ target: null, ceiling: 24000 }, "en"), "≤24000 tokens")
  assert.equal(budgetText(null, "en"), "")
  assert.equal(pickerTitle({ ...tiel, budget: { target: 1200, ceiling: 6000 } }, "en"), "Effort · medium: ~1200–6000 tokens (Esc to close)")
  assert.equal(pickerTitle({ ...tiel, budget: null }, "en"), "Effort · medium (Esc to close)")
  assert.equal(pickerTitle({ ...tiel, effective: null }, "ru"), "Усилие (Esc: закрыть)")
  // a picker row is 52 visible characters: the level, its "(current)" mark and the description must fit it together
  for (const lang of ["en", "ru"]) for (const level of EFFORT_LEVELS) {
    const row = titleFor(level, { ...tiel, effective: level }, lang) + " " + describeLevel(level, tiel, lang)   // with the "(current)" mark
    assert.ok(row.length <= 52, `${lang} ${level}: ${row.length} chars: ${row}`)
  }
})
