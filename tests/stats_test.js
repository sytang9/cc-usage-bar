// Unit tests for vscode/stats.js. Builds small synthetic transcript trees in a temp dir; never reads ~/.claude.
// Run through tests/stats_test.sh, which pins TZ to UTC+8 so local and UTC days differ.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildStats, funFact, funFacts, heatmapThresholds, heatmapLevel } = require('../vscode/stats.js');

if (new Date('2026-10-21T00:00:00Z').getTimezoneOffset() !== -480) {
    console.error('Refusing to run: needs TZ=Etc/GMT-8. Run it with: bash tests/stats_test.sh');
    process.exit(2);
}

let passed = 0, failed = 0;
const check = async (name, fn) => {
    try { await fn(); passed++; console.log('PASS: ' + name); } catch (e) { failed++; console.log('FAIL: ' + name + ' -- ' + e.message); }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-bar-stats-test.'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
let treeN = 0;
const newTree = () => { const d = path.join(ROOT, 'tree' + (++treeN)); fs.mkdirSync(d); return d; };
const write = (file, lines) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
};
const user = (ts, extra = {}) => ({ type: 'user', timestamp: ts, message: { role: 'user', content: 'x' }, ...extra });
const asst = (ts, model, u = [10, 20, 30, 40], id = 'msg_' + ts, extra = {}) => ({
    type: 'assistant', timestamp: ts, ...extra,
    message: { id, model, usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2], cache_creation_input_tokens: u[3] } },
});
const NOW = '2026-10-21T12:00:00Z'; // local (UTC+8): 2026-10-21 20:00
const run = (dir, cachePath) => buildStats({ projectsDir: dir, cachePath, now: NOW });

(async () => {
    await check('counts user/assistant/attachment/system lines only; drops sidechain lines of a main transcript', async () => {
        const dir = newTree();
        write(path.join(dir, 'p', 's1.jsonl'), [
            user('2026-10-21T01:00:00Z'),
            { type: 'attachment', timestamp: '2026-10-21T01:00:01Z' },
            { type: 'system', timestamp: '2026-10-21T01:00:02Z' },
            { type: 'summary', timestamp: '2026-10-21T01:00:03Z' },
            { type: 'file-history-snapshot', timestamp: '2026-10-21T01:00:04Z' },
            { type: 'progress', timestamp: '2026-10-21T01:00:05Z' },
            user('2026-10-21T01:00:06Z', { isSidechain: true }),
            asst('2026-10-21T01:00:07Z', 'claude-opus-5-5'),
        ]);
        const s = await run(dir);
        assert.strictEqual(s.all.totalMessages, 4);
        assert.deepStrictEqual(s.all.dailyActivity, [{ date: '2026-10-21', messageCount: 4 }]);
    });

    await check('no dedupe, like the CLI: repeated assistant lines with one message id count twice (messages and tokens)', async () => {
        const dir = newTree();
        write(path.join(dir, 'p', 's1.jsonl'), [
            user('2026-10-21T01:00:00Z'),
            asst('2026-10-21T01:00:01Z', 'm', [1, 2, 3, 4], 'msg_same'),
            asst('2026-10-21T01:00:02Z', 'm', [1, 2, 3, 4], 'msg_same'),
        ]);
        const s = await run(dir);
        assert.strictEqual(s.all.totalMessages, 3);
        assert.deepStrictEqual(s.all.models[0], { model: 'm', inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 6, cacheCreationInputTokens: 8, totalTokens: 20 });
    });

    await check('a subagent transcript adds tokens only: no messages, no session; workflow-depth files are not scanned', async () => {
        const dir = newTree();
        write(path.join(dir, 'p', 's1.jsonl'), [user('2026-10-21T01:00:00Z'), user('2026-10-21T01:10:00Z')]);
        write(path.join(dir, 'p', 's1', 'subagents', 'agent-a1.jsonl'), [
            user('2026-10-21T01:01:00Z', { isSidechain: true }), asst('2026-10-21T05:00:00Z', 'sub-model', [5, 5, 0, 0], 'x', { isSidechain: true }),
        ]);
        write(path.join(dir, 'p', 's1', 'subagents', 'notes.jsonl'), [asst('2026-10-21T01:02:00Z', 'ignored')]);
        write(path.join(dir, 'p', 's1', 'subagents', 'workflows', 'wf', 'agent-a2.jsonl'), [asst('2026-10-21T01:02:00Z', 'ignored')]);
        const s = await run(dir);
        assert.strictEqual(s.meta.files, 2);
        assert.strictEqual(s.all.totalMessages, 2);
        assert.strictEqual(s.all.sessions, 1);
        assert.strictEqual(s.all.longestSession.ms, 10 * 60000); // the subagent's later line does not stretch the session
        assert.deepStrictEqual(s.all.models.map((m) => [m.model, m.totalTokens]), [['sub-model', 10]]);
    });

    await check('sessions = main transcript files; longest session = last minus first line, with its date', async () => {
        const dir = newTree();
        write(path.join(dir, 'p', 'a.jsonl'), [user('2026-10-20T02:00:00Z'), user('2026-10-20T03:30:00Z')]);
        write(path.join(dir, 'p', 'b.jsonl'), [user('2026-10-21T01:00:00Z'), user('2026-10-21T01:20:00Z')]);
        write(path.join(dir, 'q', 'c.jsonl'), [{ type: 'summary' }]); // no message lines: not a session
        const s = await run(dir);
        assert.strictEqual(s.all.sessions, 2);
        assert.deepStrictEqual(s.all.longestSession, { ms: 90 * 60000, date: '2026-10-20', startedAt: '2026-10-20T02:00:00.000Z' });
    });

    await check('a bad first or last timestamp drops the whole transcript; a bad middle line drops only itself', async () => {
        const dir = newTree();
        write(path.join(dir, 'p', 'bad.jsonl'), [user('not a date'), asst('2026-10-21T01:00:00Z', 'm')]);
        write(path.join(dir, 'p', 'ok.jsonl'), [user('2026-10-21T01:00:00Z'), user(undefined), user('2026-10-21T02:00:00Z')]);
        const s = await run(dir);
        assert.strictEqual(s.all.sessions, 1);
        assert.strictEqual(s.all.totalMessages, 2);
        assert.strictEqual(s.all.totalTokens, 0);
    });

    await check('bad lines are skipped: broken JSON, arrays, numbers, blank lines, a BOM', async () => {
        const dir = newTree();
        write(path.join(dir, 'p', 's.jsonl'), [
            '﻿' + JSON.stringify(user('2026-10-21T01:00:00Z')), '{"type":"user","timestamp":"2026-10-21T01:00', '[1,2]', '42', '',
            'null', JSON.stringify(user('2026-10-21T01:05:00Z')),
        ]);
        const s = await run(dir);
        assert.strictEqual(s.all.totalMessages, 2);
    });

    await check('days are UTC days (the CLI uses toISOString): streaks across local midnight', async () => {
        const dir = newTree();
        // UTC days 19, 20, 21 = local (UTC+8) 19 18:00, 21 04:00, 21 09:00: one local gap, no UTC gap.
        write(path.join(dir, 'p', 'a.jsonl'), [user('2026-10-19T10:00:00Z')]);
        write(path.join(dir, 'p', 'b.jsonl'), [user('2026-10-20T20:00:00Z')]);
        write(path.join(dir, 'p', 'c.jsonl'), [user('2026-10-21T01:00:00Z')]);
        write(path.join(dir, 'p', 'd.jsonl'), [user('2026-10-10T01:00:00Z'), user('2026-10-11T01:00:00Z'), user('2026-10-12T01:00:00Z'), user('2026-10-13T01:00:00Z')]);
        const s = await run(dir);
        assert.deepStrictEqual(s.all.dailyActivity.map((d) => d.date).slice(-3), ['2026-10-19', '2026-10-20', '2026-10-21']);
        assert.strictEqual(s.all.currentStreak, 3);
        assert.strictEqual(s.all.longestStreak, 4);
        assert.strictEqual(s.all.activeDays, 7);
    });

    await check('a today (UTC) without activity breaks the current streak', async () => {
        const dir = newTree();
        write(path.join(dir, 'p', 'a.jsonl'), [user('2026-10-19T10:00:00Z'), user('2026-10-20T10:00:00Z')]);
        const s = await run(dir);
        assert.strictEqual(s.all.currentStreak, 0);
        assert.strictEqual(s.all.longestStreak, 2);
        assert.strictEqual(s['7d'].currentStreak, 0);
    });

    await check('peak hour = local hour with the most session starts; a tie goes to the earlier hour', async () => {
        const dir = newTree();
        write(path.join(dir, 'p', 'a.jsonl'), [user('2026-10-21T01:00:00Z'), user('2026-10-21T05:00:00Z')]); // local 09
        write(path.join(dir, 'p', 'b.jsonl'), [user('2026-10-20T01:30:00Z')]); // local 09
        write(path.join(dir, 'p', 'c.jsonl'), [user('2026-10-20T03:00:00Z'), user('2026-10-20T03:01:00Z'), user('2026-10-20T03:02:00Z')]); // local 11
        let s = await run(dir);
        assert.strictEqual(s.all.peakHour, 9); // by sessions, not by messages (11 has more messages)
        write(path.join(dir, 'p', 'd.jsonl'), [user('2026-10-19T16:00:00Z')]); // local 00
        write(path.join(dir, 'p', 'e.jsonl'), [user('2026-10-19T16:30:00Z')]); // local 00
        s = await run(dir);
        assert.strictEqual(s.all.peakHour, 0);
    });

    await check('ranges: 7d / 30d start at the UTC day of local now minus 6 / 29 days; a session counts by its start day', async () => {
        const dir = newTree();
        write(path.join(dir, 'p', 'old.jsonl'), [user('2026-09-01T01:00:00Z')]);
        write(path.join(dir, 'p', 'mid.jsonl'), [user('2026-10-01T01:00:00Z')]);
        // starts before the 7d window (2026-10-15) and runs into it
        write(path.join(dir, 'p', 'span.jsonl'), [user('2026-10-14T23:00:00Z'), user('2026-10-15T01:00:00Z'), user('2026-10-15T02:00:00Z')]);
        write(path.join(dir, 'p', 'new.jsonl'), [user('2026-10-21T01:00:00Z')]);
        const s = await run(dir);
        assert.strictEqual(s['7d'].fromDate, '2026-10-15');
        assert.strictEqual(s['30d'].fromDate, '2026-09-22');
        assert.deepStrictEqual([s['7d'].sessions, s['30d'].sessions, s.all.sessions], [1, 3, 4]);
        assert.deepStrictEqual([s['7d'].totalMessages, s['30d'].totalMessages, s.all.totalMessages], [3, 5, 6]);
        assert.deepStrictEqual([s['7d'].totalDays, s['30d'].totalDays, s.all.totalDays], [7, 30, 51]);
        assert.strictEqual(s['7d'].label, 'Last 7 days');
    });

    await check('models: favorite and top 3 by all four token kinds; total tokens sums all four; <synthetic> and prototype names dropped', async () => {
        const dir = newTree();
        write(path.join(dir, 'p', 's.jsonl'), [
            asst('2026-10-20T01:00:00Z', 'a', [100, 100, 0, 0]),
            asst('2026-10-20T01:01:00Z', 'b', [1, 1, 500, 0]),
            asst('2026-10-21T01:02:00Z', 'c', [0, 0, 0, 300]),
            asst('2026-10-21T01:03:00Z', 'd', [1, 1, 1, 1]),
            asst('2026-10-21T01:04:00Z', '<synthetic>', [9999, 9999, 0, 0]),
            asst('2026-10-21T01:05:00Z', 'constructor', [9999, 9999, 0, 0]),
            { type: 'assistant', timestamp: '2026-10-21T01:06:00Z', message: { usage: { input_tokens: 7, output_tokens: 'x' } } },
        ]);
        const s = await run(dir);
        assert.strictEqual(s.all.favoriteModel, 'b');
        assert.deepStrictEqual(s.all.models.map((m) => m.model), ['b', 'c', 'a', 'unknown', 'd']);
        assert.strictEqual(s.all.totalTokens, 502 + 300 + 200 + 7 + 4);
        assert.deepStrictEqual(s.all.tokensPerDay, {
            models: ['b', 'c', 'a'],
            days: [{ date: '2026-10-20', tokensByModel: { b: 502, c: 0, a: 200 } }, { date: '2026-10-21', tokensByModel: { b: 0, c: 300, a: 0 } }],
        });
    });

    await check('cache: an unchanged file is not re-read (same size+mtime, new bytes are ignored)', async () => {
        const dir = newTree(), cache = path.join(dir, '..', 'cache-' + treeN + '.json');
        const a = path.join(dir, 'p', 'a.jsonl'), b = path.join(dir, 'p', 'b.jsonl');
        write(a, [user('2026-10-21T01:00:00Z'), user('2026-10-21T01:01:00Z')]);
        write(b, [user('2026-10-20T01:00:00Z')]);
        const T = 1792000000; // whole seconds, so the mtime survives a utimes round trip exactly
        fs.utimesSync(a, T, T);
        let s = await run(dir, cache);
        assert.deepStrictEqual([s.meta.parsed, s.meta.reused], [2, 0]);
        const text = fs.readFileSync(a, 'utf8').replace(/"user"/g, '"zzzz"'); // same length, no message lines
        fs.writeFileSync(a, text);
        fs.utimesSync(a, T, T);
        s = await run(dir, cache);
        assert.deepStrictEqual([s.meta.parsed, s.meta.reused], [0, 2]);
        assert.strictEqual(s.all.totalMessages, 3); // the cached aggregate, not the new bytes
    });

    await check('cache: a changed file is re-read; a deleted file drops out of the stats and the cache', async () => {
        const dir = newTree(), cache = path.join(dir, '..', 'cache-' + treeN + '.json');
        const a = path.join(dir, 'p', 'a.jsonl'), b = path.join(dir, 'p', 'b.jsonl');
        write(a, [user('2026-10-21T01:00:00Z')]);
        write(b, [user('2026-10-20T01:00:00Z')]);
        await run(dir, cache);
        fs.appendFileSync(a, JSON.stringify(user('2026-10-21T02:00:00Z')) + '\n');
        let s = await run(dir, cache);
        assert.deepStrictEqual([s.meta.parsed, s.meta.reused], [1, 1]);
        assert.strictEqual(s.all.totalMessages, 3);
        fs.unlinkSync(b);
        s = await run(dir, cache);
        assert.deepStrictEqual([s.meta.parsed, s.meta.reused, s.meta.dropped], [0, 1, 1]);
        assert.strictEqual(s.all.totalMessages, 2);
        assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(cache, 'utf8')).files), [a]);
    });

    await check('cache: a corrupt cache file is ignored and rebuilt', async () => {
        const dir = newTree(), cache = path.join(dir, '..', 'cache-' + treeN + '.json');
        write(path.join(dir, 'p', 'a.jsonl'), [user('2026-10-21T01:00:00Z')]);
        fs.writeFileSync(cache, '{not json');
        const s = await run(dir, cache);
        assert.strictEqual(s.meta.parsed, 1);
        assert.strictEqual(JSON.parse(fs.readFileSync(cache, 'utf8')).version, 1);
    });

    await check('cache: a malformed entry with the right size and mtime is parsed again, not kept (review finding)', async () => {
        const dir = newTree(), cache = path.join(dir, '..', 'cache-' + treeN + '.json');
        const f = path.join(dir, 'p', 'a.jsonl');
        write(f, [user('2026-10-21T01:00:00Z')]);
        await run(dir, cache);
        const c = JSON.parse(fs.readFileSync(cache, 'utf8'));
        c.files[f].agg = null;
        fs.writeFileSync(cache, JSON.stringify(c));
        const s = await run(dir, cache);
        assert.deepStrictEqual([s.meta.parsed, s.meta.reused, s.all.sessions], [1, 0, 1]);
        assert.ok(JSON.parse(fs.readFileSync(cache, 'utf8')).files[f].agg, 'the entry is repaired');
    });

    await check('an empty or missing projects dir gives zeros and no fun fact', async () => {
        const s = await run(path.join(ROOT, 'missing'));
        assert.deepStrictEqual([s.all.sessions, s.all.totalTokens, s.all.peakHour, s.all.favoriteModel, s.all.longestSession, s.all.funFact],
            [0, 0, null, null, null, '']);
    });

    const facts = (io, minutes) => funFacts({ models: [{ inputTokens: io, outputTokens: 0 }], longestSession: minutes === null ? null : { ms: minutes * 60000 } });
    await check('funFact: book thresholds use input+output only (no cache tokens)', async () => {
        assert.deepStrictEqual(facts(21999, null), []);
        assert.deepStrictEqual(facts(22000, null), ['Your input and output are about as many tokens as The Little Prince']);
        assert.deepStrictEqual(facts(44000, null), [
            'Your input and output are ~2x the tokens in The Little Prince',
            'Your input and output are about as many tokens as The Old Man and the Sea',
            'Your input and output are about as many tokens as A Christmas Carol',
            'Your input and output are about as many tokens as Animal Farm',
        ]);
        assert.deepStrictEqual(funFacts({ models: [{ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1e9 }], longestSession: null }), []);
        assert.ok(facts(7300000, null).includes('Your input and output are ~10x the tokens in War and Peace'));
    });

    await check('funFact: duration facts need at least 2x', async () => {
        assert.deepStrictEqual(facts(0, 35), []);
        assert.deepStrictEqual(facts(0, 36), ['Your longest session is ~2x longer than a TED talk']);
        assert.deepStrictEqual(facts(0, 296), [
            'Your longest session is ~16x longer than a TED talk', 'Your longest session is ~13x longer than an episode of The Office',
            'Your longest session is ~6x longer than listening to Abbey Road', 'Your longest session is ~4x longer than a yoga class',
            'Your longest session is ~3x longer than a World Cup soccer match', 'Your longest session is ~2x longer than a half marathon (average time)',
            'Your longest session is ~2x longer than the movie Inception',
        ]);
    });

    await check('funFact: one pick per day key, stable within the day, varies across days, empty when none apply', async () => {
        const r = { models: [{ inputTokens: 1e6, outputTokens: 0 }], longestSession: { ms: 600 * 60000 } };
        const all = funFacts(r);
        assert.strictEqual(funFact(r, '2026-10-21'), funFact(r, '2026-10-21'));
        const seen = new Set();
        for (let d = 1; d <= 31; d++) {
            const f = funFact(r, `2026-10-${String(d).padStart(2, '0')}`);
            assert.ok(all.includes(f));
            seen.add(f);
        }
        assert.ok(seen.size > 5, `only ${seen.size} distinct facts over a month`);
        assert.strictEqual(funFact({ models: [], longestSession: null }, '2026-10-21'), '');
    });

    await check('buildStats attaches the fun fact for the local day key', async () => {
        const dir = newTree();
        write(path.join(dir, 'p', 's.jsonl'), [asst('2026-10-21T01:00:00Z', 'm', [30000, 0, 0, 0])]);
        const s = await run(dir);
        assert.strictEqual(s.meta.dayKey, '2026-10-21');
        assert.strictEqual(s.all.funFact, 'Your input and output are about as many tokens as The Little Prince');
        assert.doesNotThrow(() => JSON.parse(JSON.stringify(s)));
    });

    await check('heatmap levels: 25th/50th/75th percentile of the non-zero days', async () => {
        const t = heatmapThresholds([1, 2, 3, 4, 0].map((messageCount, i) => ({ date: String(i), messageCount })));
        assert.deepStrictEqual(t, { p25: 2, p50: 3, p75: 4 });
        assert.deepStrictEqual([0, 1, 2, 3, 4, 9].map((n) => heatmapLevel(n, t)), [0, 1, 2, 3, 4, 4]);
        assert.strictEqual(heatmapThresholds([]), null);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
