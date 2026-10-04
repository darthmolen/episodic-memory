import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { initDatabase, insertExchange } from '../src/db.js';
import { parseConversation } from '../src/parser.js';
import { rewriteArchive } from '../src/redact-rewrite.js';
import { createRedactor, DEFAULT_REDACTION_CONFIG } from '../src/redaction.js';
import { EMBEDDING_VERSION } from '../src/embedding-migration.js';
import { FakeSecrets } from './fake-secrets.js';

const SESSION = '9a8b7c6d-1111-4222-8333-944455556666';

function transcript(secret: string, password: string, clean: string): string {
  const base = { sessionId: SESSION, isSidechain: false, cwd: '/work/legacy' };
  return [
    { ...base, type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2025-06-01T00:00:00.000Z', message: { role: 'user', content: `use AccountKey=${secret} please` } },
    {
      ...base, type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2025-06-01T00:00:01.000Z',
      message: { role: 'assistant', content: [
        { type: 'text', text: 'Running it.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `mysql --password=${password}` } },
      ] },
    },
    { ...base, type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2025-06-01T00:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `ok password: ${password}` }] } },
    { ...base, type: 'assistant', uuid: 'a2', parentUuid: 'u2', timestamp: '2025-06-01T00:00:03.000Z', message: { role: 'assistant', content: [{ type: 'text', text: clean }] } },
  ].map(l => JSON.stringify(l)).join('\n') + '\n';
}

describe('redact --rewrite backfill', () => {
  let root: string;
  let archiveDir: string;
  let dbPath: string;
  const savedEnv = { ...process.env };
  const embed = vi.fn(async (..._args: unknown[]) => new Array(384).fill(0.5));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'episodic-memory-redact-rewrite-'));
    archiveDir = join(root, 'archive');
    dbPath = join(root, 'db.sqlite');
    process.env.TEST_DB_PATH = dbPath;
    embed.mockClear();
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    rmSync(root, { recursive: true, force: true });
  });

  /** Simulate a pre-redaction install: unredacted archive, rows, and summary. */
  async function seedLegacy(fake: FakeSecrets) {
    const secret = fake.azureStorageKey();
    const password = fake.password();
    const projectDir = join(archiveDir, '-work-legacy');
    mkdirSync(join(projectDir, SESSION, 'subagents'), { recursive: true });
    const dirty = join(projectDir, `${SESSION}.jsonl`);
    const clean = join(projectDir, 'clean-session.jsonl');
    const nested = join(projectDir, SESSION, 'subagents', 'agent-abc.jsonl');
    writeFileSync(dirty, transcript(secret, password, 'All done.'));
    writeFileSync(nested, transcript(secret, password, 'Sub-agent done.'));
    writeFileSync(clean, transcript('[REDACTED:connection-string-secret]', '[REDACTED:secret-assignment]', 'Nothing here.'));
    writeFileSync(dirty.replace('.jsonl', '-summary.txt'), 'Configured storage access.');
    writeFileSync(clean.replace('.jsonl', '-summary.txt'), 'A clean summary.');
    const old = new Date('2025-06-02T00:00:00Z');
    for (const f of [dirty, clean, nested]) utimesSync(f, old, old);

    const db = initDatabase();
    for (const file of [dirty, clean, nested]) {
      for (const ex of await parseConversation(file, '-work-legacy', file)) {
        insertExchange(db, ex, new Array(384).fill(0), ex.toolCalls?.map(t => t.toolName));
      }
    }
    // Pretend these rows predate the current encoder bookkeeping.
    db.prepare('UPDATE exchanges SET embedding_version = 0').run();
    db.close();
    return { secret, password, dirty, clean, nested };
  }

  function dbDump(): string {
    const db = new Database(dbPath, { readonly: true });
    sqliteVec.load(db);
    try {
      return JSON.stringify([
        db.prepare('SELECT user_message, assistant_message FROM exchanges').all(),
        db.prepare('SELECT tool_input, tool_result FROM tool_calls').all(),
      ]);
    } finally {
      db.close();
    }
  }

  it('rewrites the archive and index in place, then is a no-op on a second run', async () => {
    const fake = new FakeSecrets(808);
    const { secret, password, dirty, clean, nested } = await seedLegacy(fake);
    const lineCount = readFileSync(dirty, 'utf-8').split('\n').length;
    const mtimeBefore = statSync(dirty).mtimeMs;
    const cleanBytes = readFileSync(clean, 'utf-8');
    expect(dbDump()).toContain(secret);

    const redactor = createRedactor(DEFAULT_REDACTION_CONFIG);
    const result = await rewriteArchive({ archiveDir, redactor, embed });

    // Archive: secrets gone, structure and mtime preserved, nested files covered.
    for (const f of [dirty, nested]) {
      const text = readFileSync(f, 'utf-8');
      expect(text).not.toContain(secret);
      expect(text).not.toContain(password);
      text.split('\n').filter(Boolean).forEach(l => expect(() => JSON.parse(l)).not.toThrow());
    }
    expect(readFileSync(dirty, 'utf-8').split('\n').length).toBe(lineCount);
    expect(Math.abs(statSync(dirty).mtimeMs - mtimeBefore)).toBeLessThan(2);
    expect(readFileSync(clean, 'utf-8')).toBe(cleanBytes);

    // Summaries generated from unredacted text are removed; clean ones stay.
    expect(existsSync(dirty.replace('.jsonl', '-summary.txt'))).toBe(false);
    expect(existsSync(clean.replace('.jsonl', '-summary.txt'))).toBe(true);

    // Index: text columns clean, affected rows re-embedded with the current version.
    const dump = dbDump();
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain(password);
    expect(dump).toContain('[REDACTED:');
    expect(embed).toHaveBeenCalled();
    expectNoSecretInCalls(embed.mock.calls, [secret, password]);

    const db = new Database(dbPath, { readonly: true });
    // Only rows that had secrets are touched; the clean file's rows keep their old version.
    const versions = db.prepare(
      `SELECT embedding_version v, COUNT(*) n FROM exchanges WHERE archive_path IN (?, ?) AND (user_message LIKE '%REDACTED%' OR assistant_message LIKE '%REDACTED%') GROUP BY v`
    ).all(dirty, nested) as Array<{ v: number }>;
    const untouched = db.prepare('SELECT DISTINCT embedding_version v FROM exchanges WHERE archive_path = ?').all(clean) as Array<{ v: number }>;
    db.close();
    expect(versions.map(r => r.v)).toEqual([EMBEDDING_VERSION]);
    expect(untouched.map(r => r.v)).toEqual([0]);

    expect(result.filesRewritten).toBe(2);
    expect(result.summariesRemoved).toBe(1);
    expect(result.rowsUpdated).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain(secret);

    // Second run: nothing left to do.
    embed.mockClear();
    const second = await rewriteArchive({ archiveDir, redactor, embed });
    expect(second.filesRewritten).toBe(0);
    expect(second.rowsUpdated).toBe(0);
    expect(second.summariesRemoved).toBe(0);
    expect(embed).not.toHaveBeenCalled();
  });

  it('--dry-run reports counts without touching anything', async () => {
    const fake = new FakeSecrets(909);
    const { secret, dirty } = await seedLegacy(fake);
    const before = readFileSync(dirty, 'utf-8');

    const result = await rewriteArchive({ archiveDir, redactor: createRedactor(DEFAULT_REDACTION_CONFIG), embed, dryRun: true });

    expect(result.filesRewritten).toBe(2);
    expect(result.rowsUpdated).toBeGreaterThan(0);
    expect(readFileSync(dirty, 'utf-8')).toBe(before);
    expect(existsSync(dirty.replace('.jsonl', '-summary.txt'))).toBe(true);
    expect(dbDump()).toContain(secret);
    expect(embed).not.toHaveBeenCalled();
  });
});

function expectNoSecretInCalls(calls: unknown[][], secrets: string[]) {
  const text = JSON.stringify(calls);
  for (const s of secrets) expect(text.includes(s)).toBe(false);
}
