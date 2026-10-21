// ShuraCode plugin: the `visible_tests` tool shows the agent the project's own tests (never the hidden ones) before it changes code.
// Off unless the config asks for it ({"visibleTests": true}), so the default prompt and tools stay as they are.
// Plugin tools use plain objects so loading them does not depend on copying the plugin package's runtime dependencies into isolated configs.
import type { PluginModule } from "@opencode-ai/plugin"
import { listVisibleTests, renderVisibleTests } from "./lib/visible-tests.ts"

const plugin: PluginModule & { id: string } = {
  id: "shuracode-visible-tests",
  server: async (input, options) => {
    if ((options as any)?.visibleTests !== true) return {}
    return {
      tool: {
        visible_tests: {
          description:
            "List the tests this project shows you (its own test files with their text, never hidden checks). Call it before you change code for an implement or refactor task: those tests are the contract you must satisfy.",
          args: {},
          async execute() {
            return renderVisibleTests(await listVisibleTests(input.directory))
          },
        },
      },
    }
  },
}

export default plugin
