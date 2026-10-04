import fs from 'fs';
import path from 'path';
import { initDatabase } from './db.js';
import { recordReembedded } from './embedding-migration.js';
import { copyFileRedacted, FindingsTally, redactJsonlLine, } from './redaction.js';
const SUMMARY_SUFFIX = '-summary.txt';
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
        }
    }
    log(`Archive: ${result.filesRewritten} of ${result.filesScanned} file(s) ${dryRun ? 'would be ' : ''}rewritten`);
    // 2. Staging dirs.
    for (const dir of options.stagingDirs ?? []) {
        for (const file of walk(dir).filter(f => f.endsWith('.jsonl'))) {
            if (rewriteFileInPlace(file, redactor, dryRun, tally) > 0)
                result.stagingFilesRewritten++;
        }
    }
    if (options.stagingDirs?.length) {
        log(`Staging exports: ${result.stagingFilesRewritten} file(s) ${dryRun ? 'would be ' : ''}rewritten`);
    }
    // 3. Index rows. Page by rowid so writes between pages don't disturb the scan.
    const db = initDatabase();
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
                const user = redactor.redact(row.user_message, ctx);
                const assistant = redactor.redact(row.assistant_message, ctx);
                rowTally.add(user.findings);
                rowTally.add(assistant.findings);
                const tools = toolsFor.all(row.id);
                const toolUpdates = [];
                for (const tool of tools) {
                    // tool_input is JSON text; redactJsonlLine keeps it valid JSON.
                    const input = tool.tool_input === null ? null : redactJsonlLine(tool.tool_input, redactor, ctx, rowTally);
                    let output = tool.tool_result;
                    if (output !== null) {
                        const r = redactor.redact(output, ctx);
                        rowTally.add(r.findings);
                        output = r.text;
                    }
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
