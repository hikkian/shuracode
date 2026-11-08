"""LL4a: the rules server (mcp/rules.py). One case is a note; the second independent case queues the rule; /rule queues at once; a
declined rule is not proposed again; enabling renders the personal layer per model; the rule tables live in the memory database.
Run: python3 -m unittest tests.test_rules (no engine, no model)."""
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "mcp" / "rules.py"
spec = importlib.util.spec_from_file_location("shuracode_rules", SERVER)
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)


class RulesCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="ll4-")
        self.dir = Path(self.tmp.name)
        self.skills = self.dir / "skills"
        self.rules = R.Rules(self.dir / "lifelong.sqlite", self.skills, session="host:1:1")
        self.addCleanup(self.rules.close)
        self.addCleanup(self.tmp.cleanup)

    def other_session(self, name="host:2:2"):
        other = R.Rules(self.dir / "lifelong.sqlite", self.skills, session=name)
        self.addCleanup(other.close)
        return other


class Cases(RulesCase):
    def test_one_case_is_a_candidate_not_a_rule(self):
        msg = self.rules.case("run-tests-first", "a task says done", "run the project's tests and show the output", "ты сказал готово без тестов")
        self.assertIn("first case", msg)
        self.assertIn("[candidate]", self.rules.list())
        self.assertEqual(self.rules.status()["by_status"], {"candidate": 1})

    def test_a_second_case_in_the_same_session_only_refreshes_the_text(self):
        self.rules.case("run-tests-first", "a task says done", "run the tests", "once")
        msg = self.rules.case("run-tests-first", "a task is called done", "run the tests and show the output", "again")
        self.assertIn("Same session", msg)
        self.assertIn("[candidate]", self.rules.list())
        self.assertIn("run the tests and show the output", self.rules.list())
        self.assertEqual(len(self.rules._get("run-tests-first")["cases"]), 1)

    def test_a_second_independent_case_queues_the_rule(self):
        self.rules.case("run-tests-first", "a task says done", "run the tests", "first time")
        msg = self.other_session().case("run-tests-first", "a task says done", "run the tests", "second time")
        self.assertIn("queued", msg)
        self.assertIn("[queued]", self.rules.list())
        self.assertIn("2 cases", self.rules.list())
        self.assertIn("rule_queued", self.rules.show("run-tests-first"))

    def test_an_explicit_rule_command_queues_at_once(self):
        msg = self.rules.propose("ask-before-push", "a change is ready to push", "ask before any git push", "никогда не пушь сам")
        self.assertIn("queued", msg)
        self.assertIn("born_from: user_command", self.rules.show("ask-before-push"))

    def test_a_declined_rule_is_not_proposed_again_until_an_explicit_rule(self):
        self.rules.case("short-answers", "any answer", "answer in one line", "too long")
        self.assertIn("withdrawn", self.rules.withdraw("short-answers"))
        msg = self.other_session().case("short-answers", "any answer", "answer in one line", "too long again")
        self.assertIn("declined", msg)
        self.assertIn("[rejected]", self.rules.list())
        self.assertIn("queued", self.rules.propose("short-answers", "any answer", "answer in one line", "ok, do it"))

    def test_the_form_is_short_and_holds_no_secrets_or_control_markers(self):
        with self.assertRaises(R.RuleError):
            self.rules.case("long", "word " * 30, "do", "why")
        with self.assertRaises(R.RuleError):
            self.rules.case("long", "when", "word " * 45, "why")
        with self.assertRaises(R.RuleError):
            self.rules.case("creds", "deploying", "use password: hunter2hunter2", "why")
        self.rules.case("tpl", "a template", "never emit <|im_start|> raw", "why")
        self.assertNotIn("<|im_start|>", self.rules.show("tpl"))
        with self.assertRaises(R.RuleError):
            self.rules.case("кириллица", "w", "d", "y")
        with self.assertRaises(R.RuleError):
            self.rules.case("m", "w", "d", "y", model="claude")


class PersonalLayer(RulesCase):
    def test_enabling_renders_the_models_layer_and_only_enabled_rules_are_in_it(self):
        self.rules.propose("a", "a task says done", "run the tests", "why a")
        self.rules.propose("b", "editing Go", "use tabs", "why b")
        self.rules.propose("s", "planning", "write the plan first", "why s", model="sage")
        self.rules.set_status("a", "enabled")
        text = (self.skills / "tiel" / "harness.md").read_text()
        self.assertIn("- When a task says done: run the tests.", text)
        self.assertNotIn("tabs", text)
        self.assertNotIn("plan", text)
        self.assertTrue((self.skills / "tiel" / "skills").is_dir())
        self.assertFalse((self.skills / "sage" / "harness.md").exists(), "another model's layer is untouched")
        self.rules.set_status("a", "retired")
        self.assertEqual((self.skills / "tiel" / "harness.md").read_text(), "", "retiring empties the layer, the plugin then adds nothing")

    def test_the_enabled_count_is_limited(self):
        for i in range(R.MAX_ENABLED):
            self.rules.propose(f"r{i}", f"situation {i}", f"action {i}", "why")
            self.rules.set_status(f"r{i}", "enabled")
        self.rules.propose("one-more", "situation", "action", "why")
        with self.assertRaises(R.RuleError):
            self.rules.set_status("one-more", "enabled")

    def test_the_layer_file_is_private_and_rewritten_only_on_change(self):
        self.rules.propose("a", "x", "y", "z")
        self.rules.set_status("a", "enabled")
        target = self.skills / "tiel" / "harness.md"
        self.assertEqual(oct(os.stat(target).st_mode & 0o777), "0o600")
        before = os.stat(target).st_mtime_ns
        self.rules.render("tiel")
        self.assertEqual(os.stat(target).st_mtime_ns, before)


class SharedDatabase(RulesCase):
    def test_the_rule_tables_are_the_memory_stores_tables(self):
        """The same file as the memory: when Shura's lifelong_store.py is around, both open it without conflict."""
        sys.path.insert(0, str(ROOT / "mcp"))
        import memory as M
        mod = M.load_store_module()
        if mod is None:
            self.skipTest("gateway/lifelong_store.py not available")
        store = mod.Store(self.dir / "lifelong.sqlite", legacy_dir=None)
        self.addCleanup(store.close)
        store.save("k", "title", "body")
        self.rules.propose("a", "x", "y", "z")
        rows = sqlite3.connect(str(self.dir / "lifelong.sqlite")).execute("SELECT event FROM journal ORDER BY id").fetchall()
        self.assertEqual([r[0] for r in rows], ["saved", "rule_queued"])
        self.assertEqual(store.stats()["records"], 1)

    def test_actor_values_match_the_journal_constraint(self):
        self.rules.case("a", "x", "y", "z")
        self.rules.withdraw("a")
        actors = {r[0] for r in self.rules.db.execute("SELECT actor FROM journal")}
        self.assertTrue(actors <= {"user", "shura", "code"})


class Protocol(unittest.TestCase):
    def test_stdio_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = {**os.environ, "SHURA_LIFELONG_DB": str(Path(tmp) / "x.sqlite"), "SHURA_SKILLS_DIR": str(Path(tmp) / "skills"), "SHURACODE_SESSION": "s1"}
            msgs = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "rule_case", "arguments": {
                    "key": "tests-first", "when": "a task says done", "do": "run the tests", "why": "без тестов не готово"}}},
                {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "rule_list", "arguments": {}}},
                {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "rule_show", "arguments": {"key": "nope"}}},
                {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "rule_case", "arguments": {"key": "x", "when": 5}}},
                {"jsonrpc": "2.0", "id": 7, "method": "bogus"},
            ]
            out = subprocess.run([sys.executable, str(SERVER)], input="\n".join(json.dumps(m) for m in msgs) + "\n",
                                 capture_output=True, text=True, timeout=20, env=env).stdout
            replies = {r["id"]: r for r in map(json.loads, out.splitlines())}
            self.assertEqual(sorted(replies), [1, 2, 3, 4, 5, 6, 7])
            self.assertEqual(replies[1]["result"]["serverInfo"]["name"], "shuracode-rules")
            self.assertEqual([t["name"] for t in replies[2]["result"]["tools"]], ["rule_case", "rule_propose", "rule_list", "rule_show", "rule_withdraw"])
            self.assertFalse(replies[3]["result"]["isError"])
            self.assertIn("tests-first [candidate]", replies[4]["result"]["content"][0]["text"])
            self.assertTrue(replies[5]["result"]["isError"])
            self.assertTrue(replies[6]["result"]["isError"])
            self.assertEqual(replies[7]["error"]["code"], -32601)
            # a second server process is another session: the same case queues the rule
            msgs2 = [{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "rule_case", "arguments": {
                "key": "tests-first", "when": "a task says done", "do": "run the tests", "why": "опять"}}}]
            out = subprocess.run([sys.executable, str(SERVER)], input=json.dumps(msgs2[0]) + "\n", capture_output=True, text=True, timeout=20,
                                 env={**env, "SHURACODE_SESSION": "s2"}).stdout
            self.assertIn("queued", json.loads(out)["result"]["content"][0]["text"])

    def test_the_cli_enables_and_lists(self):
        with tempfile.TemporaryDirectory() as tmp:
            db, skills = str(Path(tmp) / "x.sqlite"), str(Path(tmp) / "skills")
            r = R.Rules(db, skills, session="cli")
            r.propose("a", "x", "y", "z")
            r.close()
            out = subprocess.run([sys.executable, str(SERVER), "--db", db, "--skills-dir", skills, "enable", "a"], capture_output=True, text=True, timeout=20)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertIn("enabled", out.stdout)
            out = subprocess.run([sys.executable, str(SERVER), "--db", db, "--skills-dir", skills, "list"], capture_output=True, text=True, timeout=20)
            self.assertIn("a [enabled]", out.stdout)
            self.assertIn("When x: y.", (Path(skills) / "tiel" / "harness.md").read_text())
            out = subprocess.run([sys.executable, str(SERVER), "--db", db, "--skills-dir", skills, "show", "zzz"], capture_output=True, text=True, timeout=20)
            self.assertEqual(out.returncode, 1)


if __name__ == "__main__":
    unittest.main()
