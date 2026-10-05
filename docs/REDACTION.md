# Secret redaction

episodic-memory replaces secrets in your conversations with typed tokens
**before** it archives, indexes, embeds, or summarizes them:

```
AccountKey=<88-char key>          →  AccountKey=[REDACTED:connection-string-secret]
"ClientSecret": "<any value>"     →  "ClientSecret": "[REDACTED:quoted-secret-assignment]"
<add key="SmtpPassword" value=…/> →  <add key="SmtpPassword" value="[REDACTED:xml-appsettings-secret]"/>
Authorization: Bearer <JWT>       →  Authorization: Bearer [REDACTED:jwt]
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
| `connection-string-secret` | `AccountKey=`, `SharedAccessKey=`, `SharedAccessSignature=`, `Password=`, `Pwd=` in connection strings, in any case. Only the value is redacted; server, account, and database names stay. |
| `azure-sas-token` | The `sig=` of a SAS URL. The URL and other parameters stay. |
| `jwt` | JWTs, including Entra ID / Azure access tokens |
| `anthropic-api-key`, `openai-api-key`, `github-token`, `aws-access-key-id`, `aws-secret-access-key`, `slack-token`, `google-api-key`, `npm-token` | Provider keys with a recognizable prefix |
| `azure-client-secret` | Entra ID app client secrets (the `…Q~…` format) |
| `azure-storage-key` | Standalone 88-character base64 keys (Storage, Cosmos DB, Function keys) |
| `url-credentials` | The password in `scheme://user:password@host` |
| `bearer-token`, `basic-auth` | `Authorization` header values |
| `azure-keyvault-secret` | The `value` of a Key Vault secret bundle (`az keyvault secret show`, SDK JSON), whatever the secret is named |
| `name-value-secret` | The `value` of a `{"name": <secret-looking name>, "value": …}` object, in either order: `az webapp`/`functionapp config appsettings list`, Kubernetes `env`, ARM/Bicep parameters |
| `xml-appsettings-secret` | `web.config` / `app.config` `<add key="<secret-looking name>" value="…"/>`, either attribute order |
| `xml-secret-element` | `<ClientSecret>…</ClientSecret>`, `<Password>…</Password>` and the like |
| `xml-secret-attribute` | Secret-named XML attributes, e.g. `userPWD="…"` in Azure publish profiles |
| `quoted-secret-assignment` | A **quoted** value assigned to a secret-looking name: `"ClientSecret": "…"` (appsettings.json and any JSON in tool output), `ClientSecret = "…"` (C#), `apiKey: '…'` (JS/YAML/Python). No digit or minimum entropy is required; the value must have no spaces. |
| `secret-assignment` | An **unquoted** value assigned to a secret-looking key: `password: …`, `CLIENT_SECRET=…`. Covers decrypted SOPS, YAML, and dotenv. Needs 8+ characters including a digit, and skips code (`env.X`, `getPassword()`). |
| `secret-field` | Not a text rule: in parsed JSON (transcript lines, structured MCP/tool results, tool inputs), a string whose **field name** is secret-looking, or the `value` of a `{name, value}` pair or Key Vault bundle, is redacted whole. See `secretFields` below. |

A **secret-looking name** ends in `secret`, `password`, `passwd`,
`passphrase`, `apikey`, `accesskey`, `accountkey`, `privatekey`, `sharedkey`,
`primarykey`, `secondarykey`, `masterkey`, `signingkey`, `subscriptionkey`,
`clientkey`, `encryptionkey`, `token`, or `credential(s)`, in any case and
with any separators (`AzureAd:ClientSecret`, `Stripe__ApiKey`, `DB_PASSWORD2`).
Because it has to *end* in one of these, `TokenEndpoint`, `secretName`,
`passwordPolicy`, `tokenType`, and `maxTokens` don't count.

Key-context rules leave **placeholders** alone: `${X}`, `$(X)`, `#{X}#`
(Azure DevOps token replacement), `{{x}}`, `<x>`, `%X%`, `__X__`, and type
names or masks like `"string"` and `"*****"`. All other rules skip the same
`${X}`, `<x>`, and `%X%` forms.

**Allowlisted:** git SHAs and GUIDs are not redacted by shape-based rules,
so tenant, client, object, and subscription IDs and commit hashes stay
searchable. Key-context rules ignore the allowlist on purpose: a GUID in a
`password` slot (older `az ad sp create-for-rbac` output) *is* a secret.

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
      "secretGroup": 0,                      // optional: redact only this group ([1, 2] = first that matched)
      "useAllowlist": true                   // optional: false = redact even SHA/GUID-shaped values
    }
  ],
  "disableRules": ["basic-auth"],            // turn off defaults by id
  "allowlist": [                             // full-match patterns that are never redacted
    { "id": "build-ids", "pattern": "build-[0-9]{8}" }
  ],
  "entropy": { "enabled": true },            // partial override of the entropy settings
  "secretFields": {                          // field-name context in parsed JSON
    "enabled": true,
    // matched against the END of the key lowercased with separators removed;
    // this example adds "connectionstring" to redact whole connection strings
    "keyPattern": "secret|password|passwd|userpwd|passphrase|apikey|accesskey|accountkey|privatekey|sharedkey|primarykey|secondarykey|masterkey|signingkey|subscriptionkey|clientkey|encryptionkey|token|credentials?|connectionstring"
  },
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

Each archive line is parsed as JSON. Every string value goes through the text
rules, values are redacted whole when their field name marks them as secrets
(`secretFields`), and a key that is itself a secret is renamed to its token.
Only lines that changed are re-serialized. Lines with no secrets stay byte-for-byte
identical. The archive keeps exactly one line per source line, so index line
ranges and MCP `read` ranges still line up. A line that isn't valid JSON (for
example, a half-written last line) is redacted as plain text.

## Limitations

- Pattern rules miss secrets that have no recognizable shape and no
  `key: value` context. The entropy fallback helps when it's on, but recall
  isn't perfect.
- A secret-looking name is required for the key-context rules. A setting
  named `Stripe` or `ConnectionStrings__Default` with a shapeless value is
  only caught if a shape rule matches the value. Connection strings are
  handled by `connection-string-secret`, which keeps server names searchable.
  Add your own names via `secretFields.keyPattern` or a custom rule.
- Quoted values containing spaces (multi-word passphrases) aren't caught by
  `quoted-secret-assignment`. The rule excludes them so that UI labels like
  `ErrorMessage = "Invalid password"` aren't redacted.
- Positional secrets in code (`new ClientSecretCredential(t, c, "…")`) are
  caught only by shape, e.g. `azure-client-secret`.
- On lines that get redacted, re-serializing can change number formatting for
  integers above 2^53. No supported harness writes such numbers.
