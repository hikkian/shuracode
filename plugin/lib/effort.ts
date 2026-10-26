// EFFORT1: the effort slider. The user picks a level (off, low, medium, high, max); the gateway keeps it for the session
// (/guardian/effort-<level>) and turns it into the model's template switch and a real reasoning budget. This module is the
// pure part: the level list, the words, the chip text and the rule for the "reads the conversation again" notice.
export const EFFORT_LEVELS = ["off", "low", "medium", "high", "max"] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]
export type EffortLang = "en" | "ru"

export type EffortStatus = {
  level: string                 // the session level (default: medium)
  effective: string | null      // the level the model really runs at (fallback applied); null = the model has no levels
  available: string[]           // levels the model's template knows
  isDefault: boolean
  budget?: { target: number | null; ceiling: number | null } | null   // the reasoning budget the gateway sends (when budgets are on)
}

export const EFFORT_TEXT: Record<EffortLang, Record<string, string>> = {
  en: {
    title: "Effort (Esc to close)", set: "Effort", current: " (current)", chip: "effort",
    off: "off", low: "low", medium: "medium", high: "high", max: "max",
    offD: "answers right away, no thinking; for simple questions",
    lowD: "a short think; quick answers and small edits",
    mediumD: "the default: the model decides how much to think",
    highD: "thinks longer and checks itself; for hard tasks",
    maxD: "as long as it needs, up to the largest budget; for the hardest tasks, slow",
    reread: "The next reply reads the conversation again once.",
    none: "This model has no effort levels.",
    asFallback: "this model has no such level; it runs at",
    failed: "Could not reach the gateway; the effort level is unchanged.",
    budget: "budget", tokens: "tokens", unlimited: "no ceiling",
  },
  ru: {
    title: "Усилие (Esc: закрыть)", set: "Усилие", current: " (сейчас)", chip: "усилие",
    off: "выкл", low: "низкое", medium: "среднее", high: "высокое", max: "максимум",
    offD: "ответ сразу, без рассуждения; для простых вопросов",
    lowD: "короткое рассуждение; быстрые ответы и мелкие правки",
    mediumD: "по умолчанию: модель сама решает, сколько думать",
    highD: "думает дольше и проверяет себя; для сложных задач",
    maxD: "сколько потребуется, до самого большого бюджета; для самых трудных задач, медленно",
    reread: "Следующий ответ один раз заново прочитает разговор.",
    none: "У этой модели нет уровней усилия.",
    asFallback: "у этой модели нет такого уровня; она работает на",
    failed: "Не удалось связаться со шлюзом; уровень усилия не изменён.",
    budget: "бюджет", tokens: "токенов", unlimited: "без потолка",
  },
}

// The template puts a line at the start of the prompt for low and for high/max (one line for both: Sharp says xhigh,
// Occamy says high), nothing for off and medium. A change of that line makes the next reply re-read the conversation.
export function promptLineGroup(level: string | null | undefined): "" | "low" | "high" {
  if (level === "low") return "low"
  if (level === "high" || level === "max") return "high"
  return ""
}

export function rereadNeeded(before: string | null | undefined, after: string | null | undefined): boolean {
  return promptLineGroup(before) !== promptLineGroup(after)
}

// The level the chip shows: the effective one; always visible, so the user knows where the slider stands.
export function effortChip(think: EffortStatus | undefined, lang: EffortLang): string {
  if (!think || !think.effective) return ""
  const t = EFFORT_TEXT[lang]
  return `${t.chip}: ${t[think.effective] ?? think.effective}`
}

// One line under a level in the picker: what it does, the fallback note and the budget the gateway would send.
export function describeLevel(level: EffortLevel, think: EffortStatus, lang: EffortLang, budgetFor?: (level: string) => EffortStatus["budget"]): string {
  const t = EFFORT_TEXT[lang]
  const parts = [t[level + "D"]]
  if (think.available.length && !think.available.includes(level)) parts.push(`(${t.asFallback} ${t[fallbackOf(level, think.available)] ?? fallbackOf(level, think.available)})`)
  const b = budgetFor ? budgetFor(level) : undefined
  if (b && b.ceiling != null) parts.push(`· ${t.budget}: ${b.target != null ? `~${b.target}–` : "≤"}${b.ceiling} ${t.tokens}`)
  return parts.join(" ")
}

// The gateway's own fallback rule (user_modes.effective_think_level): a level the template lacks runs at the configured
// fallback, else at medium. The plugin only knows the available list, so it mirrors the common cases.
export function fallbackOf(level: string, available: string[]): string {
  if (available.includes(level)) return level
  if (level === "max" && available.includes("high")) return "high"
  if (level === "off" && available.includes("low")) return "low"
  return "medium"
}
