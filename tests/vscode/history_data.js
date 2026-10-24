// VS Code sidebar tests: reading ccswitch's .usage-history.jsonl, when history is read, and the forecast.
'use strict';
const {
    assert, fs, path, HOME, ACC, now, check, run, cfg, vscode, fakeWebview, load, e, memento, pt,
} = require('./harness');

run(async () => {
    // --- History view and pace (ccswitch's .usage-history.jsonl) -------------------------------------
    await check('readHistory: last 30 days, sorted; bad, future and old lines skipped; no file -> []', () => {
        const f = path.join(ACC, 'personal', '.usage-history.jsonl');
        try {
            fs.writeFileSync(f, [JSON.stringify(pt(60, 5, 5)), 'not json', '', JSON.stringify(pt(31 * 86400, 1, 1)), JSON.stringify(pt(8 * 86400, 7, 7)),
                JSON.stringify({ t: now + 3600, p5: 1 }), JSON.stringify(pt(1200, 2, 4)), JSON.stringify({ p5: 3 })].join('\n'));
            assert.deepStrictEqual(e.readHistory('personal', now).map((x) => x.p5), [7, 2, 5], 'an 8-day-old point is kept (30-day range), a 31-day-old one is not');
            assert.deepStrictEqual(e.readHistory('spare', now), []);
            const accounts = e.readAccounts().accounts;
            assert.ok(accounts.every((a) => !('history' in a)), 'a poll reads no history (review finding: cost on every poll)');
            const p = e.withHistory(accounts, () => true, now).find((a) => a.label === 'personal');
            assert.strictEqual(p.history.length, 3, 'withHistory carries it');
        } finally { fs.rmSync(f, { force: true }); }
    });

    await check('readHistory reuses the parsed points while size and mtime are unchanged; a change re-reads (review finding)', () => {
        const f = path.join(ACC, 'personal', '.usage-history.jsonl'), T = now - 100;
        const put = (pts) => { fs.writeFileSync(f, pts.map((x) => JSON.stringify(x)).join('\n') + '\n'); fs.utimesSync(f, T, T); };
        try {
            put([pt(60, 11, 1)]);
            assert.deepStrictEqual(e.readHistory('personal', now).map((x) => x.p5), [11]);
            put([pt(60, 22, 1)]);  // same length, same mtime: the cached points are used
            assert.deepStrictEqual(e.readHistory('personal', now).map((x) => x.p5), [11]);
            put([pt(60, 22, 1), pt(30, 33, 1)]);
            assert.deepStrictEqual(e.readHistory('personal', now).map((x) => x.p5), [22, 33]);
            fs.rmSync(f);
            assert.deepStrictEqual(e.readHistory('personal', now), [], 'a deleted file drops out');
        } finally { fs.rmSync(f, { force: true }); }
    });

    await check('readHistory reads only the file\'s tail (the last 30 days), not the whole 30-day file (review finding)', () => {
        const f = path.join(ACC, 'personal', '.usage-history.jsonl');
        try {
            const pad = (JSON.stringify(pt(3 * 86400, 5, 5)) + '\n').repeat(Math.ceil(e.HISTORY_READ_BYTES / 60));
            fs.writeFileSync(f, JSON.stringify(pt(6 * 86400, 1, 1)) + '\n' + pad + JSON.stringify(pt(60, 9, 9)) + '\n');
            assert.ok(fs.statSync(f).size > e.HISTORY_READ_BYTES);
            const h = e.readHistory('personal', now);
            assert.ok(!h.some((x) => x.p5 === 1), 'the line before the tail is not read');
            assert.strictEqual(h[h.length - 1].p5, 9);
            assert.ok(h.every((x) => x.p5 === 5 || x.p5 === 9), 'a line cut by the tail start is skipped');
        } finally { fs.rmSync(f, { force: true }); }
    });

    await check('history is read only for a visible sidebar: History tab -> every account, else the active one; team file -> none', async () => {
        const fw = path.join(ACC, 'work', '.usage-history.jsonl'), fp = path.join(ACC, 'personal', '.usage-history.jsonl');
        fs.writeFileSync(fw, JSON.stringify(pt(60, 50, 40)) + '\n');
        fs.writeFileSync(fp, JSON.stringify(pt(60, 10, 5)) + '\n');
        const cmds = {}, posted = [], seen = [], ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(HOME, 'gs') }, globalState: memento(false) };
        let provider, onMsg, onVis;
        const keep = { win: { ...vscode.window }, commands: vscode.commands, ws: vscode.workspace.onDidChangeConfiguration, stat: fs.statSync };
        Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: (id, p) => { provider = p; return { dispose() {} }; } });
        vscode.StatusBarAlignment = { Right: 2 };
        vscode.commands = { registerCommand: (id, f) => { cmds[id] = f; return { dispose() {} }; }, executeCommand: async () => {} };
        vscode.extensions = { getExtension: () => undefined };
        vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} });
        fs.statSync = function (p, ...a) { if (String(p).endsWith('.usage-history.jsonl')) seen.push(path.basename(path.dirname(p))); return keep.stat.call(this, p, ...a); };
        const tf = path.join(HOME, 'team.json');
        try {
            load().activate(ctx);
            const v = { visible: false, onDidChangeVisibility: (f) => { onVis = f; }, onDidDispose: () => {},
                webview: { ...fakeWebview, postMessage: async (m) => { posted.push(m); }, onDidReceiveMessage: (f) => { onMsg = f; } } };
            provider.resolveWebviewView(v);
            const last = () => posted.filter((m) => m.kind !== 'stats' && m.kind !== 'busy').pop();
            const step = (f) => { seen.length = 0; f(); return [...new Set(seen)].sort(); };
            assert.deepStrictEqual(step(() => onMsg('ready')), [], 'hidden sidebar: no history read');
            assert.deepStrictEqual(last().history, []);
            v.visible = true;
            assert.deepStrictEqual(step(() => onVis()), ['work'], 'Accounts tab: the active account only (its pace line)');
            assert.deepStrictEqual(last().history, [], 'Accounts tab: no series are posted; the pace line is computed in the host');
            assert.deepStrictEqual(step(() => onMsg({ wantHistory: true })), ['dead', 'half', 'personal', 'spare', 'work'], 'History tab: every saved account');
            assert.deepStrictEqual(last().history.map((h) => h.label), ['work', 'personal']);
            assert.deepStrictEqual(step(() => onMsg({ wantHistory: false })), ['work']);
            assert.deepStrictEqual(last().history, [], 'back on Accounts: no series again');
            fs.writeFileSync(tf, JSON.stringify({ generated_at: now, accounts: [{ label: 'personal', provider: 'claude', state: 'ok', five_pct: 1, week_pct: 1 }] }));
            cfg.usageFile = tf;
            seen.length = 0; onMsg({ wantHistory: true }); cmds['claudeUsage.refresh']();  // the command fetches, then re-reads
            await new Promise((r) => setTimeout(r, 400));
            assert.deepStrictEqual([...new Set(seen)], [], 'team file: local history is never read');
            assert.deepStrictEqual([last().history, last().team], [[], true]);
        } finally {
            delete cfg.usageFile;
            fs.statSync = keep.stat;
            for (const d of ctx.subscriptions) if (d && d.dispose) d.dispose();
            Object.assign(vscode.window, keep.win);
            vscode.commands = keep.commands;
            vscode.workspace.onDidChangeConfiguration = keep.ws;
            for (const f of [fw, fp, tf]) fs.rmSync(f, { force: true });
        }
    });

    await check('forecast: straight line since the window started; full before reset, lasts, or nothing to judge', () => {
        // 10% -> 30% over 40 min: 0.5%/min, 70% left -> full in 140 min, before a reset 4 h away.
        const rising = [pt(2400, 10, 50, now + 4 * 3600), pt(1200, 20, 50, now + 4 * 3600), pt(0, 30, 50, now + 4 * 3600)];
        assert.strictEqual(Math.round(e.forecast(rising, 'p5', 'r5', now).full - now), 140 * 60);
        const slow = [pt(2400, 10, 50, now + 3600), pt(0, 12, 50, now + 3600)];
        assert.deepStrictEqual(e.forecast(slow, 'p5', 'r5', now), { lasts: true }, '0.05%/min: 100% only after the reset');
        // Points from the previous window (another reset time) do not count.
        const mixed = [pt(9000, 90, 50, now - 1800), pt(1500, 1, 50, now + 4 * 3600), pt(0, 31, 50, now + 4 * 3600)];
        assert.strictEqual(Math.round(e.forecast(mixed, 'p5', 'r5', now).full - now), 69 * 1500 / 30, '1% -> 31% in 25 min');
        assert.strictEqual(e.forecast([pt(600, 10, 5), pt(0, 30, 5)], 'p5', 'r5', now), null, 'under 20 min of points');
        assert.strictEqual(e.forecast([pt(3600, 30, 5), pt(0, 30, 5)], 'p5', 'r5', now), null, 'no rise');
        assert.strictEqual(e.forecast([pt(3600, 50, 5), pt(0, 100, 5)], 'p5', 'r5', now), null, 'already full');
        assert.strictEqual(e.forecast([pt(3600, 5, 5, now - 60), pt(1800, 9, 5, now - 60)], 'p5', 'r5', now), null, 'that window has reset');
        assert.strictEqual(e.forecast([], 'p5', 'r5', now), null);
        // Found in review: a stale last point, and reset times that differ by a second.
        assert.strictEqual(e.forecast([pt(4 * 3600, 10, 5, now + 3600), pt(3 * 3600, 60, 5, now + 3600)], 'p5', 'r5', now), null, 'last point 3 h old');
        const jitter = [pt(2400, 10, 50, now + 4 * 3600), pt(1200, 20, 50, now + 4 * 3600 + 1), pt(0, 30, 50, now + 4 * 3600)];
        assert.strictEqual(Math.round(e.forecast(jitter, 'p5', 'r5', now).full - now), 140 * 60, 'a 1 s reset jitter is the same window');
    });

    await check('readHistory skips a line with a missing or non-numeric t, percent or reset (review finding)', () => {
        const f = path.join(ACC, 'personal', '.usage-history.jsonl');
        try {
            fs.writeFileSync(f, [pt(600, 1, 1), { ...pt(500, 2, 2), p5: 'x' }, { ...pt(400, 3, 3), r5: 'soon' }, { ...pt(300, 4, 4), t: '1' },
                { t: now - 200, p7: 5, r5: null, r7: null }, { ...pt(150, 6, 6), p7: {} }, { ...pt(100, null, 7), r5: null }]
                .map((x) => JSON.stringify(x)).join('\n') + '\n');
            assert.deepStrictEqual(e.readHistory('personal', now).map((x) => x.p7), [1, 7], 'null is kept: ccswitch writes null for a missing window');
        } finally { fs.rmSync(f, { force: true }); }
    });

    await check('forecast never throws: garbage points give null, not a pace from NaN (review finding)', () => {
        const ok = [pt(2400, 10, 50, now + 4 * 3600), pt(0, 30, 50, now + 4 * 3600)];
        const cases = [
            [{ ...ok[0], p5: 'x' }, ok[1]], [ok[0], { ...ok[1], p5: 'x' }], [ok[0], { ...ok[1], r5: 'x' }], [ok[0], { ...ok[1], r5: {} }],
            [null, ok[1]], [{}, ok[1]], [{ ...ok[0], t: 'x' }, ok[1]], [ok[0], { ...ok[1], t: NaN }], [ok[0], { ...ok[1], p5: Infinity }],
            [{ ...ok[0], p5: -Infinity }, ok[1]], [{ ...ok[0], r5: NaN }, ok[1]],
        ];
        for (const pts of cases) assert.strictEqual(e.forecast(pts, 'p5', 'r5', now), null, JSON.stringify(pts));
        assert.ok(e.forecast(ok, 'p5', 'r5', now).full, 'a good pair still forecasts');
    });
});
