# Per-model harness (RSI)

One folder per model: `tiel/`, `sage/`, `gemma/`, each with `harness.md`. The plugin `plugin/model-harness.ts` reads the file of the
model that makes the request (by its model id) and adds the text as a separate system message. Empty files add nothing, so the default
product is unchanged until an accepted harness is copied here. An edit to one model's file does not change another model's text
(tested in tests/model-harness.test.mjs).
