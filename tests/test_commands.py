"""The command reference (/guide, docs/commands.json, docs/COMMANDS.md) must not drift from the code."""
import re
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import build_commands  # noqa: E402


class CommandReference(unittest.TestCase):
    def test_generated_files_are_up_to_date(self):
        r = subprocess.run([sys.executable, str(ROOT / "scripts" / "build_commands.py"), "--check"], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + "\nrun: python3 scripts/build_commands.py")

    def test_every_prompt_command_file_is_listed_with_a_russian_text(self):
        data = build_commands.build()
        ids = {i["id"]: i for i in data["items"]}
        for md in (ROOT / "commands").glob("*.md"):
            self.assertIn(md.stem, ids, f"commands/{md.name} is not in the reference")
            self.assertTrue(ids[md.stem]["ru"].strip())
            self.assertEqual(ids[md.stem]["name"], "/" + md.stem)

    def test_every_slash_command_the_plugin_registers_is_listed(self):
        plugin = (ROOT / "plugin" / "shuracode.tsx").read_text()
        names = set(re.findall(r'slash:\s*\{\s*name:\s*"([^"]+)"', plugin))
        listed = {i["name"] for i in build_commands.build()["items"]}
        self.assertTrue(names)
        for n in names:
            self.assertIn("/" + n, listed, f"plugin command /{n} is missing from docs/commands.src.json")

    def test_entries_are_complete(self):
        for i in build_commands.build()["items"]:
            self.assertTrue(i["en"].strip() and i["ru"].strip(), i["id"])
            self.assertIn(i["category"], build_commands.CATEGORY_ORDER, i["id"])
            self.assertIn(i["source"], build_commands.SOURCE_NOTE, i["id"])

    def test_terse_commands_are_marked_as_tiel_only(self):
        items = {i["id"]: i for i in build_commands.build()["items"]}
        for k in ("terse-on", "terse-off"):
            self.assertEqual(items[k].get("models"), ["tiel-coder"])


if __name__ == "__main__":
    unittest.main()
