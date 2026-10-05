# Operations

## Output limits

`bin/shuracode` exports `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=32768` for the OpenCode engine. This is
an engine ceiling; the selected provider's `limit.output` remains authoritative when it is lower. The
shipped Tiel and Occamy entries in `config/shuracode.json.in` both remain at 16,384. To request up to
32,768 output tokens, raise both live provider limits as well; the consolidation report contains a
backup-first command for doing that. The install/update self-test checks that the launcher actually
passes the engine variable.

## Public benchmarks

The reproducible harness, task preparation, and safety requirements are documented in the [Shura
public benchmark guide](https://github.com/hikkian/shura/blob/main/bench/agentic-eval/external/README.md).

## Monitor

The Shura gateway serves a read-only live dashboard at `/monitor` on the gateway origin. The separate
`shura monitor` command opens the compact desktop window; it is not a ShuraCode slash command. The
dashboard is documented and implemented in the Shura repository.
