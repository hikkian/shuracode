// ShuraCode plugin: a model's own harness text (config/harness/<tiel|sage|gemma>/harness.md), chosen by the model id of the request, and
// the pointer to that model's skills (skills/<name>/SKILL.md with its scripts). Each goes into a separate system message, so an edit for
// one model does not change what another model gets (RSI0c, RSIL0, RSIL0c). Empty files add nothing; with no harnessDir option the
// plugin does nothing.
import type { PluginModule } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { harnessKeyFor, skillsPointer } from "./lib/model-harness.ts"

const plugin: PluginModule & { id: string } = {
  id: "shuracode-model-harness",
  server: async (_input, options) => {
    const dir = (options as any)?.harnessDir
    if (typeof dir !== "string" || !dir) return {}
    return {
      "experimental.chat.system.transform": async (input: any, output: any) => {
        const key = harnessKeyFor(input?.model?.id ?? input?.model?.modelID ?? input?.model?.name)
        if (!key) return
        const text = await readFile(path.join(dir, key, "harness.md"), "utf8").catch(() => "")
        if (text.trim()) output.system.push(text)
        const pointer = await skillsPointer(path.join(dir, key))
        if (pointer) output.system.push(pointer)
      },
    }
  },
}

export default plugin
