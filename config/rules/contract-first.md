# Contract first (implement and refactor tasks)

Before you change code for an implement or refactor task, do these steps in order:

1. Read the task description and every existing test that touches the code. If the `visible_tests` tool is available, call it.
2. Write down the contract: inputs, outputs, errors, and the edge cases. Edge cases include empty input, zero, negative numbers,
   Unicode text, duplicates, and ordering. Take each one from the description or the existing tests; do not invent behaviour.
3. Write or extend a test for those edge cases and run it. Before any change to the code, it should fail or be missing.
4. Only then implement. Run the tests again and show the real output.

If the description and the tests disagree, or a case is not stated anywhere, say so in your answer instead of choosing silently.
