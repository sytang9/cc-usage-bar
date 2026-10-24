// Reader side of the ccswitch/sidebar contract test. ccswitch_sidebar_contract_test.sh runs the REAL ccswitch in a
// sandbox HOME first; this file then reads what it wrote with vscode/extension.js's own readers and checks the values
// against the stub API's inputs (expect.json), never against the files themselves.
// Usage (from the wrapper only): node ccswitch_sidebar_contract_test.js <expect.json> <usage-json-stdout>
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const HOME = process.env.HOME;
// Same guard as tests/vscode/harness.js: refuse unless the wrapper made a sandbox HOME under TMPDIR.
if (process.env.CCUB_TEST_SANDBOX !== '1' || !path.resolve(HOME || '/').startsWith(path.resolve(require('os').tmpdir()) + path.sep)
    || !path.resolve(process.env.CODEX_HOME || '/').startsWith(path.resolve(HOME || '/') + path.sep)) {
    console.error('Refusing to run: this test reads $HOME. Run it with: bash tests/ccswitch_sidebar_contract_test.sh');
    process.exit(2);
}

const want = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const jsonOut = fs.readFileSync(process.argv[3], 'utf8');

// The smallest vscode stub extension.js loads with: no settings, so readSnapshot reads ccswitch's own cache.
const vscode = { workspace: { getConfiguration: () => ({ get: () => undefined }) } };
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? vscode : orig.call(this, r, ...a); };
// The test hook harness.js uses: compile extension.js with its internal readers added to the exports.
const file = path.join(__dirname, '..', 'vscode', 'extension.js');
const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file, 'utf8') + '\n;Object.assign(module.exports, { readSnapshot, readHistory, parseUsageJson, mergeLogins, saved });', file);
const e = m.exports;

let passed = 0, failed = 0;
const check = (name, fn) => {
    try { fn(); passed++; console.log('PASS: ' + name); } catch (err) { failed++; console.log('FAIL: ' + name + ' -- ' + err.message); }
};
const within = (t, w, what) => assert.ok(Number.isFinite(t) && t >= w.start && t <= w.end, `${what} ${t} not in [${w.start}, ${w.end}]`);

// --- .usage-cache (write_usage_cache) -> readSnapshot ---------------------------------------------
const snap = e.readSnapshot();
const row = (label) => snap.accounts.find((a) => a.label === label) || {};
for (const label of ['alpha', 'beta']) {
    const w = want.accounts[label].run2;
    check(`cache: readSnapshot gives ${label}'s percents from the last run`, () => {
        assert.strictEqual(row(label).state, 'ok');
        assert.strictEqual(row(label).five_pct, w.p5);
        assert.strictEqual(row(label).week_pct, w.p7);
    });
    check(`cache: readSnapshot gives ${label}'s reset epochs (a null 5h reset stays null)`, () => {
        assert.strictEqual(row(label).five_reset_epoch, w.r5);
        assert.strictEqual(row(label).week_reset_epoch, w.r7);
    });
    check(`cache: readSnapshot gives ${label}'s fetched_at from the last run`, () => within(row(label).fetched_at, want.run2, 'fetched_at'));
}
check('cache: a re-login account (no fetch, no cache) reads as no data yet', () => {
    assert.strictEqual(row('gamma').state, 'no data yet');
    assert.strictEqual(row('gamma').five_pct, null);
});

// --- .usage-history.jsonl (append_usage_history) -> readHistory -----------------------------------
const now = want.run2.end;
for (const label of ['alpha', 'beta']) {
    const h = e.readHistory(label, now), w = want.accounts[label];
    check(`history: readHistory gives ${label} one point per live fetch, in order`, () => {
        assert.strictEqual(h.length, 2, `got ${h.length} points`);
        within(h[0].t, want.run1, 'point 1 t');
        within(h[1].t, want.run2, 'point 2 t');
    });
    check(`history: readHistory gives ${label}'s percents and resets per point`, () => {
        assert.deepStrictEqual(h.map(({ p5, p7, r5, r7 }) => ({ p5, p7, r5, r7 })), [w.run1, w.run2]);
    });
}
check('history: a re-login account has no history points', () => assert.deepStrictEqual(e.readHistory('gamma', now), []));

// --- `ccswitch usage --json` (usage_json_document) -> parseUsageJson, mergeLogins, login_health ----
const doc = e.parseUsageJson(jsonOut);
check('json: parseUsageJson accepts the real document (schema 1, accounts array)', () => {
    assert.ok(doc, 'parseUsageJson returned null');
    assert.strictEqual(doc.schema, 1);
});
check('json: the document lists every saved account by label', () => {
    assert.deepStrictEqual(doc.accounts.filter((a) => a.provider === 'claude').map((a) => a.label), want.labels);
});
check('json: mergeLogins adds the dead login and clears an ok one', () => {
    assert.deepStrictEqual([...e.mergeLogins(new Set(['alpha']), doc, e.saved)], want.relogin);
});
check('json: login_health reads as known (a re-login verdict is trusted)', () => assert.strictEqual(doc.login_health, 'known'));

console.log('----------------------------------------');
console.log(`Passed: ${passed}  Failed: ${failed}`);
process.exit(failed ? 1 : 0);
