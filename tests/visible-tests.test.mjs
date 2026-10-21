// QSPEC1: the visible_tests listing shows the project's own tests and never the hidden ones or dependencies.
import test from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isTestPath, listVisibleTests, renderVisibleTests, MAX_CHARS_PER_FILE } from "../plugin/lib/visible-tests.ts"

async function project(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "visible-tests-"))
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true })
    await writeFile(path.join(root, rel), text)
  }
  return root
}

test("test files are recognised by name and by a tests folder, source files are not", () => {
  assert.equal(isTestPath("test_cart.py"), true)
  assert.equal(isTestPath("pkg/cart_test.py"), true)
  assert.equal(isTestPath("web/cart.test.js"), true)
  assert.equal(isTestPath("tests/helpers.py"), true)
  assert.equal(isTestPath("src/cart.py"), false)
  assert.equal(isTestPath("tests/README.md"), false)
})

test("the listing shows the project's tests, sorted, and never hidden_tests or node_modules", async () => {
  const root = await project({
    "test_top.py": "assert True\n",
    "tests/test_a.py": "def test_a(): pass\n",
    "src/cart.py": "def total(): return 0\n",
    "hidden_tests/test_secret.py": "# the hidden contract\n",
    "node_modules/pkg/test_dep.py": "# a dependency\n",
    ".git/test_git.py": "# git\n",
  })
  try {
    const list = await listVisibleTests(root)
    assert.deepEqual(list.tests.map((t) => t.path), ["test_top.py", "tests/test_a.py"])
    assert.equal(list.more, 0)
    assert.ok(!renderVisibleTests(list).includes("hidden contract"))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("long files are cut and say so; the count of files not shown is given", async () => {
  const big = "x".repeat(MAX_CHARS_PER_FILE + 500)
  const files = {}
  for (let i = 0; i < 3; i++) files[`tests/test_${i}.py`] = big
  const root = await project(files)
  try {
    const list = await listVisibleTests(root, 2)
    assert.equal(list.tests.length, 2)
    assert.equal(list.tests[0].truncated, true)
    assert.equal(list.more, 1)
    assert.match(renderVisibleTests(list), /1 more not shown/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("a project with no tests says so instead of listing nothing", async () => {
  const root = await project({ "src/cart.py": "x = 1\n" })
  try {
    const text = renderVisibleTests(await listVisibleTests(root))
    assert.match(text, /No test files are visible/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// the plugin hook: off by default, and when on it gives the tool that returns the listing
import plugin from "../plugin/visible-tests.ts"

test("the plugin exposes visible_tests only when the config asks for it", async () => {
  const root = await project({ "tests/test_cart.py": "def test_total(): pass\n" })
  try {
    assert.deepEqual(await plugin.server({ directory: root }, {}), {})
    const hooks = await plugin.server({ directory: root }, { visibleTests: true })
    const out = await hooks.tool.visible_tests.execute({}, {})
    assert.match(out, /tests\/test_cart\.py/)
    assert.match(out, /def test_total/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
