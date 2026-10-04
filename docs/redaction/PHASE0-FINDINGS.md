# Redaction — Phase 0 findings

Research note for the inline secret redaction fork. Read-only survey of
`src/`, `cli/`, and `hooks/` at upstream `7e06519` (v1.6.0 + fixes). This
note answers the six Phase 0 questions and records the choke-point decision.

## Pipeline as it exists today

```
SessionStart hook (hooks/hooks.json)
  └─ cli/episodic-memory.js sync --background
       └─ dist/sync-cli.js
            ├─ exportOpencodeSessions()      opencode.db → <config>/opencode-transcripts/*.jsonl
            └─ syncConversations(src, archive)   for each source dir
                 ├─ copyIfNewer(src → archive)   byte-for-byte copy
                 ├─ parseConversation(archive)   → exchanges
                 │    ├─ generateExchangeEmbedding(user, assistant, toolNames)
                 │    └─ insertExchange()        → SQLite exchanges + tool_calls + vec_exchanges
                 └─ summarizeConversation(exchanges, sessionId) → <archive>-summary.txt

episodic-memory index  (cli/index-conversations.js → dist/index-cli.js → indexer.ts)
  └─ copyFileSync(src → archive), parseConversation(**src**), embed, insert, summarize

episodic-memory import-cursor-history  (cursor-legacy.ts)
  └─ state.vscdb → <config>/cursor-legacy-export/*.jsonl (a sync source dir)

episodic-memory index --repair  (verify.ts) parses archive files, re-embeds, re-summarizes
```

## Answers

### 1. Where does sync copy into the archive? Byte-for-byte or parsed first?

Byte-for-byte. `copyIfNewer()` in `src/sync.ts` does `fs.copyFileSync` to
`<dest>.tmp.<pid>` then `renameSync`, then stamps the source mtime on the
destination (the mtime is the "is the archive current?" check on the next
run). Parsing happens **after** the copy, and in `sync.ts` it parses the
archive file, not the source.

There are three more copy sites, all in `src/indexer.ts`
(`indexConversations`, `indexSession`, `indexUnprocessed`). They also use
`fs.copyFileSync`, but they **parse the source path**, not the archive. That
matters: redacting the archive copy alone would not reach the index on the
`episodic-memory index` path.

### 2. One shared parse path or one per source?

One entry point, `parseConversation()` in `src/parser.ts`. It sniffs the file
and dispatches to one of five per-harness parsers (Claude, Codex, Cursor,
opencode, OMP). More important for redaction: every harness reaches the
archive through the same copy step. opencode and legacy Cursor are first
exported from their SQLite stores into staging JSONL directories under the
plugin's config dir (`opencode-transcripts/`, `cursor-legacy-export/`), and
those staging directories are then ordinary sync sources.

The staging exports are plugin-owned plaintext copies outside any harness's
own retention, so they count as a fourth sink even though the spec's table
doesn't list them.

### 3. Where is exchange text written to SQLite, and where is the embedding input built?

- `insertExchange()` in `src/db.ts` writes `exchanges.user_message`,
  `exchanges.assistant_message`, `tool_calls.tool_input` (JSON-stringified
  tool input), and `tool_calls.tool_result`. Text search (`search.ts`) runs
  `LIKE` over `user_message`/`assistant_message`.
- Embedding input is `generateExchangeEmbedding(userMessage, assistantMessage,
  toolNames)` in `src/embeddings.ts`, called from `sync.ts`, `indexer.ts`,
  `verify.ts`, and `embedding-migration.ts`. The migration re-embeds from the
  **SQLite rows**, so it inherits whatever text is already stored.

All of these are built from the parsed `ConversationExchange` objects, so a
clean parse input gives clean SQLite text and clean embedding input.

### 4. Where does the summarizer get its input?

Usually from the parsed exchanges (`formatConversationText(exchanges)`), and
`sync.ts` parses those from the archive. **But two paths bypass the archive
entirely:**

- **Claude session resume.** For Claude conversations with at most 15
  exchanges, `summarizeConversation()` calls the Agent SDK with
  `resume: sessionId`. The SDK loads the **source** transcript from
  `~/.claude/projects/...` and sends it to the model. The prompt carries no
  transcript text on this path.
- **Codex fork.** For Codex conversations, `callCodex()` runs
  `thread/fork` on the **source** rollout via `codex app-server`. Note that
  `getCodexSessionId()` derives the id from the exchanges when no
  `sessionId` is passed, so passing `undefined` is not enough to stop it.

Both paths send unredacted source content to a model endpoint no matter what
the archive holds. Redaction therefore has to turn resume and fork off and
force the transcript-text path, which is built from redacted exchanges.

### 5. How does the `DO NOT INDEX THIS CHAT` marker work?

`shouldSkipConversation()` in `src/sync.ts` streams a file in 1 MiB chunks
and looks for any of three markers. If the read fails, it fails closed
(skips the file). Sync calls it on the **archive** path, after the copy, to
gate both indexing and summary queueing. So an excluded conversation is
still copied to the archive; only the index and the summarizer skip it.

The hint holds: the archive file is the reference that every downstream
stage of `sync` reads. The marker check sits right after the archive write,
and that is where the redaction hook belongs.

### 6. Must the archive stay valid harness JSONL?

Yes, on two counts:

- **Structure.** `show.ts` (CLI `show`, MCP `read`) runs `JSON.parse` on every
  line, and one invalid line throws. Harness detection in both `parser.ts`
  and `show.ts` keys off line shapes (`type`, `payload`, `role`, ...).
- **Line numbers.** `exchanges.line_start`/`line_end` index into archive lines.
  MCP `read` takes `startLine`/`endLine`, and incremental indexing resumes
  from `MAX(line_end)` (#152). Redaction must keep **exactly one output line
  per input line**.

So redaction parses each line as JSON, redacts string values, and
re-serializes only the lines that changed. Unchanged lines stay
byte-identical. A line that isn't valid JSON (for example, a partially
written last line) is redacted as raw text, because it was already invalid.

## Decision: choke point (b), the archive write

Option (a) doesn't exist. No single function sees every source *before* the
archive write. The only place every harness converges is the copy into the
archive itself.

So the hook goes at the **archive write**, which becomes a redacting copy
(`copyFileRedacted()` in `src/redaction.ts`), and every downstream stage
reads from the archive. Three supporting changes are needed to make
"downstream reads the archive" actually true:

1. **`indexer.ts` parses the archive, not the source.** All three copy sites
   switch to the redacting copy. They now refresh the archive when the source
   is newer, as `sync` already does, so parsing the archive loses no data.
2. **Summarizer resume and fork are disabled while redaction is active.**
   `summarizeConversation()` gains an `allowResume` option. `sync.ts`,
   `indexer.ts`, and `verify.ts` pass `allowResume: false` when a redactor is
   active, which forces the transcript-text path built from redacted
   exchanges. Trade-off: Codex-only users then summarize through the Claude
   transcript path. If no Claude auth is available, that writes a retryable
   error sentinel. `EPISODIC_MEMORY_SKIP_SUMMARIES=1` turns summaries off
   entirely.
3. **Staging exports are redacted at write time.** The opencode export
   (`opencode-sync.ts`) and the Cursor legacy export (`cursor-legacy.ts`) run
   each JSONL line through the same `redactJsonlLine()` before writing. They
   are plugin-owned copies, and the archive hook alone would leave a
   plaintext copy beside it.

Everything else (SQLite text, `tool_calls`, embeddings, summaries, `show`,
MCP `read`, embedding migration) reads the archive or the rows built from
it, so it inherits clean text with no further hooks.

## SOPS

Decrypted SOPS output (`sops -d`, `sops exec-env`) **drops** the `sops:`
metadata block and comes out as plain YAML, JSON, or dotenv. Its shape is
not reliable. There is no dedicated SOPS rule. Coverage comes from the
value-level rules (storage keys, client secrets, connection strings, private
keys) plus the keyword-assignment rule (`password: ...`, `client_secret=...`).
Encrypted values (`ENC[AES256_GCM,data:...]`) are left alone because they
are safe to keep.

## Windows

The redaction code is pure Node `fs` plus regex, and it adds no native
dependencies. The temp-file-and-rename pattern already runs on Windows in
upstream `copyIfNewer`. I could **not** verify sqlite-vec or Transformers.js
on Windows from this Linux container. That is unchanged upstream surface,
and it still needs a manual check on a Windows host before rollout.

## Other observations

- `embedding-migration.ts` re-embeds from SQLite text. After a
  `redact --rewrite` cleans the rows, the migration can't reintroduce
  secrets.
- The summarizer's `SummarizerSdkError` keeps up to 300 characters of the
  SDK's `result` text in logs and error sentinels. If a model ever echoed a
  secret, it would land there. Feeding the summarizer redacted input removes
  that source.
- `verify.ts --repair` re-summarizes without a `sessionId`, but the Codex fork
  still fires through `getCodexSessionId()`'s fallback. It needs
  `allowResume: false` too.
