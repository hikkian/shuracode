// ShuraCode plugin: context diet (MASK1). Off unless the plugin option contextDiet is true (the default is off).
// Old tool outputs are masked once the dialogue passes maskStartChars. The masked set is kept per session, in memory and in a small
// file under XDG_STATE_HOME, so a masked output stays masked and the prompt prefix does not change between turns.
import type { PluginModule } from "@opencode-ai/plugin"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applyMasks, newMasks, optionsFrom, type Message } from "./lib/context-diet.ts"

function stateFile(sessionID: string): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(base, "shuracode", "context-diet", `${sessionID.replace(/[^A-Za-z0-9_-]/g, "_")}.json`)
}

async function loadMasked(file: string): Promise<Set<string>> {
  try {
    const data = JSON.parse(await readFile(file, "utf8"))
    return new Set(Array.isArray(data.masked) ? data.masked.map(String) : [])
  } catch {
    return new Set()
  }
}

// written only when the set changed; if the write fails, only the stickiness across restarts is lost
async function saveMasked(file: string, masked: Set<string>) {
  try {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(`${file}.tmp`, JSON.stringify({ masked: [...masked] }))
    await rename(`${file}.tmp`, file)
  } catch {
    // the state file is an optimisation: the turn goes on without it
  }
}

const plugin: PluginModule & { id: string } = {
  id: "shuracode-context-diet",
  server: async (_input, options) => {
    const opts = (options ?? {}) as Record<string, unknown>
    if (opts.contextDiet !== true) return {}
    const dietOptions = optionsFrom(opts)
    const sessions = new Map<string, Set<string>>()
    return {
      "experimental.chat.messages.transform": async (_input: any, output: any) => {
        const messages = output.messages as Message[]
        const sessionID = String(messages[0]?.info?.sessionID ?? "default")
        let masked = sessions.get(sessionID)
        if (!masked) {
          masked = await loadMasked(stateFile(sessionID))
          sessions.set(sessionID, masked)
        }
        const fresh = newMasks(messages, masked, dietOptions)
        if (fresh.length) {
          for (const id of fresh) masked.add(id)
          await saveMasked(stateFile(sessionID), masked)
        }
        if (masked.size === 0) return
        // the engine reads this same array after the hook, so the entries are replaced in place
        applyMasks(messages, masked).forEach((m, i) => {
          messages[i] = m
        })
      },
    }
  },
}

export default plugin
