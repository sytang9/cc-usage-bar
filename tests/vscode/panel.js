// VS Code sidebar tests: the webview page (esc, CSP, codicons), reset display, and the native panel render.
'use strict';
const {
    assert, fs, path, ACC, now, check, run, vscode, fakeWebview, file, e, acct, capOf, four, opts, pdFour, readWv,
    panel, ui, rowOf,
} = require('./harness');

run(async () => {
    await check('esc makes a label safe as HTML text and inside a quoted attribute', () => {
        assert.strictEqual(e.esc('<img src=x onerror="a()">&\''), '&lt;img src=x onerror=&quot;a()&quot;&gt;&amp;&#39;');
        assert.strictEqual(e.esc('work-2'), 'work-2');
        assert.strictEqual(e.esc(42), '42');
    });

    await check('the webview locks itself down with a CSP and carries esc; no iframe', () => {
        const html = e.webviewHtml(fakeWebview);
        const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)[1];
        assert.strictEqual(csp, "default-src 'none'; style-src 'unsafe-inline' https://res.test; font-src https://res.test; script-src 'unsafe-inline'; img-src data:",
            'only font-src and style-src gain the webview source');
        assert.ok(html.includes('function esc('), 'the page carries the same esc as the extension');
        assert.ok(html.includes('function render('), 'the page carries the panel script');
        assert.ok(!html.includes('<iframe'));
        assert.strictEqual(html.split('</script>').length, 2, 'one inline script, nothing in it closes it early');
    });

    await check('codicons: the page links the vendored codicon.css through asWebviewUri; font and licence ship with it', () => {
        const html = e.webviewHtml(fakeWebview);
        assert.ok(html.includes('<link rel="stylesheet" href="https://res.test' + path.join(e.CODICONS, 'codicon.css') + '">'));
        for (const f of ['codicon.css', 'codicon.ttf', 'LICENSE']) assert.ok(fs.existsSync(path.join(e.CODICONS, f)), f);
        assert.match(fs.readFileSync(path.join(e.CODICONS, 'codicon.css'), 'utf8'), /url\("\.\/codicon\.ttf/, 'the font loads from next to the css');
        assert.ok(fs.readFileSync(path.join(__dirname, '..', '..', 'README.md'), 'utf8').includes('`@vscode/codicons` 0.0.46-24'), 'README names the vendored version');
        const src = fs.readFileSync(file, 'utf8');
        assert.match(src, /localResourceRoots: \[vscode\.Uri\.file\(CODICONS\)\]/, 'the webview may load the codicons folder and nothing else');
    });

    await check('resetText: in 48m / Fri 01:00 / now; short drops minutes and clock', () => {
        const t = Date.now() / 1000;
        const later = (secs) => new Date((t + secs) * 1000).toDateString() === new Date(t * 1000).toDateString();
        if (later(48 * 60 + 30)) assert.strictEqual(e.resetText(t + 48 * 60 + 30), 'in 48m');
        if (later(4 * 3600 + 12 * 60 + 30)) {
            assert.strictEqual(e.resetText(t + 4 * 3600 + 12 * 60 + 30), 'in 4h 12m');
            assert.strictEqual(e.resetText(t + 4 * 3600 + 12 * 60 + 30, true), 'in 4h');
        }
        assert.match(e.resetText(t + 3 * 86400), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/);
        assert.match(e.resetText(t + 3 * 86400, true), /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/);
        assert.strictEqual(e.resetText(t + 10), 'now');
        assert.ok(!/⟳/.test(fs.readFileSync(file, 'utf8')), 'no ⟳ symbol: the panel says "Resets"');
    });

    await check('a window whose reset passed after the fetch shows 0%, not the old window\'s percent', () => {
        const a = { label: 'x', provider: 'claude', state: 'ok', fetched_at: now - 240, five_pct: 32, week_pct: 96,
            five_reset_epoch: now - 240 + 1, week_reset_epoch: now + 86400 };
        const r = e.rolled(a, now);
        assert.deepStrictEqual([r.five_pct, r.five_reset_epoch, r.week_pct, r.week_reset_epoch], [0, null, 96, now + 86400]);
        assert.strictEqual(a.five_pct, 32, 'the input is not changed');
        const full = e.rolled({ ...a, five_pct: 10, week_pct: 100, week_reset_epoch: now - 60 }, now);
        assert.strictEqual(full.week_pct, 0, 'a full week that has reset is free again');
        const after = e.rolled({ ...a, fetched_at: now - 30, five_reset_epoch: now - 60 }, now);
        assert.strictEqual(after.five_pct, 32, 'numbers fetched after the reset time are already the new window');
        assert.deepStrictEqual(e.rolled({ ...a, fetched_at: null }, now).five_pct, 32, 'no fetch time: nothing to judge');
    });

    await check('reset roll: only fresh data rolls to 0%; an older row shows a dash; a null percent stays null (review finding)', () => {
        const a = { label: 'x', provider: 'claude', state: 'ok', fetched_at: now - 13 * 86400, five_pct: 32, week_pct: 100,
            five_reset_epoch: now - 3600, week_reset_epoch: now - 86400 };
        const old = e.rolled(a, now);
        assert.deepStrictEqual([old.five_pct, old.five_reset_epoch, old.week_pct, old.week_reset_epoch], [null, null, null, null],
            'a 13-day-old row: the old percent is over and 0% would be a guess');
        const pd = e.panelData([{ ...old, email: null }], { you: null, best: null, loads: {}, fresh: {}, saved: ['x'], relogin: [] }, { now, installed: true, auto: false });
        assert.notStrictEqual(pd.rows[0].icon, 'full', 'no full icon for a window that has reset');
        assert.strictEqual(pd.rows[0].summary, 'No recent data');
        const edge = e.rolled({ ...a, fetched_at: now - 1799, five_reset_epoch: now - 60 }, now);
        assert.strictEqual(edge.five_pct, 0, 'inside the 30-min display window: rolled to 0%');
        const none = e.rolled({ ...a, fetched_at: now - 240, five_pct: null, week_pct: null, five_reset_epoch: now - 60, week_reset_epoch: now - 60 }, now);
        assert.deepStrictEqual([none.five_pct, none.week_pct], [null, null], 'a missing percent never becomes a real 0%');
        assert.strictEqual(e.qualifies(none, { you: 'other', isSaved: () => true, relogin: new Set(), now }), false);
        assert.strictEqual(e.capacity({ accounts: [none] }, { you: 'other', isSaved: () => true, relogin: new Set(), now }).best, null);
    });

    await check('readAccounts applies the reset: the panel and the switch choice see 0%', () => {
        const f = path.join(ACC, 'personal', '.usage-cache'), keep = fs.readFileSync(f, 'utf8');
        try {
            fs.writeFileSync(f, JSON.stringify({ fetched_at: now - 300, five_hour_pct: 100, seven_day_pct: 5, five_hour_reset_epoch: now - 120, seven_day_reset_epoch: now + 86400 }));
            const p = e.readAccounts().accounts.find((a) => a.label === 'personal');
            assert.deepStrictEqual([p.five_pct, p.five_reset_epoch], [0, null]);
        } finally { fs.writeFileSync(f, keep); }
    });

    // --- the native panel (vscode/webview/panel.*) ---------------------------------------------------
    await check('B4 no hard-coded colour in the panel', () => {
        const src = readWv('panel.css') + readWv('panel.js') + e.webviewHtml(fakeWebview);
        assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src), 'hex colour: ' + (src.match(/#[0-9a-fA-F]{3,8}\b/) || [])[0]);
        assert.ok(!/\b(rgba?|hsla?)\(/.test(src), 'rgb()/hsl()');
        assert.ok(!/:\s*(white|black)\b/.test(src), 'named colour');
        const vars = src.match(/var\(--[\w-]*/g) || [];
        assert.ok(vars.length > 0 && vars.every((v) => v.startsWith('var(--vscode-')), 'only --vscode-* variables');
    });

    await check('bar colour follows the level, not the limit: blue under 80%, orange from 80%', () => {
        const p = panel(), d = pdFour();
        const bars = (act) => [...p.render({ ...d, active: { ...d.active, ...act } }, ui()).matchAll(/class="(bar[^"]*)"><i style="width:(\d+)%"/g)].map((m) => m[1] + ' ' + m[2]);
        assert.deepStrictEqual(bars({ five: 22, week: 95 }), ['bar 22', 'bar hi 95'], 'the 95% weekly is orange, the 22% session is blue');
        assert.deepStrictEqual(bars({ five: 80, week: 79 }), ['bar hi 80', 'bar 79']);
        assert.deepStrictEqual(bars({ five: 100, week: 0 }), ['bar hi 100', 'bar 0']);
    });

    await check('B4 the panel uses theme variables: blue bars, orange from 80%, no traffic lights', () => {
        const css = readWv('panel.css');
        for (const v of ['--vscode-charts-orange', '--vscode-progressBar-background', '--vscode-textLink-foreground', '--vscode-button-background',
            '--vscode-editorWarning-foreground', '--vscode-errorForeground', '--vscode-contrastBorder', '--vscode-contrastActiveBorder']) assert.ok(css.includes(v), v);
        assert.ok(!/charts-(green|yellow|red)/.test(css + readWv('panel.js')), 'no traffic-light bar colours');
        assert.match(css, /\.grp, \.kv \.k, \.rs[^{]*\{ opacity: \.\d+; \}/, 'secondary text is dimmed in every theme, not only where descriptionForeground is grey');
    });

    await check('render: codicons replace the emoji and Unicode symbols', () => {
        const p = panel();
        const all = [p.render(pdFour(), ui({ automationOpen: true })), p.render(pdFour(), ui({ openRow: '003' })), readWv('panel.js'), readWv('panel.css')].join('');
        for (const ch of ['⛔', '⚠', '⇄', '●', '◷', '⟳', '▾', '▸', '›', '⌄', '✉']) assert.ok(!all.includes(ch), ch);
        assert.ok(!all.replace(/<svg (viewBox=|class="hm")/g, '').includes('<svg'), 'no SVG icons: the only SVGs are the charts and the heatmap');
        assert.ok(all.includes('codicon-chevron-down') && all.includes('codicon-chevron-right'));
    });

    await check('render: Active account has ACCOUNT and USAGE groups, nickname, email, both limits and their resets', () => {
        const html = panel().render(pdFour(), ui());
        for (const t of ['Active account', '>Account<', '>Usage<', 'Nickname', '002@x.example', 'Session (5hr)', 'Weekly (7 day)', '>23%<', '>64%<'])
            assert.ok(html.includes(t), t);
        assert.match(html, />Resets (in \d+m|in \d+h \d+m|tomorrow \d\d:\d\d)</, 'the session reset (1h away; after 23:00 that is tomorrow)');
        assert.match(html, /class="bar"><i style="width:23%"/, 'the session bar is 23% long, theme blue');
        assert.match(html, /class="bar"><i style="width:64%"/, 'the weekly bar is 64% long, theme blue');
        assert.ok(!html.includes('Last data'), 'fresh data: no data age');
    });

    await check('render: every section folds; the header keeps its title', () => {
        const p = panel();
        const shut = p.render(pdFour(), ui({ activeOpen: false, nextOpen: false }));
        assert.ok(shut.includes('Active account') && shut.includes('If you run out'));
        assert.ok(!shut.includes('Session (5hr)') && !shut.includes('data-a="switch"'));
        assert.match(shut, /data-a="active"[^>]*aria-expanded="false"/);
    });

    await check('render: no account to switch to', () => {
        const a = [acct('001', 5, 5, now - 7200), acct('002', 23, 64, now - 60)];
        const html = panel().render(e.panelData(a, capOf(a, '002'), opts), ui());
        assert.ok(html.includes('No account to switch to'));
        assert.ok(!html.includes('data-a="switch"'));
    });

    await check('render: next-best line names the account, both limits, one Switch button; no ccswitch -> Install', () => {
        const html = panel().render(pdFour(), ui());
        assert.match(html, /codicon-arrow-swap[\s\S]*004[\s\S]*Session 46% · Weekly 13%[\s\S]*data-a="switch" data-l="004"/);
        assert.strictEqual(html.split('data-a="switch"').length - 1, 1, 'one Switch button while the rows are closed');
        const a = four();
        const bare = panel().render(e.panelData(a, capOf(a, '002', ['003']), { ...opts, installed: false }), ui());
        assert.ok(bare.includes('data-a="install"') && bare.includes('Install ccswitch'));
        assert.ok(!bare.includes('data-a="switch"'));
    });

    await check('render: Accounts header says how many are saved, open or collapsed', () => {
        const p = panel();
        assert.ok(p.render(pdFour(), ui()).includes('4 saved'));
        const closed = p.render(pdFour(), ui({ accountsOpen: false }));
        assert.ok(closed.includes('4 saved') && !closed.includes('data-a="row"'), 'collapsed: count, no rows');
    });

    await check('render: each row has its status codicon with a tooltip and one grey summary', () => {
        const html = panel().render(pdFour(), ui());
        const want = { '001': ['circle-slash', 'A limit is at 100%', /Weekly full · resets \w+/], '002': ['circle-filled', 'Active account', /23% · 64%/],
            '003': ['warning', 'Needs re-login', /Re-login needed/], '004': ['arrow-swap', 'You can switch here', /46% · 13%/] };
        for (const [label, [icon, tip, summary]] of Object.entries(want)) {
            const r = rowOf(html, label);
            assert.ok(r.includes('codicon-' + icon), label + ' icon ' + icon);
            assert.ok(r.includes('title="' + tip + '"'), label + ' tooltip');
            assert.match(r, summary, label + ' summary');
            assert.ok(!r.includes('class="bar'), label + ': no bars in a row');
        }
    });

    await check('panelData: summaries say full / re-login / stale / percentages', () => {
        const a = [acct('001', 100, 5, now - 60, { five_reset_epoch: now + 3 * 3600 + 120 }), acct('002', 23, null, now - 60),
            acct('003', 5, 5, now - 7200), acct('004', 50, 100, now - 60, { week_reset_epoch: now - 3600 })];
        const s = Object.fromEntries(e.panelData(a, capOf(a, '002', []), opts).rows.map((r) => [r.label, r.summary]));
        assert.match(s['001'], /^Session full · resets (in 3h|tomorrow)$/);
        assert.strictEqual(s['002'], '23% · –');
        assert.strictEqual(s['003'], 'No recent data');
        assert.strictEqual(s['004'], 'Weekly full', 'a past reset is not named');
        const old = [acct('002', 23, 64, now - 60), acct('005', 5, 100, now - 7200)];
        assert.strictEqual(e.panelData(old, capOf(old, '002', []), opts).rows[1].summary, 'No recent data', 'stale data is not shown as a current full');
    });

    await check('render: a missing window shows –, not 0% or NaN', () => {
        const a = [acct('002', 23, 64, now - 60), acct('half', null, 30, now - 60, { five_reset_epoch: null })];
        const html = panel().render(e.panelData(a, capOf(a, 'half'), opts), ui());
        assert.ok(html.includes('>–<') && !html.includes('NaN') && !html.includes('null'));
        assert.ok(rowOf(html, 'half').includes('– · 30%'));
    });

    await check('render: escapes every label', () => {
        const bad = '<img src=x onerror="a()">';
        const a = [acct(bad, 5, 5, now - 60, { email: '"><b>x@y' }), acct('002', 23, 64, now - 60)];
        const d = e.panelData(a, capOf(a, bad), opts);
        d.next = { label: bad, five: 1, week: 1 };
        for (const html of [panel().render(d, ui()), panel().render(d, ui({ openRow: bad }))]) {
            assert.ok(html.includes('&lt;img'));
            assert.ok(!html.includes('<img src=x'));
            assert.ok(!html.includes('onerror="'), 'no raw quote inside an attribute');
            assert.ok(!html.includes('"><b>x@y') && html.includes('&quot;&gt;&lt;b&gt;x@y'), 'the email is escaped');
        }
    });

    await check('render: the active email shows in Active account; other emails only in an open row', () => {
        const p = panel();
        const shut = p.render(pdFour(), ui());
        assert.strictEqual(shut.split('@').length - 1, 1, 'one email: the active one');
        assert.ok(shut.includes('002@x.example'));
        const open = p.render(pdFour(), ui({ openRow: '001' }));
        assert.strictEqual(open.split('001@x.example').length - 1, 1);
        assert.ok(open.includes('data-a="delete" data-l="001"'));
        assert.match(rowOf(open, '001'), /codicon-chevron-down/, 'the open row points down');
        assert.match(rowOf(open, '004'), /codicon-chevron-right/);
    });

    await check('render: open row details are key-value rows; Switch is a button, the rest text links', () => {
        const html = panel().render(pdFour(), ui({ openRow: '003' }));
        const det = html.slice(html.indexOf('<div class="det">'));
        for (const t of ['Email', '003@x.example', 'Last data', '13d old', 'How to re-login', 'Delete']) assert.ok(det.includes(t), t);
        assert.match(det, /class="lnk" data-a="relogin" data-l="003"/);
        assert.ok(!det.includes('Session (5hr)'), 'stale numbers are not shown as current');
        const fresh = panel().render(pdFour(), ui({ openRow: '004' }));
        const d4 = fresh.slice(fresh.indexOf('<div class="det">'));
        assert.ok(d4.includes('Session (5hr)') && d4.includes('46%') && d4.includes('resets ') && d4.includes('>Switch<'));
        assert.match(d4, /<button class="btn" data-a="switch" data-l="004">Switch</, 'Switch is a filled button, like the one in If you run out');
        assert.match(d4, /<button class="lnk" data-a="delete" data-l="004"/, 'Delete stays a text link');
    });

    await check('render: auto-switch toggle says its state', () => {
        const p = panel(), open = ui({ automationOpen: true });
        assert.match(p.render(pdFour(), open), /role="switch"[^>]*aria-checked="false"/);
        assert.match(p.render({ ...pdFour(), auto: true }, open), /role="switch"[^>]*aria-checked="true"/);
        assert.ok(p.render({ ...pdFour(), auto: true }, ui()).includes('>On<'), 'the collapsed header still shows the state');
        assert.ok(p.render(pdFour(), ui()).includes('>Off<'));
    });

    await check('render: Automation is collapsed by default and holds the toggle and a visible line', () => {
        const p = panel();
        const shut = p.render(pdFour(), ui());
        assert.ok(!shut.includes('role="switch"'));
        assert.ok(shut.includes('Automation') && /data-a="automation"[^>]*aria-expanded="false"/.test(shut));
        const open = p.render(pdFour(), ui({ automationOpen: true }));
        assert.strictEqual(open.split('role="switch"').length - 1, 1);
        assert.match(open, /role="switch"[^>]*aria-checked="false"/);
        assert.ok(open.includes('Auto-switch at 100%'));
        assert.ok(open.includes('Asks once when you turn it on.'), 'one visible line, not only a tooltip');
        assert.ok(!p.render({ ...pdFour(), installed: false }, ui({ automationOpen: true })).includes('role="switch"'), 'no ccswitch, no toggle');
    });

    await check('no View details link: Claude Code\'s own Account & Usage section has the full dialog', () => {
        const all = panel().render(pdFour(), ui()) + readWv('panel.js') + fs.readFileSync(file, 'utf8');
        assert.ok(!all.includes('View details') && !all.includes('openUsage') && !all.includes('claude.ai/settings'));
    });

    await check('Accounts list ends with a "+ Add account" row; a click posts {add:1}; hidden without ccswitch', () => {
        const html = panel().render(pdFour(), ui());
        const rows = html.slice(html.indexOf('class="rows"'));
        assert.ok(/codicon-add/.test(rows) && /data-a="add"[^>]*>[\s\S]*Add account/.test(rows), 'the row is rendered');
        assert.ok(rows.lastIndexOf('data-a="add"') > rows.lastIndexOf('data-a="row"'), 'at the end of the list');
        assert.ok(!panel().render({ ...pdFour(), installed: false }, ui()).includes('data-a="add"'), 'no ccswitch: install button instead');
        let onClick;
        const sent = [], root = { innerHTML: '', addEventListener: (t, f) => { if (t === 'click') onClick = f; }, querySelector: () => null, querySelectorAll: () => [] };
        const ctx = { esc: e.esc, document: { getElementById: () => root, activeElement: null },
            window: { addEventListener() {} },
            acquireVsCodeApi: () => ({ getState: () => null, setState() {}, postMessage: (m) => sent.push(m) }), Date };
        require('vm').runInNewContext(readWv('panel.js'), ctx);
        sent.length = 0; onClick({ target: { closest: () => ({ dataset: { a: 'add' } }) } });
        assert.deepStrictEqual(JSON.parse(JSON.stringify(sent)), [{ add: 1 }]);
    });
});
