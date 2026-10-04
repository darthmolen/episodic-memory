# Secret redaction

episodic-memory replaces secrets in your conversations with typed tokens
**before** it archives, indexes, embeds, or summarizes them:

```
AccountKey=Zm9v...==      →  AccountKey=[REDACTED:connection-string-secret]
"password": "abc1Q~..."   →  "password": "[REDACTED:azure-client-secret]"
Authorization: Bearer eyJ →  Authorization: Bearer [REDACTED:jwt]
```

Values are redacted, not dropped. The rest of the conversation stays
searchable, and the token tells you what kind of value was there. You can
search for the tokens too: `episodic-memory search --text "[REDACTED:azure-storage-key]"`
finds every conversation where a storage key was pasted.

Redaction is **on by default**, and it **fails closed**. If the rules can't be
loaded, sync refuses to run. It won't archive unredacted text.

## What's covered

| Where | Redacted? |
|---|---|
| Conversation archive (`~/.config/superpowers/conversation-archive`) | Yes. This is the hook point. |
| SQLite index: message text and tool inputs/outputs | Yes. Built from the archive. |
| Embeddings | Yes. Built from redacted text. |
| Summaries (sent to a model) | Yes. Built from redacted text. Session resume and Codex fork are turned off (see below). |
| opencode and legacy Cursor staging exports | Yes. Redacted when written. |
| `show`, MCP `read` | Yes. They read the archive. |
| Sync logs | Rule IDs and counts only. Matched values are never logged. |
| Claude Code's own `~/.claude/projects`, Codex's `~/.codex/sessions`, etc. | **No.** Those files belong to the harness. Use its retention settings. |

### Summaries

Without redaction, the summarizer can *resume* a Claude Code session or *fork*
a Codex thread. Both make the model read the original, unredacted transcript.
With redaction on, summaries always come from the redacted conversation text.
This has one side effect for Codex-only setups: summarization then goes
through the Claude Agent SDK. If you don't have Claude set up, summaries fail
and retry on later syncs. Set `EPISODIC_MEMORY_SKIP_SUMMARIES=1` to turn them
off. Summaries are display-only, so search quality is unaffected.

## Default rules

Run `episodic-memory redact --print-default-rules` for the full set. In
summary:

| Rule ID | Catches |
|---|---|
| `private-key-block` | PEM and OpenSSH private keys, including truncated ones |
| `connection-string-secret` | `AccountKey=`, `SharedAccessKey=`, `SharedAccessSignature=`, `Password=`, `Pwd=` in connection strings. Only the value is redacted; server, account, and database names stay. |
| `azure-sas-token` | The `sig=` of a SAS URL. The URL and other parameters stay. |
| `jwt` | JWTs, including Entra ID / Azure access tokens |
| `anthropic-api-key`, `openai-api-key`, `github-token`, `aws-access-key-id`, `aws-secret-access-key`, `slack-token`, `google-api-key`, `npm-token` | Provider keys with a recognizable prefix |
| `azure-client-secret` | Entra ID app client secrets (the `…Q~…` format) |
| `azure-storage-key` | Standalone 88-character base64 keys (Storage, Cosmos DB, Function keys) |
| `url-credentials` | The password in `scheme://user:password@host` |
| `bearer-token`, `basic-auth` | `Authorization` header values |
| `secret-assignment` | A value assigned to a secret-looking key: `password: …`, `CLIENT_SECRET=…`, `"apiKey": "…"`. Covers decrypted SOPS, YAML, dotenv, and JSON. Needs 8+ characters including a digit, and skips placeholders (`${X}`, `<x>`, `%X%`) and code (`env.X`, `getPassword()`). |

**Allowlisted** (never redacted, even when a rule matches): git SHAs and
GUIDs. Tenant, client, object, and subscription IDs stay searchable, and so do
commit hashes.

**Entropy fallback:** off by default. When it's on, a long, high-entropy string
is redacted only if a keyword (`secret`, `key`, `token`, …) appears just before
it in the same text value.

**SOPS:** decrypted SOPS output drops its `sops:` metadata block, so it has no
reliable shape. It's covered by the value rules plus `secret-assignment`.
Encrypted values (`ENC[AES256_GCM,…]`) are left alone.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EPISODIC_MEMORY_REDACTION` | `on` | `off` disables redaction entirely: archive copies become byte-for-byte again, and summaries may resume sessions again. |
| `EPISODIC_MEMORY_REDACTION_RULES` | `<config dir>/redaction-rules.json` if it exists | Path to a custom rules file. If you set this and the file is missing, that's an error. |
| `EPISODIC_MEMORY_REDACTION_STRICT` | `1` | When the rules fail to load, `1` stops sync, index, and import (exit 1, nothing written). `0` logs a loud warning and continues **unredacted**. |

`<config dir>` is `~/.config/superpowers` unless `EPISODIC_MEMORY_CONFIG_DIR`,
`PERSONAL_SUPERPOWERS_DIR`, or `XDG_CONFIG_HOME` say otherwise.

### Custom rules

Create `~/.config/superpowers/redaction-rules.json`. By default it extends the
bundled rules:

```jsonc
{
  // Add rules (a rule with a default's id replaces that default)
  "rules": [
    {
      "id": "contoso-api-key",              // lowercase, digits, dashes
      "pattern": "\\bctso_[A-Za-z0-9]{32}\\b", // JavaScript regex
      "flags": "i",                          // optional, any of "imsu"
      "keywords": ["ctso_"],                 // optional prefilter (case-insensitive)
      "secretGroup": 0                       // optional: redact only this capture group
    }
  ],
  "disableRules": ["basic-auth"],            // turn off defaults by id
  "allowlist": [                             // full-match patterns that are never redacted
    { "id": "build-ids", "pattern": "build-[0-9]{8}" }
  ],
  "entropy": { "enabled": true },            // partial override of the entropy settings
  "includeDefaults": true                    // false = use only this file's rules
}
```

Every rule is validated when it loads. An invalid regex, a bad id, a pattern
that matches the empty string, or a `secretGroup` that doesn't exist is a
rules-load failure, which strict mode treats as fatal. To try rules out:

```bash
echo 'password: hunter2hunter2' | episodic-memory redact --stdin
# password: [REDACTED:secret-assignment]
# 1 value(s) redacted (secret-assignment: 1)      (stderr)
```

## Cleaning up existing data

New syncs only redact new or changed files. To redact everything indexed
before you upgraded, or after you add a rule:

```bash
episodic-memory redact --rewrite --dry-run   # report what would change
episodic-memory redact --rewrite             # apply
```

`--rewrite`:

- redacts every archive file in place, keeping line numbers and timestamps
- redacts the opencode and Cursor staging exports in place
- redacts every index row in place and re-embeds only the rows that changed
- deletes summaries that were generated from unredacted text, so the next
  sync regenerates them from the redacted archive

It takes the same lock as `sync`, so it won't run while a sync is in progress.
Running it twice is safe: the second run finds nothing to change.

Before your first sync with this version, consider a one-time scan of your
existing `~/.claude/projects` history. Those source files are never modified.

## How it works

The hook point is the copy into the archive. Every harness (Claude Code,
Codex, Cursor, opencode, OMP) passes through that copy, and every later stage
reads the archive rather than the source. The design and the research behind
it are in [redaction/PHASE0-FINDINGS.md](redaction/PHASE0-FINDINGS.md).

Each archive line is parsed as JSON, every string value is redacted, and only
lines that changed are re-serialized. Lines with no secrets stay byte-for-byte
identical. The archive keeps exactly one line per source line, so index line
ranges and MCP `read` ranges still line up. A line that isn't valid JSON (for
example, a half-written last line) is redacted as plain text.

## Limitations

- Pattern rules miss secrets that have no recognizable shape and no
  `key: value` context. The entropy fallback helps when it's on, but recall
  isn't perfect.
- Each JSON string value is checked on its own. Context split across fields
  (`{"name": "DB_PASSWORD", "value": "…"}`) isn't linked, so the `value` is
  caught only if its own shape matches a rule.
- JSON object *keys* aren't redacted. Only values are.
- On lines that get redacted, re-serializing can change number formatting for
  integers above 2^53. No supported harness writes such numbers.
