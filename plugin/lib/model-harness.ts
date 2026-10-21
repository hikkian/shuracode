// The per-model harness (RSI): which harness folder a model id uses. Standard library only, so it can be tested on its own.
export const MODEL_KEYS = ["tiel", "occamy", "gemma"] as const
export type ModelKey = (typeof MODEL_KEYS)[number]

// The model ids the engine reports: the provider's model name (e.g. "tiel-coder", "occamy", "gemma"). Anything else gets no harness.
export function harnessKeyFor(modelId: string | undefined): ModelKey | null {
  const id = (modelId ?? "").toLowerCase()
  for (const key of MODEL_KEYS) {
    if (id.includes(key)) return key
  }
  return null
}
