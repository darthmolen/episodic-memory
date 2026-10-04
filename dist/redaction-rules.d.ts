import type { RedactionConfig } from './redaction.js';
/**
 * Bundled default redaction rules.
 *
 * Patterns are ported from gitleaks' rule set (https://github.com/gitleaks/gitleaks,
 * MIT), trimmed to the credentials that realistically show up in Claude Code /
 * Codex transcripts for an Azure-heavy stack, and rewritten for JavaScript
 * regex (lookbehind instead of gitleaks' consuming boundary groups, so
 * adjacent matches aren't swallowed).
 *
 * Order matters: rules run top to bottom, and a later rule never re-matches
 * inside an earlier rule's `[REDACTED:...]` token. Specific shapes go first so
 * the token names the most precise rule; the generic `secret-assignment`
 * keyword rule goes last.
 *
 * `secretGroup` replaces only that capture group, so surrounding context
 * (connection-string server names, SAS URL paths, usernames) stays searchable.
 *
 * `keywords` is a case-insensitive prefilter: a rule only runs on text that
 * contains at least one keyword. It keeps the per-string cost low on large
 * transcripts and bounds the generic rules' work.
 *
 * Users extend or override these with `redaction-rules.json`; see
 * docs/REDACTION.md. `episodic-memory redact --print-default-rules` dumps
 * this object as JSON.
 */
export declare const DEFAULT_REDACTION_CONFIG: RedactionConfig;
