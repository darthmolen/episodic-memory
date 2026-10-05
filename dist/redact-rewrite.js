import fs from 'fs';
import path from 'path';
import { initDatabase, openDatabaseReadOnly } from './db.js';
import { recordReembedded } from './embedding-migration.js';
import { copyFileRedacted, describeShape, findRedactionTokens, FindingsTally, redactJsonlLine, } from './redaction.js';
const SUMMARY_SUFFIX = '-summary.txt';
const CONTEXT_BEFORE = 60;
const CONTEXT_AFTER = 20;
const PAGE_SIZE = 500;
function walk(dir) {
    const out = [];
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return out;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory())
            out.push(...walk(full));
        else if (entry.isFile())
            out.push(full);
    }
    return out;
}
function summaryPathFor(jsonlPath) {
    return jsonlPath.replace(/\.jsonl$/, SUMMARY_SUFFIX);
}
/**
 * Pair each value a rule redacted with its token in the redacted text and
 * report it. Tokens already in the original are skipped. Pairing is by rule and
 * order, so the context is right per rule but approximate when one rule hits
 * a line more than once around existing tokens.
 */
function reportHits(original, redacted, matches, location, report) {
    const queues = new Map();
    for (const m of matches) {
        const q = queues.get(m.ruleId);
        if (q)
            q.push(m.value);
        else
            queues.set(m.ruleId, [m.value]);
    }
    const preexisting = new Map();
    for (const t of findRedactionTokens(original))
        preexisting.set(t.ruleId, (preexisting.get(t.ruleId) ?? 0) + 1);
    const oneLine = (text) => text.replace(/\s+/g, ' ');
    for (const t of findRedactionTokens(redacted)) {
        const skip = preexisting.get(t.ruleId) ?? 0;
        if (skip > 0) {
            preexisting.set(t.ruleId, skip - 1);
            continue;
        }
        const value = queues.get(t.ruleId)?.shift();
        if (value === undefined)
            continue;
        const before = redacted.slice(Math.max(0, t.start - CONTEXT_BEFORE), t.start);
        const after = redacted.slice(t.end, t.end + CONTEXT_AFTER);
        report({
            location,
            ruleId: t.ruleId,
            shape: describeShape(value),
            context: oneLine(`${t.start > CONTEXT_BEFORE ? '…' : ''}${before}${redacted.slice(t.start, t.end)}${after}`),
        });
    }
}
/** Redact `text` with `run`, reporting each hit when `report` is set. */
function redactReporting(text, ctx, location, report, run) {
    if (!report)
        return run(ctx);
    const matches = [];
    const out = run({ ...ctx, onMatch: (ruleId, value) => matches.push({ ruleId, value }) });
    if (matches.length > 0)
        reportHits(text, out, matches, location, report);
    return out;
}
/** Report every hit in a JSONL file, line by line. Writes nothing. */
function reportFile(file, label, redactor, report) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    const ctx = { source: 'rewrite', path: file };
    lines.forEach((line, i) => {
        redactReporting(line, ctx, `${label}:${i + 1}`, report, c => redactJsonlLine(line, redactor, c));
    });
}
/** Redact one JSONL file in place. Returns the number of values redacted. */
function rewriteFileInPlace(file, redactor, dryRun, tally) {
    const fileTally = new FindingsTally();
    const temp = `${file}.redact.${process.pid}`;
    try {
        copyFileRedacted(file, temp, redactor, { source: 'rewrite', path: file }, fileTally);
        if (fileTally.total > 0 && !dryRun) {
            const stat = fs.statSync(file);
            fs.renameSync(temp, file);
            // Same rounding as sync's copyIfNewer: never leave the archive older than its source.
            fs.utimesSync(file, stat.atimeMs / 1000, Math.ceil(stat.mtimeMs) / 1000);
        }
    }
    finally {
        try {
            fs.unlinkSync(temp);
        }
        catch { }
    }
    tally.add(fileTally.toArray());
    return fileTally.total;
}
export async function rewriteArchive(options) {
    const { archiveDir, redactor, embed } = options;
    const dryRun = options.dryRun === true;
    const log = options.log ?? (() => { });
    const tally = new FindingsTally();
    const result = {
        filesScanned: 0,
        filesRewritten: 0,
        stagingFilesRewritten: 0,
        rowsUpdated: 0,
        summariesRemoved: 0,
        findings: [],
    };
    // Conversations whose summary was built from unredacted text.
    const staleSummaries = new Set();
    // 1. Archive files.
    const archiveFiles = walk(archiveDir);
    for (const file of archiveFiles.filter(f => f.endsWith('.jsonl'))) {
        result.filesScanned++;
        if (rewriteFileInPlace(file, redactor, dryRun, tally) > 0) {
            result.filesRewritten++;
            staleSummaries.add(summaryPathFor(file));
            if (options.report)
                reportFile(file, path.relative(archiveDir, file), redactor, options.report);
        }
    }
    log(`Archive: ${result.filesRewritten} of ${result.filesScanned} file(s) ${dryRun ? 'would be ' : ''}rewritten`);
    // 2. Staging dirs.
    for (const dir of options.stagingDirs ?? []) {
        for (const file of walk(dir).filter(f => f.endsWith('.jsonl'))) {
            if (rewriteFileInPlace(file, redactor, dryRun, tally) > 0) {
                result.stagingFilesRewritten++;
                if (options.report)
                    reportFile(file, `staging:${path.relative(dir, file)}`, redactor, options.report);
            }
        }
    }
    if (options.stagingDirs?.length) {
        log(`Staging exports: ${result.stagingFilesRewritten} file(s) ${dryRun ? 'would be ' : ''}rewritten`);
    }
    // 3. Index rows. Page by rowid so writes between pages don't disturb the scan.
    // A dry run reads the index as it is; opening it normally would migrate it.
    const db = dryRun ? openDatabaseReadOnly() : initDatabase();
    if (db)
        try {
            const page = db.prepare('SELECT rowid AS rid, id, user_message, assistant_message, archive_path FROM exchanges WHERE rowid > ? ORDER BY rowid LIMIT ?');
            const toolsFor = db.prepare('SELECT id, tool_name, tool_input, tool_result FROM tool_calls WHERE exchange_id = ? ORDER BY rowid');
            const updateExchange = db.prepare('UPDATE exchanges SET user_message = ?, assistant_message = ? WHERE id = ?');
            const updateTool = db.prepare('UPDATE tool_calls SET tool_input = ?, tool_result = ? WHERE id = ?');
            let lastRowid = 0;
            for (;;) {
                const rows = page.all(lastRowid, PAGE_SIZE);
                if (rows.length === 0)
                    break;
                lastRowid = rows[rows.length - 1].rid;
                for (const row of rows) {
                    const rowTally = new FindingsTally();
                    const ctx = { source: 'index', path: row.archive_path };
                    const where = `index:${path.relative(archiveDir, row.archive_path)}#${row.id}`;
                    const redactText = (text, field) => redactReporting(text, ctx, `${where} ${field}`, options.report, c => {
                        const r = redactor.redact(text, c);
                        rowTally.add(r.findings);
                        return r.text;
                    });
                    const user = { text: redactText(row.user_message, 'user') };
                    const assistant = { text: redactText(row.assistant_message, 'assistant') };
                    const tools = toolsFor.all(row.id);
                    const toolUpdates = [];
                    for (const tool of tools) {
                        // tool_input is JSON text; redactJsonlLine keeps it valid JSON.
                        const toolInput = tool.tool_input;
                        const input = toolInput === null ? null : redactReporting(toolInput, ctx, `${where} ${tool.tool_name} input`, options.report, c => redactJsonlLine(toolInput, redactor, c, rowTally));
                        const output = tool.tool_result === null ? null : redactText(tool.tool_result, `${tool.tool_name} result`);
                        if (input !== tool.tool_input || output !== tool.tool_result) {
                            toolUpdates.push({ id: tool.id, input, result: output });
                        }
                    }
                    if (rowTally.total === 0)
                        continue;
                    tally.add(rowTally.toArray());
                    result.rowsUpdated++;
                    staleSummaries.add(summaryPathFor(row.archive_path));
                    if (dryRun)
                        continue;
                    const toolNames = tools.length > 0 ? tools.map(t => t.tool_name) : undefined;
                    const embedding = await embed(user.text, assistant.text, toolNames);
                    db.transaction(() => {
                        updateExchange.run(user.text, assistant.text, row.id);
                        for (const t of toolUpdates)
                            updateTool.run(t.input, t.result, t.id);
                        recordReembedded(db, row.id, embedding);
                    })();
                }
            }
        }
        finally {
            db.close();
        }
    log(`Index: ${result.rowsUpdated} exchange(s) ${dryRun ? 'would be ' : ''}redacted and re-embedded`);
    // 4. Summaries: stale ones, plus any summary that itself matches a rule.
    for (const file of archiveFiles.filter(f => f.endsWith(SUMMARY_SUFFIX))) {
        if (staleSummaries.has(file))
            continue;
        let text;
        try {
            text = fs.readFileSync(file, 'utf-8');
        }
        catch {
            continue;
        }
        const r = redactor.redact(text, { source: 'summary', path: file });
        if (r.findings.length > 0) {
            tally.add(r.findings);
            staleSummaries.add(file);
        }
    }
    for (const summary of staleSummaries) {
        if (!fs.existsSync(summary))
            continue;
        result.summariesRemoved++;
        if (!dryRun)
            fs.unlinkSync(summary);
    }
    log(`Summaries: ${result.summariesRemoved} ${dryRun ? 'would be ' : ''}removed (regenerated from redacted text on the next sync)`);
    result.findings = tally.toArray();
    return result;
}
