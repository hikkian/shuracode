"""ShuraCode memory MCP server: storage rules and the stdio protocol. Run: python3 -m unittest discover -s tests

Two stores share the four tools: the legacy one-file-per-fact store (kept as the fallback) and, since LL1, Shura's knowledge store
(gateway/lifelong_store.py from shura-integration). The legacy tests run unchanged; the knowledge-store tests are skipped when that
module is not checked out next to this repository (SHURA_LIFELONG_STORE points at it otherwise)."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SERVER = Path(__file__).resolve().parent.parent / "mcp" / "memory.py"
spec = importlib.util.spec_from_file_location("shuracode_memory", SERVER)
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "memory"
        self.store = M.Store(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def index(self):
        return (self.root / "MEMORY.md").read_text()

    def test_save_writes_one_file_and_indexes_it(self):
        msg = self.store.save("Prefers Pytest!", "uses pytest, not unittest", "feedback", "Run tests with pytest -q.")
        self.assertIn("prefers-pytest", msg)
        self.assertTrue((self.root / "prefers-pytest.md").is_file())
        self.assertIn("## feedback\n- prefers-pytest: uses pytest, not unittest | Run tests with pytest -q.", self.index())
        self.assertIn("Run tests with pytest -q.", self.store.read("prefers-pytest"))

    def test_same_name_updates_instead_of_duplicating(self):
        self.store.save("editor", "uses vim", "user", "vim")
        msg = self.store.save("editor", "uses VS Code", "user", "VS Code with the Shura theme")
        self.assertIn("Updated", msg)
        self.assertIn("uses vim", msg)
        self.assertEqual(len(list(self.root.glob("*.md"))), 2)  # the memory + MEMORY.md
        self.assertNotIn("uses vim", self.index())

    def test_similar_memory_is_pointed_out(self):
        self.store.save("tests-cmd", "run tests with pytest quietly", "project", "pytest -q")
        msg = self.store.save("testing", "run tests with pytest in parallel", "project", "pytest -n auto")
        self.assertIn("Similar memories exist: tests-cmd", msg)

    def test_secrets_are_refused(self):
        for content in ("password: hunter2hunter2", "ghp_" + "a" * 36, "-----BEGIN OPENSSH PRIVATE KEY-----",
                        "token = 1234567890:" + "A" * 35, "пароль: qwerty123"):
            with self.subTest(content=content[:20]), self.assertRaises(M.MemoryError):
                self.store.save("creds", "login details", "reference", content)
        self.assertFalse((self.root / "creds.md").exists())

    def test_limits(self):
        with self.assertRaises(M.MemoryError):
            self.store.save("big", "too long", "project", "x" * (M.MAX_CONTENT + 1))
        with self.assertRaises(M.MemoryError):
            self.store.save("t", "bad type", "misc", "x")
        with self.assertRaises(M.MemoryError):
            self.store.save("кириллица", "name needs latin", "user", "x")

    def test_delete_and_did_you_mean(self):
        self.store.save("deploy-steps", "how to deploy", "project", "make deploy")
        with self.assertRaises(M.MemoryError) as e:
            self.store.read("deploy")
        self.assertIn("deploy-steps", str(e.exception))
        self.store.delete("deploy-steps")
        self.assertIn("(empty", self.index())

    def test_search_ranks_and_handles_cyrillic(self):
        self.store.save("indent", "отступы: табы, не пробелы", "feedback", "Всегда табы в Go-коде.")
        self.store.save("db", "project uses postgres 17", "project", "local db on port 5433")
        self.assertIn("indent", self.store.search("табы"))
        self.assertTrue(self.store.search("postgres port").startswith("- db"))
        self.assertIn("Nothing found", self.store.search("kubernetes"))
        self.assertEqual(self.store.search("").count("\n"), 1)  # empty query lists both

    def test_long_memories_are_not_inlined(self):
        self.store.save("arch", "gateway design notes", "project", "word " * 100)
        self.assertIn("- arch: gateway design notes\n", self.index())

    def test_hand_edited_files_are_indexed(self):
        self.root.mkdir(parents=True)
        (self.root / "note.md").write_text("Just a plain note without frontmatter.\n")
        self.store.reindex()
        self.assertIn("note: Just a plain note", self.index())

    def test_index_not_rewritten_when_unchanged(self):
        self.store.save("a", "first", "user", "x")
        before = (self.root / "MEMORY.md").stat().st_mtime_ns
        self.store.reindex()
        self.assertEqual((self.root / "MEMORY.md").stat().st_mtime_ns, before)


STORE_MODULE = M.load_store_module()


def run_server(tmp, msgs, **env):
    out = subprocess.run([sys.executable, str(SERVER)], input="\n".join(json.dumps(m) for m in msgs) + "\n",
                         capture_output=True, text=True, timeout=10,
                         env={**os.environ, "SHURACODE_MEMORY_DIR": tmp, **env}).stdout
    return {r["id"]: r for r in map(json.loads, out.splitlines())}


@unittest.skipIf(STORE_MODULE is None, "gateway/lifelong_store.py is not available: legacy store only")
class SqlStoreTest(unittest.TestCase):
    """LL1: the same tools over the knowledge store. Everything the model sees carries a passport; deletion is soft."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "memory"
        self.root.mkdir()
        self.store = M.SqlStore(STORE_MODULE, db_path=Path(self.tmp.name) / "lifelong.sqlite", legacy_dir=self.root)

    def tearDown(self):
        self.store.store.close()
        self.tmp.cleanup()

    def test_save_shows_passport_and_regenerates_the_legacy_index(self):
        msg = self.store.save("Prefers Pytest!", "uses pytest, not unittest", "feedback", "Run tests with pytest -q.")
        self.assertIn("Saved memory 'prefers-pytest'", msg)
        self.assertIn("Passport: (procedure, you, ", msg)
        index = (self.root / "MEMORY.md").read_text()
        self.assertIn("## feedback", index)
        self.assertIn("prefers-pytest", index)
        self.assertIn("passport: (procedure, you, ", self.store.read("prefers-pytest"))

    def test_same_name_updates_and_the_old_text_is_reported(self):
        self.store.save("editor", "uses vim", "user", "vim")
        msg = self.store.save("editor", "uses VS Code", "user", "VS Code with the Shura theme")
        self.assertIn("Updated memory 'editor' (it said: uses vim)", msg)
        self.assertNotIn("uses vim", (self.root / "MEMORY.md").read_text())

    def test_delete_is_soft_and_the_record_leaves_the_index_and_the_search(self):
        self.store.save("deploy-steps", "how to deploy", "project", "make deploy")
        msg = self.store.delete("deploy-steps")
        self.assertIn("Forgot memory 'deploy-steps'", msg)
        self.assertIn("restore", msg)
        self.assertIn("Nothing found", self.store.search("deploy"))
        self.assertNotIn("deploy-steps", (self.root / "MEMORY.md").read_text())
        with self.assertRaises(M.MemoryError):
            self.store.read("deploy-steps")
        self.store.store.restore("deploy-steps")
        self.assertIn("make deploy", self.store.read("deploy-steps"))

    def test_secrets_are_refused_and_control_tokens_escaped(self):
        with self.assertRaises(M.MemoryError) as e:
            self.store.save("creds", "login details", "reference", "password: hunter2hunter2")
        self.assertIn("refused", str(e.exception))
        self.store.save("tpl", "a template note", "project", "the marker <|im_start|> opens a turn")
        self.assertNotIn("<|im_start|>", self.store.read("tpl"))

    def test_search_shows_passports_and_handles_cyrillic(self):
        self.store.save("indent", "отступы: табы, не пробелы", "feedback", "Всегда табы в Go-коде.")
        self.store.save("db", "project uses postgres 17", "project", "local db on port 5433")
        out = self.store.search("табы")
        self.assertIn("- indent (feedback) (procedure, you, ", out)
        self.assertTrue(self.store.search("postgres port").startswith("- db (project)"))
        self.assertEqual(self.store.search("").count("\n"), 1)

    def test_legacy_files_are_imported_once(self):
        (self.root / "old-note.md").write_text("---\nname: old-note\ndescription: an old legacy note\ntype: project\nupdated: 2026-01-01\n---\n\nStill true.\n")
        store = M.SqlStore(STORE_MODULE, db_path=Path(self.tmp.name) / "lifelong.sqlite", legacy_dir=self.root)
        self.assertIn("Still true.", store.read("old-note"))
        self.assertIn("you (legacy)", store.read("old-note"))
        store.store.close()
        self.assertTrue((self.root / "old-note.md").exists(), "the legacy file is kept")


class ProtocolTest(unittest.TestCase):
    @unittest.skipIf(STORE_MODULE is None, "gateway/lifelong_store.py is not available")
    def test_stdio_roundtrip_over_the_knowledge_store(self):
        with tempfile.TemporaryDirectory() as tmp:
            msgs = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "save", "arguments": {
                    "name": "lang", "description": "answers in Russian", "type": "user", "content": "Отвечать по-русски."}}},
                {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "read", "arguments": {"name": "lang"}}},
                {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "delete", "arguments": {"name": "lang"}}},
            ]
            replies = run_server(tmp, msgs, SHURACODE_MEMORY_LEGACY="")
            self.assertEqual(sorted(replies), [1, 2, 3, 4, 5])
            self.assertEqual(replies[1]["result"]["serverInfo"]["version"], "1.1")
            self.assertEqual([t["name"] for t in replies[2]["result"]["tools"]], ["save", "read", "search", "delete"])
            self.assertIn("Passport: (preference, you, ", replies[3]["result"]["content"][0]["text"])
            self.assertIn("Отвечать по-русски.", replies[4]["result"]["content"][0]["text"])
            self.assertIn("Forgot memory 'lang'", replies[5]["result"]["content"][0]["text"])
            self.assertTrue((Path(tmp) / "lifelong.sqlite").is_file(), "the database lives next to an explicit memory folder")
            self.assertTrue((Path(tmp) / "MEMORY.md").is_file())
            self.assertFalse((Path(tmp) / "lang.md").exists(), "no legacy file is written in store mode")

    def test_stdio_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            msgs = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "save", "arguments": {
                    "name": "lang", "description": "answers in Russian", "type": "user", "content": "Отвечать по-русски."}}},
                {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "read", "arguments": {"name": "nope"}}},
                {"jsonrpc": "2.0", "id": 5, "method": "bogus"},
            ]
            replies = run_server(tmp, msgs, SHURACODE_MEMORY_LEGACY="1")
            self.assertEqual(sorted(replies), [1, 2, 3, 4, 5])  # no reply to the notification
            self.assertEqual(replies[1]["result"]["protocolVersion"], "2025-06-18")
            self.assertEqual([t["name"] for t in replies[2]["result"]["tools"]], ["save", "read", "search", "delete"])
            self.assertFalse(replies[3]["result"]["isError"])
            self.assertTrue(replies[4]["result"]["isError"])
            self.assertEqual(replies[5]["error"]["code"], -32601)
            self.assertIn("Отвечать по-русски.", (Path(tmp) / "lang.md").read_text())
            self.assertEqual(oct((Path(tmp) / "lang.md").stat().st_mode & 0o777), "0o600")


if __name__ == "__main__":
    unittest.main()
