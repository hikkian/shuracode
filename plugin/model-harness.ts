// ShuraCode plugin: a model's own harness text (config/harness/<tiel|sage|gemma>/harness.md), chosen by the model id of the request, and
// the pointer to that model's skills (skills/<name>/SKILL.md with its scripts). Each goes into a separate system message, so an edit for
// one model does not change what another model gets (RSI0c, RSIL0, RSIL0c). Empty files add nothing; with no harnessDir option the
// plugin does nothing.
//
// LL4: a second folder, `userHarnessDir` (the person's own layer, ~/.local/share/shura/skills/<model>/, rendered by mcp/rules.py from
// the rules that passed the check), is added AFTER the base layer as its own system messages (harness.md, then its skills pointer).
// The personal layer can only add to the base and the system prompt, never replace them; a missing folder adds nothing.
import type { PluginModule } from "@opencode-ai/plugin"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { expandHome, harnessKeyFor, personalLayerDir, skillsPointer } from "./lib/model-harness.ts"

const plugin: PluginModule & { id: string } = {
  id: "shuracode-model-harness",
  server: async (_input, options) => {
    const dir = (options as any)?.harnessDir
    const userDirOption = (options as any)?.userHarnessDir
    const userDir = typeof userDirOption === "string" && userDirOption ? expandHome(userDirOption) : ""
    if ((typeof dir !== "string" || !dir) && !userDir) return {}
    return {
      "experimental.chat.system.transform": async (input: any, output: any) => {
        const key = harnessKeyFor(input?.model?.id ?? input?.model?.modelID ?? input?.model?.name)
        if (!key) return
        if (typeof dir === "string" && dir) {
          const text = await readFile(path.join(dir, key, "harness.md"), "utf8").catch(() => "")
          if (text.trim()) output.system.push(text)
          const pointer = await skillsPointer(path.join(dir, key))
          if (pointer) output.system.push(pointer)
        }
        if (userDir) {
          const layer = await personalLayerDir(path.join(userDir, key))
          const text = await readFile(path.join(layer, "harness.md"), "utf8").catch(() => "")
          if (text.trim()) output.system.push(text)
          const pointer = await skillsPointer(layer)
          if (pointer) output.system.push(pointer)
        }
      },
    }
  },
}

export default plugin
