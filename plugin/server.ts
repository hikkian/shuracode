// ShuraCode server plugin: the engine's built-in system prompt introduces the agent by the engine's name.
// Rename only those self-references; documentation links and config paths stay as they are, because they are
// real and still correct.
import type { PluginModule } from "@opencode-ai/plugin"

const REPLACEMENTS: [RegExp, string][] = [
  [/\bYou are opencode,/g, "You are ShuraCode,"],
  [/Get help with using opencode\b/g, "Get help with using ShuraCode"],
  [/https:\/\/github\.com\/anomalyco\/opencode\/issues/g, "https://github.com/hikkian/shuracode/issues"],
  [/asks about opencode \(eg 'can opencode do\.\.\.', 'does opencode have\.\.\.'\)/g,
    "asks about ShuraCode (eg 'can ShuraCode do...', 'does ShuraCode have...')"],
  [/from opencode docs at https:\/\/opencode\.ai/g, "from the engine documentation at https://opencode.ai"],
]

export function rebrand(text: string): string {
  return REPLACEMENTS.reduce((out, [pattern, value]) => out.replace(pattern, value), text)
}

const plugin: PluginModule & { id: string } = {
  id: "shuracode-server",
  server: async () => ({
    "experimental.chat.system.transform": async (_input, output) => {
      // edit in place: the engine keeps using the same array after the hook returns
      output.system.forEach((text, i) => {
        output.system[i] = rebrand(text)
      })
    },
  }),
}

export default plugin
