"""Assert that every active model request includes all enabled ShuraCode plugin tools."""
import json
import sys
from pathlib import Path

EXPECTED_TOOL_NAMES = frozenset({"shura_task_card", "visible_tests"})


def assert_tool_requests(requests):
    if not requests:
        raise AssertionError("stand produced no primary model requests")
    for index, request in enumerate(requests, 1):
        tools = request.get("tools", [])
        names = {
            tool.get("function", tool).get("name")
            for tool in tools
            if isinstance(tool, dict) and isinstance(tool.get("function", tool), dict)
        }
        missing = EXPECTED_TOOL_NAMES - names
        if missing:
            raise AssertionError(f"request {index} is missing plugin tools: {sorted(missing)}; got {sorted(names)}")
    return len(requests)


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: python3 test_tool_registration.py <stand-requests.json>")
    payload = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    count = assert_tool_requests(payload)
    print(f"OK: {count} primary requests each include {', '.join(sorted(EXPECTED_TOOL_NAMES))}")


if __name__ == "__main__":
    main()
