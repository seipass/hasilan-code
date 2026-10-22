# Session import formats

Checked 2026-10-22 against first-party documentation and source. These are local
conversation formats, not portable execution state. Examples below are synthetic
parser inputs; unrelated producer fields are omitted. No private histories,
credentials, third-party prompts, implementation code, or fixtures were used.

| Source | Checked revision |
| --- | --- |
| Codex | [`9a8a85bc539325f2819dd0717f88b6ba6286495e`](https://github.com/openai/codex/tree/9a8a85bc539325f2819dd0717f88b6ba6286495e) |
| Claude Agent SDK Python | [`6b4a557e9f395934bd16e78b04e0f09833eb387e`](https://github.com/anthropics/claude-agent-sdk-python/tree/6b4a557e9f395934bd16e78b04e0f09833eb387e), package 0.2.172 |
| Grok Build | [`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) |
| OpenCode | [`v1.4.14`](https://github.com/anomalyco/opencode/tree/c90281c0d6e6a92309d8d326e732931b92739cdf), [`v1.18.18`](https://github.com/anomalyco/opencode/tree/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d), current [`e965774fa0e2a8ffb27bf02827a2c3c6a8c0f45b`](https://github.com/anomalyco/opencode/tree/e965774fa0e2a8ffb27bf02827a2c3c6a8c0f45b) |
| Oh My Pi | [`0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0`](https://github.com/can1357/oh-my-pi/tree/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0), package 18.12.6 |
| DeepSeek Harness | [`687f282e8625c6b8d11ff58211a90524be2e4317`](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317) |

## Codex

The root is `CODEX_HOME` or `~/.codex`. Rollouts live under
`sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`; archived files use
`archived_sessions`. Reverts can add an extra rollout ID to the filename.
Current storage also reads `.jsonl.zst`; a plain sibling takes precedence.
Sources: [home resolution](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/utils/home-dir/src/lib.rs),
[recorder](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/rollout/src/recorder.rs),
[compression](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/rollout/src/compression.rs).

Each line has `timestamp`, optional `ordinal`, `type`, and `payload`.
`session_meta.payload` contains identity and cwd. Conversation items are
`response_item.payload`, with `message`/`role`/`content`; content uses
`input_text`, `output_text`, or media types. Tool records include
`function_call` (`name`, JSON-string `arguments`, `call_id`) and
`function_call_output` (`call_id`, string or structured `output`). Avoid counting
presentation `event_msg` copies as additional messages. Sources:
[wire envelope](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/history/src/rollout_payload.rs),
[response items](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/protocol/src/models.rs).

```jsonl
{"timestamp":"2026-10-01T00:00:00Z","type":"session_meta","payload":{"id":"example","cwd":"/work"}}
{"timestamp":"2026-10-01T00:00:01Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Inspect the parser."}]}}
{"timestamp":"2026-10-01T00:00:02Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"I found the parser."}]}}
```

Compaction carries `payload.message` and optional `replacement_history`.
Replacement history supersedes prior model context. Older compactions can have
only summary text. `event_msg.payload.type = thread_rolled_back` carries
`num_turns`; replay must remove those trailing turns. New metadata can describe
a fork's inherited prefix through `history_base` and an exclusive ordinal;
a standalone file is consequently not guaranteed to contain every inherited
record. Sources: [history types](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/history/src/lib.rs),
[reconstruction](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/core/src/session/rollout_reconstruction.rs),
[metadata and rollback event](https://github.com/openai/codex/blob/9a8a85bc539325f2819dd0717f88b6ba6286495e/codex-rs/protocol/src/protocol.rs).

## Claude Code

CLI transcripts are `~/.claude/projects/<project>/<session-id>.jsonl`, relocated
by `CLAUDE_CONFIG_DIR`. The normal project name replaces non-alphanumeric cwd
characters with hyphens; long names receive a hash. Since CLI 2.1.234,
`CLAUDE_CODE_PROJECT_DIR_NAME` can choose the project directory when
`CLAUDE_CONFIG_DIR` is also set. Discover actual project directories rather than
assuming only the calculated slug. `/export` is readable text, not this JSONL
format. The official documentation explicitly calls the entry format internal.
Source: [session storage and exports](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored).

```jsonl
{"type":"user","uuid":"u1","parentUuid":null,"sessionId":"example","cwd":"/work","timestamp":"2026-10-01T00:00:00Z","message":{"role":"user","content":"Inspect the parser."}}
{"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":"example","timestamp":"2026-10-01T00:00:01Z","message":{"role":"assistant","content":[{"type":"text","text":"I found the parser."}]}}
```

Messages carry `uuid` and `parentUuid`; progress, system, and attachment records
can connect the chain. The official SDK chooses the latest main-chain
user/assistant leaf by file position, preferring entries without `isSidechain`,
`teamName`, or `isMeta`, then walks parents and reverses the result. It does not
follow `logicalParentUuid` across compact boundaries and retains
`isCompactSummary` messages. Parallel tool blocks can share `message.id` while
their result entries branch; the SDK recovers sibling blocks/results belonging
to the selected response. Tool blocks use Anthropic `tool_use` and
`tool_result` shapes. Source: [first-party transcript reader](https://github.com/anthropics/claude-agent-sdk-python/blob/6b4a557e9f395934bd16e78b04e0f09833eb387e/src/claude_agent_sdk/_internal/sessions.py).

## Grok Build

Root: `GROK_HOME` or `~/.grok`. Sessions use
`sessions/<encoded-cwd>/<session-id>/`. Cwd is URL encoded; names exceeding
255 encoded bytes become a slug plus hash, with original cwd in `.cwd`.
Sources: [home](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-dirs/src/lib.rs),
[cwd paths](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-config/src/paths.rs).

`summary.json` holds `info: {id,cwd}`, `session_summary`, optional
`generated_title`, timestamps, model, counters, `chat_format_version`, and
optional `parent_session_id`. Current chat format 1 uses `ConversationItem`
rows; format 0 uses legacy OpenAI chat messages. Sources:
[summary](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/persistence.rs),
[conversation types](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-sampling-types/src/conversation.rs).

```jsonl
{"type":"user","content":[{"type":"text","text":"Inspect the parser."}]}
{"type":"assistant","content":"Reading it.","tool_calls":[{"id":"c1","name":"read_file","arguments":"{\"path\":\"parser.ts\"}"}]}
{"type":"tool_result","tool_call_id":"c1","content":"Parser source."}
```

`updates.jsonl` stores timestamped ACP notifications. Example:

```json
{"timestamp":1790812800,"method":"session/update","params":{"sessionId":"example","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Inspect the parser."},"_meta":{"promptIndex":0}}}}
```

Agent text uses `agent_message_chunk`. Concatenate chunks without inventing
extra turns. `_meta.promptIndex` changes identify new prompts; after numbering
first appears, unnumbered runs are injections. `_meta.hostTurn` excludes host
updates from prompt counting. A rewind on method `_x.ai/session/update` has
`sessionUpdate: rewind_marker` and `target_prompt_index: N`: discard prompt N
and everything after it. Filter discarded branches before rebuilding messages.
Source: [envelope, turn tracker, rewind filter](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/mod.rs).

Compaction updates use that same extension method and fields
`sessionUpdate: compaction_checkpoint`, `checkpoint_id`,
`prompt_index_at_compaction`, `checkpoint_file`, `schema_version: 1`, and
optional `auto_continue: {prompt_text}`. The referenced session-local JSON file
contains `compacted_history: ConversationItem[]`; install it as the new base,
then replay later updates. Schema versions above 1 are unsupported. An
unreadable final required checkpoint cannot be silently replaced with older
history. Sources: [checkpoint schema](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/notification.rs),
[replay](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/helpers/replay.rs).

`chat_history.jsonl` is the resume cache. The loader rebuilds it when absent or
empty but does not establish freshness against a nonempty update stream.
Using it as a fallback should therefore be explicit. Source:
[JSONL loader](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/jsonl/mod.rs).

## OpenCode

Current data root is `XDG_DATA_HOME/opencode`, otherwise
`~/.local/share/opencode`, including Windows. `OPENCODE_DB` selects an absolute
database path or a filename relative to that root; `:memory:` has no file.
Default is `opencode.db`; nonstandard release channels can use
`opencode-<channel>.db`. `OPENCODE_CONFIG_DIR` is not the session data root.
Sources: [roots](https://github.com/anomalyco/opencode/blob/e965774fa0e2a8ffb27bf02827a2c3c6a8c0f45b/packages/util/src/global-roots.ts),
[database filename](https://github.com/anomalyco/opencode/blob/e965774fa0e2a8ffb27bf02827a2c3c6a8c0f45b/packages/cli/src/database-path.ts).

There are overlapping schemas. Detect tables and rows, not only version labels:

| Shape | Session metadata | Conversation |
| --- | --- | --- |
| Legacy, checked v1.4.14 | `session` | `message` plus `part` |
| Modern, checked v1.18.18 | `session` | `session_message` |
| Current main | `session_v2` | `session_message` |

Legacy `message` rows store `id`, `session_id`, timestamps, and JSON `data`
without IDs. `part` stores `id`, `message_id`, `session_id`, and JSON `data`
without IDs. Restore those identifiers; sort messages by `time_created,id` and
parts by `id`. Text parts have `type,text`; tool parts have
`type: tool`, `callID`, `tool`, and `state` containing input plus output/error.
Sources: [legacy tables](https://github.com/anomalyco/opencode/blob/c90281c0d6e6a92309d8d326e732931b92739cdf/packages/opencode/src/session/session.sql.ts),
[legacy messages](https://github.com/anomalyco/opencode/blob/c90281c0d6e6a92309d8d326e732931b92739cdf/packages/opencode/src/session/message-v2.ts).

Modern `session_message` rows have `id,session_id,type,seq,time_created,
time_updated,data`. Reconstruct `{...data,id,type}` and order by `seq`.
`data` is already the message projection; replaying the event table is
unnecessary. `user` has `text` and attachments; `assistant` has `content`
blocks. Tools are assistant content with `id,name,state`; terminal results
live in `state.content`. Sources:
[v1.18.18 tables](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/session/sql.ts),
[current tables](https://github.com/anomalyco/opencode/blob/e965774fa0e2a8ffb27bf02827a2c3c6a8c0f45b/packages/core/src/session/sql.ts),
[current message schema](https://github.com/anomalyco/opencode/blob/e965774fa0e2a8ffb27bf02827a2c3c6a8c0f45b/packages/schema/src/session-message.ts).

Exports are JSON `{info,messages}`. Legacy message elements are `{info,parts}`;
modern elements are type-tagged messages directly. Current cwd is
`info.location.directory`; older exports use `info.directory`. Sources:
[legacy exporter](https://github.com/anomalyco/opencode/blob/c90281c0d6e6a92309d8d326e732931b92739cdf/packages/opencode/src/cli/cmd/export.ts),
[current exporter](https://github.com/anomalyco/opencode/blob/e965774fa0e2a8ffb27bf02827a2c3c6a8c0f45b/packages/core/src/session/transfer.ts).

```json
{"info":{"id":"ses_example","location":{"directory":"/work"}},"messages":[{"id":"msg_u","type":"user","text":"Inspect the parser.","files":[],"agents":[],"time":{"created":1790812800000}},{"id":"msg_a","type":"assistant","content":[{"type":"text","text":"I found the parser."}],"time":{"created":1790812801000,"completed":1790812802000}}]}
```

The latest completed modern compaction bounds model context. Keep its summary
and later messages; older compactions have `recent` and no status. Current
`metadata.keepID` references retained earlier text, and `native.messages`
(formerly `providerContext.messages`) can hold provider-native replacement
history. Source: [history reconstruction](https://github.com/anomalyco/opencode/blob/e965774fa0e2a8ffb27bf02827a2c3c6a8c0f45b/packages/core/src/session/history.ts),
[older history](https://github.com/anomalyco/opencode/blob/31406ccc51b4bd2a4e1e086b2bcaa5f7f804f26d/packages/core/src/session/history.ts),
[stored shape changes](https://github.com/anomalyco/opencode/blob/e965774fa0e2a8ffb27bf02827a2c3c6a8c0f45b/packages/schema/src/session-legacy.ts).

Forks already copy history into child rows; do not add the parent again.
A staged `revert.messageID` cuts context before that message; committed reverts
delete rows at and after its sequence. Source:
[fork and revert projections](https://github.com/anomalyco/opencode/blob/e965774fa0e2a8ffb27bf02827a2c3c6a8c0f45b/packages/core/src/session/projector.ts).

## Oh My Pi

Default root is `~/.omp/agent/sessions`. `PI_CONFIG_DIR` changes `.omp`;
`PI_CODING_AGENT_DIR` overrides the agent directory. Named profiles use
`profiles/<profile>/agent/sessions`, selected by `OMP_PROFILE` or `PI_PROFILE`.
Migrated XDG layouts use `<XDG_DATA_HOME>/omp/sessions` (profile-specific when
applicable). The actual resolver checks migration directories. Source:
[directory resolver](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/utils/src/dirs.ts).

Sessions are cwd-grouped JSONL files named `<timestamp>_<id>.jsonl`. Current
cwd grouping can be home-relative, temp-relative, or absolute; read the header
cwd rather than reversing the directory name. Sources:
[session paths](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/session/session-paths.ts),
[session manager](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/session/session-manager.ts).

Format version is 3. A fixed-width `type: title` slot can precede the
`type: session` header. Entries have `id,parentId,timestamp`; `message` entries
embed agent messages. The last entry selects the active leaf unless it carries
`activeLeafId`; null clears it. Follow parents only from that leaf.
Compaction uses `summary` and `firstKeptEntryId`; branch summaries and
`reset_boundary` also affect rebuilt context. Sources:
[entry schemas and leaf selection](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/session/session-entries.ts),
[context reconstruction](https://github.com/can1357/oh-my-pi/blob/0b5c27ab24719c86a5986b95ee55f4e75bc1aaa0/packages/coding-agent/src/session/session-context.ts).

```jsonl
{"type":"session","version":3,"id":"example","timestamp":"2026-10-01T00:00:00Z","cwd":"/work"}
{"type":"message","id":"u1","parentId":null,"timestamp":"2026-10-01T00:00:01Z","message":{"role":"user","content":"Inspect the parser.","timestamp":1790812801000}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-10-01T00:00:02Z","message":{"role":"assistant","content":[{"type":"text","text":"I found the parser."}],"timestamp":1790812802000}}
```

## DeepSeek Harness

The first-party base profile configures `dshHomePath('sessions')`; home resolves
from `DSH_HOME` or `~/.dsh`. The persistence plugin also accepts an explicit
root. Sources: [base profile](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml),
[home resolver](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/util/home-paths/src/index.ts).

Layout: `<root>/--<normalized-cwd>--/<encoded-session-id>/session.vN.jsonl.zstd`;
missing cwd uses `_no-cwd`. Raw compression mode omits `.zstd`. Version zero is
`session.jsonl`; subsequent generations use `.vN`. Select the numerically
highest canonical generation and refuse unsupported future versions, without
falling back to an older copy. Sources:
[layout and headers](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/src/format.ts),
[generation names](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-format/src/filename.ts),
[persistence behavior](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/subsystems/persistence.md).

Current code declares version 4; some README examples still label v3 current.
The header has `type: session`, `version,id,createdAt,isSeeded,delegationDepth`,
optional cwd and lineage. Events contain `type,seq,time,data` plus a
`surfaceOp` for model-visible messages. `user/message.data` is the message
directly; assistant/system/tool-result events use `data.message`.
`tool/call` is log-only; its call also appears in assistant content, so avoid
duplicates. Source: [event types](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/types.ts).

```jsonl
{"type":"session","version":4,"id":"example","createdAt":1790812800000,"cwd":"/work","isSeeded":false,"delegationDepth":0}
{"type":"user/message","seq":0,"time":1790812801000,"surfaceOp":"append","data":{"id":"u1","role":"user","source":{"kind":"user"},"content":[{"type":"text","text":"Inspect the parser."}]}}
{"type":"assistant/message","seq":1,"time":1790812802000,"surfaceOp":"append","data":{"turn":0,"step":0,"message":{"id":"a1","role":"assistant","source":{"kind":"model","provider":"example","model":"example"},"content":[{"type":"text","text":"I found the parser."}]},"stream":[]}}
```

Fold visible nodes in sequence. `surfaceOp: append` adds the event;
`surfaceOp: {op: replace,startSeq,endSeq}` replaces the inclusive range of
currently visible nodes with the new event, including compaction summaries.
`sourceEventSeqs` can encode consecutive runs as `[start,end]` elements.
Forks contain inherited events already; header `parentSession` and `isSeeded`
describe lineage, and the last tagged `session/end-seed` with
`data.inherited: true` identifies the cut. Unknown non-ignorable event types
must refuse reconstruction. Sources:
[surface fold](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/surface.ts),
[physical encoding](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/README.md).

Compression is standard concatenated, independent checksummed Zstandard
frames: a header frame followed by one per append batch. DeepSeek structurally
locates each frame, then its public fallback independently calls
`zstdDecompressSync` on each frame slice. A single Node decompression call on
the concatenated artifact can return only the header frame. Sources:
[frame scanner](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/src/zstd.ts),
[public decoder](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/src/zstd-public-decoder.ts).

An independent public-API alternative, verified against Node 24.19.0 source,
is repeated `zstdDecompressSync(remaining, {info: true, maxOutputLength})`:
consume its `buffer`, advance the compressed offset by `engine.bytesWritten`,
and repeat until exhausted. Validate a positive safe byte count no greater
than the remaining input and cap total decoded output. `info` also works with
the asynchronous convenience method. Keep `rejectGarbageAfterEnd` false: true
rejects data after the first compressed stream. Sources:
[Node Zstd options](https://github.com/nodejs/node/blob/v24.19.0/doc/api/zlib.md#class-zstdoptions),
[Node consumed-byte accounting and convenience results](https://github.com/nodejs/node/blob/v24.19.0/lib/zlib.js#L414).

Byte accounting alone does not classify a torn final frame. DeepSeek's scanner
distinguishes complete frame ranges from an incomplete final frame; it uses
normal checksum-validating decompression on complete frames and
`finishFlush: ZSTD_e_flush` only on the known incomplete suffix. Complete
corruption must not be silently treated as recoverable tail data. Source:
[frame and prefix decoding](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/src/zstd.ts).

## Import boundary

Implementation recommendation: retain source ID, title, cwd, and a revision;
project selected conversation text into a new local session. Render tool
records and source instructions as inert quoted context. Omit unsupported
media with an explicit preview warning. Revalidate the revision on import and
never mutate source files. Query SQLite read-only in a consistent transaction;
detect modern tables before legacy fallback. Synthetic tests should cover
discarded branches, compaction replacement, unknown versions, torn tails,
missing checkpoints, and duplicate cached representations.
