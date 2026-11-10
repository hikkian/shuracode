// The engine folds the model's reasoning in its TUI by default (thinking_mode "hide"): the user sees a heading and no text
// until the answer starts, which looks like nothing is happening. Show it as it streams, once: a choice made later with the
// thinking toggle is kept, and a user who already set the mode is never overridden.
export const THINKING_KEY = "thinking_mode"
export const DEFAULT_DONE_KEY = "shuracode.thinking_default_v1"

export interface KvLike {
  get(key: string, fallback?: unknown): unknown
  set(key: string, value: unknown): void
}

export function applyThinkingDefault(kv: KvLike): boolean {
  if (kv.get(DEFAULT_DONE_KEY, false) === true) return false
  kv.set(DEFAULT_DONE_KEY, true)
  if (kv.get(THINKING_KEY, undefined) !== undefined) return false
  kv.set(THINKING_KEY, "show")
  return true
}
