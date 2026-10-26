// EFFORT1: the pure part of the effort slider in the plugin.
import test from "node:test"
import assert from "node:assert/strict"
import { EFFORT_LEVELS, describeLevel, effortChip, fallbackOf, promptLineGroup, rereadNeeded } from "../plugin/lib/effort.ts"

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

test("a level the model lacks is described with its fallback and the budget the gateway sends", () => {
  assert.equal(fallbackOf("max", occamy.available), "high")
  assert.equal(fallbackOf("off", occamy.available), "low")
  assert.equal(fallbackOf("off", ["medium", "high"]), "medium")
  const budgets = { low: { target: 400, ceiling: 1500 }, max: { target: null, ceiling: 24000 } }
  const text = describeLevel("max", occamy, "en", (l) => budgets[l])
  assert.match(text, /no such level; it runs at high/)
  assert.match(text, /budget: ≤24000 tokens/)
  assert.match(describeLevel("low", tiel, "ru", (l) => budgets[l]), /бюджет: ~400–1500 токенов/)
  assert.doesNotMatch(describeLevel("medium", tiel, "en"), /budget/)
})
