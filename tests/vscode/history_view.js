// VS Code sidebar tests: the History view (charts, hover, range, layout) and its payload.
'use strict';
const {
    assert, fs, path, HOME, ACC, now, check, run, vscode, fakeWebview, load, e, memento, capOf, four, opts, readWv,
    panel, ui, pt, withHist, rising,
} = require('./harness');

run(async () => {
    await check('panelData: history blocks, active first; 24 h session and 7 d weekly series; pace lines', () => {
        const d = withHist([pt(2 * 86400, 70, 40, now - 86400), ...rising], { '004': [pt(60, 46, 13)] });
        assert.deepStrictEqual(d.history.map((h) => h.label), ['002', '004'], 'only accounts with points, active first');
        const h = d.history[0];
        assert.strictEqual(h.fiveSeries.length, 3, 'the 2-day-old point is outside the session chart');
        assert.strictEqual(h.weekSeries.length, 4);
        assert.deepStrictEqual(h.fiveSeries[2], [now, 30, now + 4 * 3600]);
        assert.match(h.fivePace, /^Full in 2h (19|20)m at this pace$/, 'resetText reads the clock: allow the minute to tick');
        assert.strictEqual(h.weekPace, 'Lasts until reset');
        assert.strictEqual(d.active.fivePace, h.fivePace, 'Active account shows the pace when full comes first');
        assert.strictEqual(d.active.weekPace, null, '"lasts until reset" is not repeated there');
        assert.strictEqual(d.now, now);
        assert.deepStrictEqual(withHist([]).history, []);
    });

    await check('render: Accounts | History switcher; Accounts by default; the choice is a tab', () => {
        const p = panel(), d = withHist(rising);
        const acc = p.render(d, ui());
        assert.match(acc, /^<div class="vbar"><div class="seg" role="tablist"><button class="sg on" role="tab" aria-selected="true" data-a="view" data-l="accounts">Accounts<\/button><button class="sg" role="tab" aria-selected="false" data-a="view" data-l="history">History<\/button><button class="sg" role="tab" aria-selected="false" data-a="view" data-l="stats">Stats<\/button><\/div>/);
        assert.ok(acc.includes('Active account') && !acc.includes('last 24h'));
        assert.match(acc, /Resets [^<]+<\/div><div class="rs">Full in 2h (19|20)m at this pace</, 'the pace line under the session bar');
        const hist = p.render(d, ui({ view: 'history' }));
        assert.ok(hist.includes('aria-selected="true" data-a="view" data-l="history"') && !hist.includes('class="t">Active account') && !hist.includes('Automation'), 'no Accounts sections (the active row keeps its tooltip)');
        assert.ok(p.render(d, ui({ view: 'nonsense' })).includes('Active account'), 'an unknown view falls back to Accounts');
    });

    await check('render: History opens the active account with two charts; a reset starts a new line', () => {
        const p = panel();
        const d = withHist([pt(5 * 3600, 60, 40, now - 3 * 3600), pt(4 * 3600, 80, 41, now - 3 * 3600), ...rising], { '004': [pt(60, 46, 13)] });
        const html = p.render(d, ui({ view: 'history' }));
        assert.match(html, /data-a="hrow" data-l="002" role="button" tabindex="0" aria-expanded="true"/);
        assert.match(html, /data-a="hrow" data-l="004" role="button" tabindex="0" aria-expanded="false"/);
        const det = html.slice(html.indexOf('<div class="det">'), html.indexOf('data-l="004"'));
        assert.ok(det.includes('Session (5hr) · last 24h') && det.includes('Weekly (7 day) · last 7d') && det.includes('24h ago') && det.includes('7d ago'));
        const session = det.slice(0, det.indexOf('Weekly (7 day)'));
        assert.strictEqual(session.split('<polyline').length - 1, 2, 'two windows, two lines');
        assert.strictEqual(session.split('class="rz"').length - 1, 1, 'one tick where the new window starts');
        assert.match(session, /Full in 2h (19|20)m at this pace/);
        assert.match(det, /class="g80" x1="0" x2="300" y1="11\.2"/, 'the 80% guide');
        assert.ok(!/<div class="ch hi">[^]*Session/.test(det.slice(0, det.indexOf('</svg>'))), 'session at 30%: not orange');
        const other = p.render(d, ui({ view: 'history', histOpen: '004' }));
        assert.match(other, /data-l="004" role="button" tabindex="0" aria-expanded="true"/);
        assert.match(other, /data-l="002" role="button" tabindex="0" aria-expanded="false"/);
        assert.ok(!p.render(d, ui({ view: 'history', histOpen: null })).includes('<svg'), 'all closed');
        const jit = withHist([pt(2400, 10, 50, now + 4 * 3600), pt(1200, 20, 50, now + 4 * 3600 + 1), pt(0, 30, 50, now + 4 * 3600 - 1)]);
        const js = p.render(jit, ui({ view: 'history' }));
        assert.strictEqual(js.slice(0, js.indexOf('Weekly (7 day)')).split('<polyline').length - 1, 1, 'reset times a second apart: one line');
    });

    await check('hover: tooltip text from a known series: time ago + clock, usage %, rate in %/h (5h) and %/day (weekly), reset, no data', () => {
        const p = panel(), t0 = now - 3 * 3600, R = now + 3600, R2 = now + 9000;
        const five = { kind: 'five', from: now - 86400, to: now, pts: [[t0, 10, R], [t0 + 600, 12, R], [t0 + 1200, 15, R], [t0 + 1800, 3, R2], [t0 + 5400, 10, R2], [t0 + 6000, 13, R2]] };
        const z = (n) => String(n).padStart(2, '0'), clock = (t) => z(new Date(t * 1000).getHours()) + ':' + z(new Date(t * 1000).getMinutes());
        assert.deepStrictEqual({ ...p.hoverAt(five, t0 + 250) }, { when: '2h 55m ago \u00b7 ' + clock(t0 + 250), pct: '10%', rate: '+12.0%/h' }, '2 points in 10 min = +12.0%/h');
        assert.strictEqual(p.hoverAt(five, t0 + 900).rate, '+15.0%/h', 'trailing hour, cut at the window start: 10 -> 15 in 20 min');
        assert.strictEqual(p.hoverAt(five, t0 + 1500).rate, 'reset', 'usage falls 15 -> 3: a reset, not a negative rate');
        assert.strictEqual(p.hoverAt(five, t0 + 3000).rate, 'no data', 'the 1 h gap is longer than 3x the 10 min spacing');
        assert.strictEqual(p.hoverAt(five, now).rate, 'no data', 'after the last sample');
        assert.strictEqual(p.hoverAt(five, now).pct, '\u2013', 'and no % either: the nearest sample is too far');
        assert.strictEqual(p.hoverAt(five, now - 30).when.split(' \u00b7 ')[0], 'just now');
        assert.strictEqual(p.hoverAt({ ...five, pts: [] }, t0), null);
        const d2 = now - 2 * 86400;
        const week = { kind: 'week', from: now - 7 * 86400, to: now, pts: [[d2, 40, R], [d2 + 3600, 41, R], [d2 + 7200, 41.5, R]] };
        const w = p.hoverAt(week, d2 + 1800);
        assert.strictEqual(w.rate, '+24.0%/day', '1% in 1 h on the weekly chart is 24.0%/day');
        assert.strictEqual(p.hoverAt(week, d2 + 5400).rate, '+18.0%/day', 'trailing day, cut at the window start: 40 -> 41.5 in 2 h');
        assert.ok(/^1d 23h ago \u00b7 (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/.test(w.when), w.when + ': a day or more back adds the weekday');
        assert.strictEqual(w.pct, '40%');
    });

    await check('hover: the rate is taken over a trailing window (1 h on 5h, 24 h on weekly), so whole-number steps do not swing it (review finding)', () => {
        const p = panel(), t0 = now - 3 * 3600, R = now + 3600;
        const steps = [10, 10, 11, 11, 11, 12, 12, 13, 13, 13, 14, 14, 15];
        const five = { kind: 'five', from: now - 86400, to: now, pts: steps.map((v, i) => [t0 + i * 600, v, R]) };
        const rates = steps.slice(7).map((_, k) => p.hoverAt(five, t0 + (6 + k) * 600 + 300).rate);
        assert.ok(rates.every((r) => r === '+2.0%/h' || r === '+3.0%/h'), rates.join(' '));
        const d2 = now - 3 * 86400;
        const week = { kind: 'week', from: now - 7 * 86400, to: now, pts: [[d2, 40, R], [d2 + 86400 - 600, 40, R], [d2 + 86400, 41, R]] };
        assert.strictEqual(p.hoverAt(week, d2 + 86400 - 300).rate, '+1.0%/day', 'one 1% tick after a flat day is 1%/day, not 144%/day');
        assert.strictEqual(p.hoverAt({ ...five, pts: [[t0, 10, R], [t0 + 600, 12, R], [t0 + 1200, 3, R]] }, t0 + 900).rate, 'reset');
    });

    await check('History spans come from the host\'s d.histRange (it matches the series); ui.histRange only picks the tab (review finding)', () => {
        const p = panel(), d = withHist(rising);
        const html = p.render({ ...d, histRange: '24h' }, ui({ view: 'history', histRange: '30d' }));
        assert.ok(html.includes('aria-selected="true" data-a="hrange" data-l="30d"'), 'the tab the user picked');
        assert.ok(html.includes('Weekly (7 day) · last 24h') && !html.includes('last 30d'), 'the spans of the series that arrived');
        const src = readWv('panel.js');
        assert.match(src, /const paint = [\s\S]*?showHover\(/, 'a repaint (every 60 s poll) re-runs the last hover, so the tooltip stays');
        assert.match(src, /pointerleave', \(\) => \{ hover = null;/, 'leaving the chart forgets it');
    });

    await check('hover: a repaint keeps the tooltip only on the same chart (account, limit, span), not on whatever chart now has its index (review finding)', () => {
        const p = panel(), d = withHist(rising, { '004': [pt(60, 46, 13)] }), g = ui({ view: 'history', histLayout: 'grid' });
        p.render(d, g);
        const k0 = p.chartKey(0), k2 = p.chartKey(2);
        assert.ok(k0 && k2 && k0 !== k2 && k0 !== p.chartKey(1), 'each chart has its own key');
        p.render({ ...d, now: d.now + 60 }, g);
        assert.strictEqual(p.chartKey(0), k0, 'the next poll (now moved on): the same chart, so the tooltip stays');
        p.render({ ...d, history: [...d.history].reverse() }, g);
        assert.notStrictEqual(p.chartKey(0), k0, 'the order changed: index 0 is another account, so the tooltip goes');
        p.render({ ...d, histRange: '30d' }, g);
        assert.notStrictEqual(p.chartKey(0), k0, 'another span: another chart');
        assert.strictEqual(p.chartKey(99), null, 'no chart at that index');
        const src = readWv('panel.js');
        assert.match(src, /hover = \{ cid: svg\.dataset\.cid, f, key: chartKey\(svg\.dataset\.cid\) \}/, 'the hover stores the chart key');
        assert.match(src, /const paint = [\s\S]*?hover && hover\.key === chartKey\(hover\.cid\)[\s\S]*?hover = null/, 'a repaint re-shows it only for the same key, else drops it');
    });

    await check('payload: no history series unless the History tab is shown; the host downsamples to the chart width (review finding)', () => {
        const N = 31 * 144, h30 = Array.from({ length: N }, (_, i) => ({ t: now - (N - 1 - i) * 600, p5: (i % 30) * 3, p7: 10 + i / 1000,
            r5: now + Math.floor(i / 30) * 18000, r7: now + 86400 }));
        const a = four().map((x) => ({ ...x, history: x.label === '002' ? h30 : [] }));
        const off = e.panelData(a, capOf(a, '002', ['003']), { ...opts, histRange: '30d' });
        assert.deepStrictEqual(off.history, [], 'History hidden: no series at all');
        const on = e.panelData(a, capOf(a, '002', ['003']), { ...opts, histRange: '30d', historyOn: true }), s = on.history[0].fiveSeries;
        const inRange = h30.filter((x) => x.t >= now - 30 * 86400), starts = inRange.filter((x, i) => i && x.p5 < inRange[i - 1].p5);
        assert.ok(s.length <= 300 + 2 * starts.length && s.length < inRange.length / 3, s.length + ' points of ' + inRange.length);
        assert.ok(starts.every((x) => s.some((q) => q[0] === x.t)), 'every window start is kept');
        assert.strictEqual(s[s.length - 1][0], h30[N - 1].t, 'the newest point is kept');
        assert.ok(on.history[0].weekSeries.length <= 302, 'weekly: one point per column');
        const pace = e.panelData(four().map((x) => ({ ...x, history: x.label === '002' ? rising : [] })), capOf(four(), '002', ['003']), opts);
        assert.deepStrictEqual([pace.history, /^Full in/.test(pace.active.fivePace)], [[], true], 'the Accounts pace line still works');
    });

    await check('hover: each chart carries a guide line and a tooltip box, the wiring uses listeners (no inline handlers), and text goes in as text', () => {
        const p = panel(), html = p.render(withHist(rising), ui({ view: 'history' }));
        assert.strictEqual(html.split('class="gl"').length - 1, 2, 'a guide line in each of the two charts');
        assert.strictEqual(html.split('class="tip"').length - 1, 2);
        assert.ok(!/ on[a-z]+=/.test(html), 'no inline handlers: the CSP');
        const src = readWv('panel.js');
        assert.match(src, /root\.addEventListener\('pointermove'/);
        assert.match(src, /tip\.textContent = /);
        assert.ok(!/tip\.innerHTML/.test(src));
        assert.match(src, /Math\.min\(box\.width - tip\.offsetWidth/, 'the tooltip is clamped inside the chart box');
        assert.ok(/script-src 'unsafe-inline'/.test(e.webviewHtml(fakeWebview)) && /default-src 'none'/.test(e.webviewHtml(fakeWebview)), 'CSP unchanged');
    });

    await check('range: the selector (Auto | 24h | 7d | 30d) sets both charts\' span; Auto keeps 24h + 7d; a click persists and tells the host', () => {
        const p = panel(), d = withHist(rising);
        const seg = (u) => p.render({ ...d, histRange: u.histRange }, ui({ view: 'history', ...u }));
        const det = (h) => h.slice(h.indexOf('<div class="det">'));
        const auto = seg({});
        assert.ok(auto.includes('aria-selected="true" data-a="hrange" data-l="auto"'), 'default is Auto');
        for (const k of ['24h', '7d', '30d']) assert.ok(auto.includes('data-a="hrange" data-l="' + k + '"'), k);
        assert.ok(det(auto).includes('Session (5hr) \u00b7 last 24h') && det(auto).includes('Weekly (7 day) \u00b7 last 7d'), 'Auto = today\'s look');
        const m = det(seg({ histRange: '30d' }));
        assert.ok(m.includes('Session (5hr) \u00b7 last 30d') && m.includes('Weekly (7 day) \u00b7 last 30d') && m.split('30d ago').length - 1 === 2, 'both charts reach 30d');
        assert.ok(seg({ histRange: '30d' }).includes('aria-selected="true" data-a="hrange" data-l="30d"'));
        const d24 = det(seg({ histRange: '24h' }));
        assert.ok(d24.includes('Weekly (7 day) \u00b7 last 24h') && d24.includes('24h ago'));
        assert.ok(det(seg({ histRange: 'bogus' })).includes('last 24h'), 'an unknown range falls back to Auto');
        const src = readWv('panel.js');
        assert.match(src, /else if \(a === 'hrange'\) \{ ui\.histRange = l; vsc\.postMessage\(\{ histRange: l \}\);/, 'the click stores the range in ui (vsc.setState below it, as statsRange) and asks the host');
        assert.match(src, /vsc\.setState\(ui\);\s*paint\(\);/);
    });

    await check('range: the host sends the series for the range (Auto 24h + 7d, else both), keeps 30 days, and the forecast does not change', async () => {
        const hist = [pt(20 * 86400, 5, 5, now - 19 * 86400), pt(2 * 86400, 70, 40, now - 86400), ...rising];
        const mk = (histRange) => { const a = four().map((x) => ({ ...x, history: x.label === '002' ? hist : [] })); return e.panelData(a, capOf(a, '002', ['003']), { ...opts, histRange, historyOn: true }); };
        const h = (r) => mk(r).history[0];
        assert.deepStrictEqual([h('auto').fiveSeries.length, h('auto').weekSeries.length], [3, 4], 'Auto = 24h session, 7d weekly');
        assert.deepStrictEqual([h('24h').fiveSeries.length, h('24h').weekSeries.length], [3, 3]);
        assert.deepStrictEqual([h('7d').fiveSeries.length, h('7d').weekSeries.length], [4, 4]);
        assert.deepStrictEqual([h('30d').fiveSeries.length, h('30d').weekSeries.length], [5, 5], 'the 20-day-old point shows at 30d');
        assert.strictEqual(mk('30d').histRange, '30d'); assert.strictEqual(mk('nope').histRange, 'auto');
        assert.strictEqual(mk('constructor').histRange, 'auto');
        for (const r of ['24h', '7d', '30d']) assert.deepStrictEqual([h(r).fivePace, h(r).weekPace], [h('auto').fivePace, h('auto').weekPace], 'Full in X at this pace is the same for ' + r);
        assert.match(h('30d').fivePace, /^Full in 2h (19|20)m at this pace$/);
        assert.strictEqual(e.readHistory('x', now).length, 0);
    });

    await check('range: the host remembers the range from {histRange} (and {wantHistory, histRange}) and ignores a bad one', async () => {
        const f = path.join(ACC, 'work', '.usage-history.jsonl');
        fs.writeFileSync(f, [pt(15 * 86400, 5, 5), pt(60, 50, 40)].map((x) => JSON.stringify(x)).join('\n') + '\n');
        const posted = [], ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(HOME, 'gs') }, globalState: memento(false) };
        let provider, onMsg;
        const keep = { win: { ...vscode.window }, commands: vscode.commands, ws: vscode.workspace.onDidChangeConfiguration };
        Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: (id, p) => { provider = p; return { dispose() {} }; } });
        vscode.StatusBarAlignment = { Right: 2 };
        vscode.commands = { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} };
        vscode.extensions = { getExtension: () => undefined };
        vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} });
        try {
            load().activate(ctx);
            provider.resolveWebviewView({ visible: true, onDidChangeVisibility: () => {}, onDidDispose: () => {},
                webview: { ...fakeWebview, postMessage: async (m) => { posted.push(m); }, onDidReceiveMessage: (f) => { onMsg = f; } } });
            const last = () => posted.filter((m) => m.kind !== 'stats' && m.kind !== 'busy').pop();
            onMsg({ wantHistory: true, histRange: '30d' });
            assert.deepStrictEqual([last().histRange, last().history[0].weekSeries.length], ['30d', 2]);
            onMsg({ histRange: '24h' });
            assert.deepStrictEqual([last().histRange, last().history[0].weekSeries.length], ['24h', 1]);
            onMsg({ wantHistory: true });
            assert.strictEqual(last().histRange, '24h', 'a view change alone keeps the range');
            onMsg({ histRange: '__proto__' });
            assert.strictEqual(last().histRange, 'auto');
        } finally {
            fs.rmSync(f, { force: true });
            for (const d of ctx.subscriptions) if (d && d.dispose) d.dispose();
            Object.assign(vscode.window, keep.win); vscode.commands = keep.commands; vscode.workspace.onDidChangeConfiguration = keep.ws;
        }
    });

    await check('downsample: 30 days of samples are capped near one point per pixel column; resets and the line shape survive', () => {
        const p = panel(), N = 30 * 144, from = now - 30 * 86400;
        const raw = Array.from({ length: N }, (_, i) => [from + i * 600, (i % 30) * 3, now + 3600 + Math.floor(i / 30) * 18000]);  // a reset every 30 samples
        const out = p.downsample(raw, from, now, 300);
        const resets = raw.filter((q, i) => i && newW(q, raw[i - 1])).length;
        function newW(q, b) { return q[1] < b[1]; }
        assert.ok(out.length <= 300 + 2 * resets, out.length + ' points');
        assert.ok(out.length < N / 3, 'much fewer than the ' + N + ' samples');
        assert.ok(raw.filter((q, i) => i && newW(q, raw[i - 1])).every((q) => out.includes(q)), 'every window start is kept');
        assert.strictEqual(out[out.length - 1], raw[N - 1], 'the newest point is kept');
        assert.ok(out.every((q, i) => !i || q[0] > out[i - 1][0]), 'time order kept');
        const few = raw.slice(0, 100);
        assert.strictEqual(p.downsample(few, from, now, 300), few, 'a short series is untouched');
    });

    await check('downsample: the drawn chart carries the capped points (render on a 30d series)', () => {
        const p = panel(), d = withHist(rising), N = 4320, from = now - 30 * 86400;
        const series = Array.from({ length: N }, (_, i) => [from + i * 600, 10 + (i % 50) / 2, now + 4 * 3600]);
        const big = { ...d, histRange: '30d', history: [{ ...d.history[0], fiveSeries: series, weekSeries: series }] };
        const html = p.render(big, ui({ view: 'history', histRange: '30d' }));
        const total = (html.match(/points="[^"]*"/g) || []).join(' ').split(' ').length;
        assert.ok(total < 2 * N / 5, 'drawn points: ' + total + ' (raw ' + 2 * N + ')');
    });

    await check('layout: List is the default (rows that expand); Grid shows every account\'s two charts at once, with hover and range', () => {
        const p = panel(), d = withHist(rising, { '004': [pt(60, 46, 13)] });
        const list = p.render(d, ui({ view: 'history' })), grid = p.render(d, ui({ view: 'history', histLayout: 'grid' }));
        assert.ok(list.includes('aria-pressed="true" title="List view" aria-label="List view" data-a="hlay" data-l="list"') && list.includes('aria-pressed="false" title="Grid view" aria-label="Grid view" data-a="hlay" data-l="grid"') && list.includes('codicon-list-flat') && list.includes('codicon-table') && !list.includes('>List<') && !list.includes('class="hgrid"'), 'default = List');
        assert.strictEqual(list.split('<svg').length - 1, 2, 'List: only the open row\'s two charts');
        assert.ok(grid.includes('aria-pressed="true" title="Grid view" aria-label="Grid view" data-a="hlay" data-l="grid"') && grid.includes('aria-pressed="false" title="List view" aria-label="List view" data-a="hlay" data-l="list"') && grid.includes('class="hgrid"'));
        assert.ok(!grid.includes('data-a="hrow"'), 'Grid has no expanding rows');
        assert.strictEqual(grid.split('class="card"').length - 1, 2, 'one card per account with history');
        assert.strictEqual(grid.split('<svg').length - 1, 4, 'Grid: both charts of both accounts');
        assert.strictEqual(grid.split('class="gl"').length - 1, 4, 'hover works in Grid: each chart has its guide line');
        assert.ok(grid.includes('data-l="002"') === false && grid.includes('>002<') && grid.includes('>004<'), 'cards are titled by account');
        const g30 = p.render({ ...d, histRange: '30d' }, ui({ view: 'history', histLayout: 'grid', histRange: '30d' }));
        assert.strictEqual(g30.split('last 30d').length - 1, 8, 'range applies to every card: title and aria-label of 4 charts');
        assert.ok(p.render(d, ui({ view: 'history', histLayout: 'bogus' })).includes('class="rows"'), 'unknown layout = List');
        assert.ok(p.render({ ...d, history: [] }, ui({ view: 'history', histLayout: 'grid' })).includes('No history yet'));
        const css = readWv('panel.css');
        assert.match(css, /\.hgrid \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(min\(240px, 100%\), 1fr\)\)/, 'columns follow the panel width; one column fits any sidebar width (review finding)');
        assert.ok(!/animation|transition/.test(css.slice(css.indexOf('.hctl'))), 'nothing animated in the new styles (reduced motion)');
        const src = readWv('panel.js');
        assert.match(src, /else if \(a === 'hlay'\) ui\.histLayout = l;/, 'the click stores the layout in ui, which is saved with vsc.setState(ui) like statsRange');
    });

    await check('render: History empty state, escaping, an 80%+ chart is orange', () => {
        const p = panel();
        assert.ok(p.render(withHist([]), ui({ view: 'history' })).includes('No history yet'));
        const team = p.render({ ...withHist(rising), team: true }, ui({ view: 'history' }));
        assert.ok(team.includes('not shown for a team usage file') && !team.includes('<svg'), 'team file: a short note, no local charts');
        const src = readWv('panel.js');
        assert.match(src, /vsc\.postMessage\(\{ wantHistory: l === 'history' \}\)/, 'switching views tells the host whether History is shown');
        assert.match(src, /vsc\.postMessage\(\{ wantHistory: viewOf\(ui\) === 'history', histRange: histRangeOf\(ui\) \}\);\s*vsc\.postMessage\('ready'\)/, 'and so does a reload on the History tab');
        const bad = '<img src=x onerror="a()">';
        const d = { ...withHist(rising), history: [{ label: bad, icon: 'switch', tip: 't', five: 85, week: 10,
            fiveSeries: [[now, 85, null]], weekSeries: [], fivePace: '<b>', weekPace: null }] };
        const html = p.render(d, ui({ view: 'history' }));
        assert.ok(!html.includes('<img src=x') && !html.includes('<b>') && html.includes('&lt;b&gt;'));
        assert.match(html, /<div class="ch hi"><div class="top"><span>Session/, '85% now: orange line');
        assert.match(html, /<polyline class="ln" points="297\.0,8\.4 300\.0,8\.4"\/>/, 'a lone point is a short dash that ends at "now", inside the chart');
    });
});
