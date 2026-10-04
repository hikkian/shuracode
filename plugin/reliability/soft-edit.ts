import type { PluginModule } from "@opencode-ai/plugin"
import { matchEditBlock } from "./core.ts"

function clip(text: string): string {
  const lines = text.split("\n").slice(0, 12)
  return lines.join("\n").slice(0, 1200)
}

const plugin: PluginModule & { id: string } = {
  id: "shuracode-soft-edit",
  server: async (input, options) => ({
    "tool.execute.before": async (hook, output) => {
      if ((options as any)?.softEdit !== true || hook.tool !== "edit") return
      const args = output.args as Record<string, unknown>
      if (typeof args.filePath !== "string" || typeof args.oldString !== "string" || typeof args.newString !== "string") return
      let response: any
      try {
        response = await input.client.file.read({ query: { path: args.filePath, directory: input.directory } })
      } catch {
        return
      }
      const content = response?.data?.content
      if (typeof content !== "string") return
      const match = matchEditBlock(content, args.oldString)
      if (match.kind === "exact") return
      if (match.kind === "unique-whitespace" && match.matched) {
        args.oldString = match.matched
        return
      }
      if (match.kind === "ambiguous-whitespace") {
        const samples = (match.candidates ?? []).map((text, i) => `--- candidate ${i + 1} ---\n${clip(text)}`).join("\n")
        throw new Error(`Soft edit refused: the whitespace-normalized text matches more than one place in ${args.filePath}. Add more context.\n${samples}`)
      }
      // OpenCode 1.18.32 already has line-trimmed, anchor, whitespace and indentation
      // fallbacks. Let those handle close candidates; only give a local hint when the
      // built-in's documented 0.65 block-similarity bar is unlikely to apply.
      if (match.kind === "nearby" && match.matched && (match.score ?? 0) < 0.5) {
        throw new Error(`Soft edit could not find a safe unique replacement in ${args.filePath}. Closest fragment (review and retry with exact surrounding lines):\n${clip(match.matched)}`)
      }
    },
  }),
}

export default plugin
