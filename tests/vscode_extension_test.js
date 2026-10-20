// Unit tests for vscode/extension.js. Loads the extension with a stub `vscode` module in a sandboxed HOME
// (set by vscode_extension_test.sh) and a stub ccswitch that only records its arguments. Never touches ~/.claude.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const HOME = process.env.HOME;
// This file writes ~/.claude.json and ~/.claude/ccswitch: refuse unless vscode_extension_test.sh made a sandbox HOME.
if (process.env.CCUB_TEST_SANDBOX !== '1' || !path.resolve(HOME || '/').startsWith(path.resolve(require('os').tmpdir()) + path.sep)) {
    console.error('Refusing to run: this test writes into $HOME. Run it with: bash tests/vscode_extension_test.sh');
    process.exit(2);
}
const ACC = path.join(HOME, '.claude', 'accounts');
const LOG = path.join(HOME, 'ccswitch.log');
const now = Math.floor(Date.now() / 1000);
let passed = 0, failed = 0;
const check = async (name, fn) => {
    try { await fn(); passed++; console.log('PASS: ' + name); } catch (e) { failed++; console.log('FAIL: ' + name + ' -- ' + e.message); }
};

// --- sandbox: three saved accounts, live login = "work", stub ccswitch --------------------------
function seat(label, email, cache) {
    fs.mkdirSync(path.join(ACC, label), { recursive: true });
    fs.writeFileSync(path.join(ACC, label, 'credentials.json'), '{}');
    fs.writeFileSync(path.join(ACC, label, 'oauthAccount.json'), JSON.stringify({ emailAddress: email }));
    if (cache) fs.writeFileSync(path.join(ACC, label, '.usage-cache'), JSON.stringify(cache));
}
seat('work', 'me@work.example', { fetched_at: now - 60, five_hour_pct: 100, seven_day_pct: 40, five_hour_reset_epoch: now + 3600, seven_day_reset_epoch: now + 86400 });
seat('personal', 'me@home.example', { fetched_at: now - 30, five_hour_pct: 10, seven_day_pct: 5, five_hour_reset_epoch: now + 600, seven_day_reset_epoch: now + 3 * 86400 });
seat('spare', 'spare@home.example', null);
seat('dead', 'dead@x.example', { fetched_at: now - 13 * 86400, five_hour_pct: 5, seven_day_pct: 5, five_hour_reset_epoch: now - 86400, seven_day_reset_epoch: now - 86400 });
seat('half', 'half@x.example', { fetched_at: now - 60, five_hour_pct: null, seven_day_pct: 30, five_hour_reset_epoch: null, seven_day_reset_epoch: now + 86400 });
fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@work.example' } }));
const ccswitch = path.join(HOME, '.claude', 'ccswitch');
fs.writeFileSync(ccswitch, `#!/usr/bin/env bash\necho "$*" >> "${LOG}"\n[[ "$1" == usage ]] && { cat "$HOME/usage.out"; exit "$(cat "$HOME/usage.rc" 2>/dev/null || echo 0)"; }\nexit 0\n`);
// What the stub `ccswitch usage --json` prints: a doc (object) or a raw string, plus its exit code.
const usageReply = (doc, rc = 0) => {
    fs.writeFileSync(path.join(HOME, 'usage.out'), typeof doc === 'string' ? doc : JSON.stringify(doc));
    fs.writeFileSync(path.join(HOME, 'usage.rc'), String(rc));
};
const usageDoc = (logins, health = 'known') => ({ schema: 1, generated_at: now, login_health: health, login_health_reason: null,
    accounts: Object.entries(logins).map(([label, login]) => ({ label, login, state: login === 'ok' ? 'ok' : 'relogin' })) });
const cfg = {};
fs.chmodSync(ccswitch, 0o755);

// --- stub vscode ----------------------------------------------------------------------------------
const said = [];
const saidOpts = [];
const updates = [];
let answer;
const vscode = {
    window: {
        showWarningMessage: async (m, o, ...b) => { said.push(m); saidOpts.push(o); return answer; },
        showInformationMessage: async (m, o, ...b) => { said.push(m); return typeof o === 'object' ? answer : undefined; },
        showErrorMessage: (m) => said.push('ERROR ' + m),
        createTerminal: () => ({ show() {}, sendText(t) { said.push('TERMINAL ' + t); } }),
    },
    workspace: { getConfiguration: () => ({ get: (k) => cfg[k], update: async (k, v, t) => { updates.push([k, v, t]); } }) },
    ConfigurationTarget: { Global: 1 },
    commands: {},
    env: { openExternal: async (u) => { opened.push(String(u)); return true; } },
    Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), parse: (u) => ({ toString: () => u }) },
};
const opened = [];
// A stand-in for the view's webview: the extension asks it for the CSP source and the resource URI of codicon.css.
const fakeWebview = { cspSource: 'https://res.test', asWebviewUri: (u) => 'https://res.test' + u.fsPath };
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? vscode : orig.call(this, r, ...a); };
const file = path.join(__dirname, '..', 'vscode', 'extension.js');
const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file, 'utf8') + '\n;Object.assign(module.exports, { readSnapshot, isFresh, qualifies, capacity, parseUsageJson, mergeLogins, readAccounts, activeLabel, autoTarget, checkLogins, relogin, switchSeat, saveSeat, esc, webviewHtml, panelData, ageText, setAutoSwitch, changeAutoSwitch, AUTO_DETAIL, statusText, statusTooltip, resetText, openUsagePage, USAGE_URL, CODICONS });', file);
const e = m.exports;
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : []);

(async () => {
    await check('activeLabel maps the live email to its saved label (not the email local part)', () =>
        assert.strictEqual(e.activeLabel(), 'work'));

    const ctxFor = (relogin = new Set(), you = 'work') => ({ you, isSaved: (l) => fs.existsSync(path.join(ACC, l, 'credentials.json')), relogin, now });
    const capNow = (relogin) => e.capacity(e.readSnapshot(), ctxFor(relogin));

    await check('readAccounts reads ccswitch usage caches and emails, no team file needed', () => {
        const { accounts, cap } = e.readAccounts();
        const by = (l) => accounts.find((a) => a.label === l);
        assert.deepStrictEqual(accounts.map((a) => a.label), ['dead', 'half', 'personal', 'spare', 'work']);
        assert.strictEqual(by('work').email, 'me@work.example');
        assert.strictEqual(by('work').five_pct, 100);
        assert.strictEqual(by('spare').five_pct, null);
        assert.strictEqual(cap.best.label, 'personal');
        assert.ok(!('free' in cap) && !('total' in cap), 'the free count is gone: it counted stale and dead accounts');
        assert.strictEqual(cap.activeFresh, true);
        assert.strictEqual(e.ageText(by('dead').fetched_at, now), '13d old');
        const pd = e.panelData(accounts, cap, { now, installed: true, auto: false });
        assert.strictEqual(pd.active.label, 'work');
        assert.strictEqual(pd.next.label, 'personal');
    });

    // --- panelData: hand-built accounts (001 full, 002 active, 003 re-login and 13 d old, 004 fresh) ---
    const acct = (label, five, week, fetched, extra = {}) => ({ label, provider: 'claude', state: 'ok', fetched_at: fetched,
        five_pct: five, week_pct: week, five_reset_epoch: now + 3600, week_reset_epoch: now + 86400, email: label + '@x.example', ...extra });
    const capOf = (accounts, you, relogin = [], saved = accounts.map((a) => a.label)) => ({
        ...e.capacity({ accounts }, { you, isSaved: (l) => saved.includes(l), relogin: new Set(relogin), now }),
        relogin, saved, loginHealth: 'known' });
    const four = () => [acct('001', 76, 100, now - 120), acct('002', 23, 64, now - 60), acct('003', 5, 5, now - 13 * 86400), acct('004', 46, 13, now - 60)];
    const opts = { now, installed: true, auto: false };
    const pdFour = () => { const a = four(); return e.panelData(a, capOf(a, '002', ['003']), opts); };

    await check('panelData: active hero, next-best, counts', () => {
        const d = pdFour();
        assert.strictEqual(d.active.label, '002');
        assert.strictEqual(d.active.five, 23);
        assert.strictEqual(d.active.age, null);
        assert.strictEqual(d.next.label, '004');
        assert.deepStrictEqual(d.counts, { total: 4, saved: 4, relogin: 1, full: 1 });
        assert.deepStrictEqual(Object.fromEntries(d.rows.map((r) => [r.label, r.icon])), { '001': 'full', '002': 'active', '003': 'relogin', '004': 'switch' });
        assert.strictEqual(d.active.email, '002@x.example');
        assert.strictEqual(d.rows[2].age, '13d old');
        assert.strictEqual(d.rows[3].age, null);
        assert.strictEqual(d.rows[0].tip, 'A limit is at 100%');
        assert.deepStrictEqual(d.rows[2].actions, ['relogin', 'delete']);
        assert.deepStrictEqual(d.rows[3].actions, ['switch', 'delete']);
        assert.strictEqual(d.loginHealth, 'known');
    });

    await check('panelData: counts follow the row icons, not the free count (stale and dead are not free)', () => {
        const a = [acct('001', 5, 5, now - 7200), acct('002', 23, 64, now - 60), acct('003', 100, 5, now - 60), acct('004', 5, 5, now - 60)];
        const d = e.panelData(a, capOf(a, '002', ['004']), opts);
        assert.deepStrictEqual(d.counts, { total: 4, saved: 4, relogin: 1, full: 1 });
        assert.strictEqual(d.rows[0].icon, '', 'a stale account is not a switch target');
        assert.strictEqual(d.rows[0].summary, 'No recent data');
        assert.strictEqual(d.rows[0].age, '2h old');
    });

    await check('panelData: a reset that is already past is not shown as "now"', () => {
        const a = [acct('002', 23, 64, now - 60), acct('003', 5, 5, now - 13 * 86400, { five_reset_epoch: now - 12 * 86400, week_reset_epoch: now - 600 })];
        const r = e.panelData(a, capOf(a, '002', ['003']), opts).rows[1];
        assert.strictEqual(r.fiveReset, null);
        assert.strictEqual(r.weekReset, null);
    });

    await check('panelData: nothing qualifies -> next is null', () => {
        const a = [acct('001', 5, 5, now - 7200), acct('002', 23, 64, now - 60), acct('003', 5, 5, now - 60)];
        const d = e.panelData(a, capOf(a, '002', ['003']), opts);
        assert.strictEqual(d.next, null);
        assert.ok(!d.rows.some((r) => r.icon === 'switch'));
    });

    await check('panelData: missing window is null, not 0', () => {
        const a = [acct('002', 23, 64, now - 60), acct('half', null, 30, now - 60, { five_reset_epoch: null })];
        const d = e.panelData(a, capOf(a, '002'), opts);
        const half = d.rows.find((r) => r.label === 'half');
        assert.strictEqual(half.five, null);
        assert.strictEqual(half.week, 30);
        assert.strictEqual(half.fiveReset, null);
        assert.strictEqual(half.icon, 'switch');
    });

    await check('panelData: unsaved active account gets SAVE, never switch', () => {
        const a = four();
        const cap = capOf(a, 'newbie', ['003']);
        const d = e.panelData(a, cap, opts);
        assert.strictEqual(d.active.label, 'newbie');
        assert.strictEqual(d.active.five, null);
        const row = d.rows.find((r) => r.label === 'newbie');
        assert.deepStrictEqual(row.actions, ['save']);
        assert.strictEqual(row.icon, 'active');
        assert.strictEqual(e.autoTarget({ ...cap, you: 'newbie' }), null);
    });

    await check('panelData: codex row has no actions and never ⇄', () => {
        const a = [acct('002', 23, 64, now - 60), acct('codex', 1, 1, now - 60, { provider: 'codex' })];
        const d = e.panelData(a, capOf(a, '002'), opts);
        const cx = d.rows.find((r) => r.label === 'codex');
        assert.deepStrictEqual(cx.actions, []);
        assert.strictEqual(cx.icon, '');
    });

    await check('ageText: null when fresh, else minutes, hours or days; no data', () => {
        assert.strictEqual(e.ageText(now - 60, now), null);
        assert.strictEqual(e.ageText(now - 2700, now), '45m old');
        assert.strictEqual(e.ageText(now - 5 * 3600, now), '5h old');
        assert.strictEqual(e.ageText(now - 13 * 86400, now), '13d old');
        assert.strictEqual(e.ageText(null, now), 'no data');
    });

    await check('B1 capacity never recommends a re-login account, even with the lowest load', () => {
        const cap = capNow(new Set(['personal']));
        assert.notStrictEqual(cap.best.label, 'personal');
        assert.strictEqual(cap.best.label, 'half');
    });

    await check('B1 capacity never recommends an account whose own data is stale', () => {
        const cap = capNow();
        assert.notStrictEqual(cap.best.label, 'dead');
        assert.strictEqual(cap.loads.dead, 5);
    });

    await check('B2 one dead account does not mark the others stale', () => {
        const cap = capNow();
        assert.strictEqual(cap.fresh.dead, false);
        assert.strictEqual(cap.fresh.personal, true);
        assert.strictEqual(cap.activeFresh, true);
        assert.ok(!('stale' in cap) && !('updated' in cap));
        assert.ok(!('generated_at' in e.readSnapshot()));
    });

    await check('B3 auto-switch fires while a dead account exists', () => {
        assert.strictEqual(e.autoTarget(capNow()), 'personal');
    });

    await check('autoTarget: never when the active account\'s data is stale or below 100%', () => {
        const cap = capNow();
        assert.strictEqual(e.autoTarget({ ...cap, activeFresh: false }), null);
        assert.strictEqual(e.autoTarget({ ...cap, loads: { ...cap.loads, work: 99 } }), null);
        assert.strictEqual(e.autoTarget({ ...cap, best: null }), null);
        assert.strictEqual(e.autoTarget({ ...cap, you: null }), null);
    });

    await check('qualifies: a missing 5h window does not count as full', () => {
        const snap = e.readSnapshot(), half = snap.accounts.find((a) => a.label === 'half');
        assert.strictEqual(e.qualifies(half, ctxFor()), true);
        assert.strictEqual(capNow().loads.half, 30);
        assert.strictEqual(e.qualifies(snap.accounts.find((a) => a.label === 'work'), ctxFor(new Set(), 'other')), false, 'full');
        assert.strictEqual(e.qualifies(half, ctxFor(new Set(), 'half')), false, 'the active account never qualifies');
    });

    await check('team file: data age is the file\'s generated_at; state must be ok', () => {
        const tf = path.join(HOME, 'team.json');
        const write = (gen, state) => fs.writeFileSync(tf, JSON.stringify({ generated_at: gen, accounts: [{ label: 't1', provider: 'claude', state, five_pct: 1, week_pct: 1 }] }));
        cfg.usageFile = tf;
        try {
            write(now - 3600, 'ok');
            assert.strictEqual(e.isFresh(e.readSnapshot().accounts[0], now), false);
            write(now - 60, 'ok');
            assert.strictEqual(e.isFresh(e.readSnapshot().accounts[0], now), true);
            write(now - 60, 'stale');
            assert.strictEqual(e.isFresh(e.readSnapshot().accounts[0], now), false);
        } finally { delete cfg.usageFile; }
    });

    await check('B5 checkLogins reads usage --json: re-login marks, ok clears, unknown keeps', async () => {
        e.relogin.clear(); e.relogin.add('personal'); e.relogin.add('spare'); fs.rmSync(LOG, { force: true });
        usageReply(usageDoc({ personal: 're-login', spare: 'unknown', work: 'ok' }));
        await e.checkLogins();
        assert.deepStrictEqual([...e.relogin].sort(), ['personal', 'spare']);
        assert.deepStrictEqual(calls(), ['usage --json']);
        assert.strictEqual(e.readAccounts().cap.loginHealth, 'known');
        usageReply(usageDoc({ personal: 'ok' }));
        await e.checkLogins();
        assert.deepStrictEqual([...e.relogin], ['spare']);
    });

    await check('B5 wording does not matter: the login field decides', async () => {
        e.relogin.clear();
        usageReply({ ...usageDoc({ personal: 're-login' }), note: 'all accounts healthy, nothing needs attention' });
        await e.checkLogins();
        assert.deepStrictEqual([...e.relogin], ['personal']);
    });

    await check('mergeLogins keeps only saved labels', () => {
        const out = e.mergeLogins(new Set(['gone']), usageDoc({ personal: 're-login', ghost: 're-login' }), (l) => l !== 'gone' && l !== 'ghost');
        assert.deepStrictEqual([...out], ['personal']);
    });

    await check('old ccswitch without --json: forgets nothing, health unknown', async () => {
        e.relogin.clear(); e.relogin.add('personal');
        usageReply("Error: unknown option '--json' for 'usage'.", 1);
        await e.checkLogins();
        assert.deepStrictEqual([...e.relogin], ['personal'], 'a failed check keeps the known re-login verdicts');
        assert.strictEqual(e.readAccounts().cap.loginHealth, 'unknown');
    });

    await check('garbage on stdout is not trusted, and forgets nothing', async () => {
        e.relogin.clear(); e.relogin.add('personal');
        usageReply('warning\n{"schema":1');
        await e.checkLogins();
        assert.deepStrictEqual([...e.relogin], ['personal']);
        assert.strictEqual(e.readAccounts().cap.loginHealth, 'unknown');
        assert.deepStrictEqual([...e.mergeLogins(new Set(['personal']), null, () => true)], ['personal'], 'no document keeps the previous set');
        assert.strictEqual(e.parseUsageJson('{"schema":2,"accounts":[]}'), null);
        assert.strictEqual(e.parseUsageJson('{"schema":1,"accounts":{}}'), null);
    });

    await check('switchSeat refuses anything that is not a ccswitch label', async () => {
        fs.rmSync(LOG, { force: true });
        await e.switchSeat('x; rm -rf ~', () => {});
        await e.switchSeat('../work', () => {});
        assert.deepStrictEqual(calls(), []);
    });

    await check('switchSeat on a saved, healthy seat runs `ccswitch <label>` after confirmation', async () => {
        e.relogin.clear(); fs.rmSync(LOG, { force: true }); answer = 'Switch';
        let refreshed = false;
        await e.switchSeat('personal', () => { refreshed = true; });
        assert.deepStrictEqual(calls(), ['personal']);
        assert.ok(refreshed);
    });

    await check('switchSeat on an expired seat never switches: syncs tokens, then opens claude for /login', async () => {
        e.relogin.add('personal'); fs.rmSync(LOG, { force: true }); answer = 'Open terminal'; said.length = 0; usageReply(usageDoc({ personal: 're-login' }));
        await e.switchSeat('personal', () => {});
        assert.deepStrictEqual(calls(), ['usage --json']);
        assert.ok(said.includes('TERMINAL claude'));
    });

    await check('saveSeat only saves the seat you are on, answering ccswitch\'s own prompt', async () => {
        fs.rmSync(LOG, { force: true }); said.length = 0; answer = 'Overwrite';
        await e.saveSeat('personal', () => {});
        assert.deepStrictEqual(calls(), []);
        await e.saveSeat('work', () => {});
        assert.deepStrictEqual(calls(), ['save work']);
    });

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

    // --- the native panel (vscode/webview/panel.*) ---------------------------------------------------
    const WV = path.join(__dirname, '..', 'vscode', 'webview');
    function readWv(f) { return fs.readFileSync(path.join(WV, f), 'utf8'); }
    function panel() { const ctx = { esc: e.esc }; require('vm').runInNewContext(readWv('panel.js'), ctx); return ctx; }
    function ui(over = {}) { return { accountsOpen: true, automationOpen: false, openRow: null, ...over }; }
    // The markup of one account row (the row line, not its details).
    const rowOf = (html, label) => (html.match(new RegExp('<div class="row[^"]*" data-a="row" data-l="' + label + '"[\\s\\S]*?</div>')) || [''])[0];

    await check('B4 no hard-coded colour in the panel', () => {
        const src = readWv('panel.css') + readWv('panel.js') + e.webviewHtml(fakeWebview);
        assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(src), 'hex colour: ' + (src.match(/#[0-9a-fA-F]{3,8}\b/) || [])[0]);
        assert.ok(!/\b(rgba?|hsla?)\(/.test(src), 'rgb()/hsl()');
        assert.ok(!/:\s*(white|black)\b/.test(src), 'named colour');
        const vars = src.match(/var\(--[\w-]*/g) || [];
        assert.ok(vars.length > 0 && vars.every((v) => v.startsWith('var(--vscode-')), 'only --vscode-* variables');
    });

    await check('B4 the panel uses theme variables: orange session, theme-blue weekly, no traffic lights', () => {
        const css = readWv('panel.css');
        for (const v of ['--vscode-charts-orange', '--vscode-progressBar-background', '--vscode-textLink-foreground', '--vscode-button-background',
            '--vscode-editorWarning-foreground', '--vscode-errorForeground', '--vscode-contrastBorder', '--vscode-contrastActiveBorder']) assert.ok(css.includes(v), v);
        assert.ok(!/charts-(green|yellow|red)/.test(css + readWv('panel.js')), 'no traffic-light bar colours');
        assert.match(css, /\.grp, \.kv \.k, \.rs[^{]*\{ opacity: \.\d+; \}/, 'secondary text is dimmed in every theme, not only where descriptionForeground is grey');
    });

    await check('render: codicons replace the emoji and Unicode symbols', () => {
        const p = panel();
        const all = [p.render(pdFour(), ui({ automationOpen: true })), p.render(pdFour(), ui({ openRow: '003' })), readWv('panel.js'), readWv('panel.css')].join('');
        for (const ch of ['⛔', '⚠', '⇄', '●', '◷', '⟳', '▾', '▸', '›', '⌄', '✉', '<svg']) assert.ok(!all.includes(ch), ch);
        assert.ok(all.includes('codicon-chevron-down') && all.includes('codicon-chevron-right'));
    });

    await check('render: Active account has ACCOUNT and USAGE groups, nickname, email, both limits and their resets', () => {
        const html = panel().render(pdFour(), ui());
        for (const t of ['Active account', '>Account<', '>Usage<', 'Nickname', '002@x.example', 'Session (5hr)', 'Weekly (7 day)', '>23%<', '>64%<', 'Resets in', 'View details'])
            assert.ok(html.includes(t), t);
        assert.match(html, /bar s[^>]*><i style="width:23%"/, 'the session bar is 23% long');
        assert.match(html, /bar w[^>]*><i style="width:64%"/, 'the weekly bar is 64% long');
        assert.ok(!html.includes('Last data'), 'fresh data: no data age');
    });

    await check('render: every section folds; the header keeps its title', () => {
        const p = panel();
        const shut = p.render(pdFour(), ui({ activeOpen: false, nextOpen: false }));
        assert.ok(shut.includes('Active account') && shut.includes('If you run out') && shut.includes('View details'));
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

    await check('render: open row details are key-value rows and text-link actions', () => {
        const html = panel().render(pdFour(), ui({ openRow: '003' }));
        const det = html.slice(html.indexOf('<div class="det">'));
        for (const t of ['Email', '003@x.example', 'Last data', '13d old', 'How to re-login', 'Delete']) assert.ok(det.includes(t), t);
        assert.match(det, /class="lnk" data-a="relogin" data-l="003"/);
        assert.ok(!det.includes('Session (5hr)'), 'stale numbers are not shown as current');
        const fresh = panel().render(pdFour(), ui({ openRow: '004' }));
        const d4 = fresh.slice(fresh.indexOf('<div class="det">'));
        assert.ok(d4.includes('Session (5hr)') && d4.includes('46%') && d4.includes('resets ') && d4.includes('>Switch<'));
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

    await check('View details opens claude.ai/settings/usage in the browser', async () => {
        opened.length = 0;
        await e.openUsagePage();
        assert.deepStrictEqual(opened, ['https://claude.ai/settings/usage']);
        assert.match(fs.readFileSync(file, 'utf8'), /m\.openUsage\) openUsagePage\(\)/, 'the webview message is handled');
        assert.match(readWv('panel.js'), /'details'\) return vsc\.postMessage\(\{ openUsage: 1 \}\)/, 'the link posts it');
        const link = panel().render(pdFour(), ui()).match(/<button class="([^"]*)" data-a="details"/);
        assert.ok(link, 'the link is rendered');
        assert.deepStrictEqual(link[1].split(' '), ['lnk'], 'link colour at rest: no grey right-hand-text class on it');
    });

    // --- G7: turning auto-switch on asks once ----------------------------------------------------------
    await check('G7 turning auto-switch on asks once, in a modal', async () => {
        said.length = saidOpts.length = updates.length = 0;
        answer = undefined;
        assert.strictEqual(await e.setAutoSwitch(true), false);
        assert.deepStrictEqual(updates, []);
        assert.strictEqual(said.length, 1);
        assert.strictEqual(saidOpts[0].modal, true);
        assert.strictEqual(said[0], 'Turn on auto-switch?');
        answer = 'Turn on';
        assert.strictEqual(await e.setAutoSwitch(true), true);
        assert.deepStrictEqual(updates, [['autoSwitch', true, 1]]);
        answer = undefined;
    });

    await check('G7 turning auto-switch off needs no dialog', async () => {
        said.length = saidOpts.length = updates.length = 0;
        assert.strictEqual(await e.setAutoSwitch(false), true);
        assert.strictEqual(said.length, 0);
        assert.deepStrictEqual(updates, [['autoSwitch', false, 1]]);
    });

    await check('G7 the dialog states the effect', () => {
        for (const re of [/every new Claude Code session/, /without asking/, /100%/, /restart/i, /this machine/]) assert.match(e.AUTO_DETAIL, re);
    });

    await check('autoSwitch setting is machine-scoped and its description says what it does', () => {
        const p = require('../vscode/package.json').contributes.configuration.properties['claudeUsage.autoSwitch'];
        assert.strictEqual(p.scope, 'machine');
        assert.ok(!('description' in p), 'markdownDescription replaces description');
        assert.match(p.markdownDescription, /without asking/);
        assert.match(p.markdownDescription, /100%/);
    });

    await check('the toggle command and the panel both go through setAutoSwitch', () => {
        const src = fs.readFileSync(file, 'utf8');
        assert.ok(!/update\('autoSwitch'/.test(src.replace(/async function setAutoSwitch[\s\S]*?\n}\n/, '')), 'one writer of the setting');
    });

    // --- status bar text ---------------------------------------------------------------------------------
    const sb = (a, you, relogin = [], over = {}) => ({ ...capOf(a, you, relogin), ...over });
    const sbAcc = () => [acct('work', 100, 40, now - 60), acct('personal', 10, 5, now - 30)];

    await check('statusText: active and next-best', () => {
        const a = sbAcc();
        assert.strictEqual(e.statusText(sb(a, 'work'), a, false), '● work 100%/40% · ⇄ personal');
    });

    await check('statusText: nothing qualifies (Review Focus 1)', () => {
        const a = [acct('work', 100, 40, now - 60), acct('old', 5, 5, now - 7200), acct('dead', 5, 5, now - 60)];
        const t = e.statusText(sb(a, 'work', ['dead']), a, false);
        assert.ok(t.endsWith('· ⇄ none'), t);
        assert.ok(!/free/.test(t), 'stale and dead accounts are not counted as free');
    });

    await check('statusText: stale active data and auto on', () => {
        const a = [acct('work', 100, 40, now - 7200), acct('personal', 10, 5, now - 30)];
        const t = e.statusText(sb(a, 'work'), a, true);
        assert.ok(t.startsWith('$(sync) ● work'), t);
        assert.ok(t.includes('100%/40% ◷'), t);
    });

    await check('statusText: no active account, and a missing window', () => {
        const a = sbAcc();
        assert.strictEqual(e.statusText(sb(a, null), a, false), '● none');
        assert.strictEqual(e.statusText(sb(a, null), a, true), '$(sync) ● none');
        const h = [acct('half', null, 30, now - 60)];
        assert.strictEqual(e.statusText(sb(h, 'half'), h, false), '● half –/30% · ⇄ none');
    });

    await check('statusText: an active account with no data at all', () => {
        const a = sbAcc();
        const t = e.statusText(sb(a, 'ghost'), a, false);  // not saved, no row
        assert.strictEqual(t, '● ghost –/– ◷ · ⇄ personal');
    });

    await check('statusTooltip lists every account', () => {
        const a = [...sbAcc(), acct('old', 5, 5, now - 7200), acct('dead', 5, 5, now - 13 * 86400)];
        const tip = e.statusTooltip(sb(a, 'work', ['dead']), a, false);
        const lines = tip.split('\n');
        assert.strictEqual(lines.length, a.length + 1);
        assert.strictEqual(lines[0], 'Auto-switch: off');
        assert.strictEqual(lines[1], 'work: 5h 100%, wk 40% · active');
        assert.strictEqual(lines[2], 'personal: 5h 10%, wk 5%');
        assert.strictEqual(lines[3], 'old: 5h 5%, wk 5% · data 2h old');
        assert.strictEqual(lines[4], 'dead: 5h 5%, wk 5% · re-login · data 13d old');
        assert.strictEqual(e.statusTooltip(sb(a, 'work'), a, true).split('\n')[0], 'Auto-switch: ON');
    });

    await check('statusTooltip says the truth about the active account\'s data (fresh, stale, none)', () => {
        const a = [acct('work', 100, 40, now - 60), acct('old', 5, 5, now - 7200)];
        assert.strictEqual(e.statusTooltip(sb(a, 'work'), a, false).split('\n')[1], 'work: 5h 100%, wk 40% · active', 'fresh active: no age claim');
        assert.ok(e.statusTooltip(sb(a, 'old'), a, false).includes('old: 5h 5%, wk 5% · data 2h old · active'));
        const ghost = e.statusTooltip(sb(a, 'ghost'), a, false);  // active, unsaved, in no list
        assert.strictEqual(ghost.split('\n').length, a.length + 2);
        assert.ok(ghost.includes('ghost: 5h –, wk – · no data · active'), ghost);
        assert.ok(!/over 30 min/.test(fs.readFileSync(file, 'utf8')), 'the old unconditional claim is gone');
    });

    await check('the vendored popup is gone', () => {
        assert.ok(!fs.existsSync(path.join(__dirname, '..', 'vscode', 'ui')));
    });

    await check('dialog texts name the panel\'s own control: Save login, no SAVE card', () => {
        const src = fs.readFileSync(file, 'utf8');
        assert.ok(!/\bSAVE\b/.test(src), 'no SAVE button any more');
        assert.ok(!/\bcard\b/.test(src), 'no cards any more');
        assert.match(src, /click the \$\{label\} row in the sidebar and choose Save login/);
    });

    await check('switch texts agree with ccswitch: open Claude Code tabs need a restart', () => {
        const src = fs.readFileSync(file, 'utf8');
        assert.ok(!/carry on as the new seat/.test(src), 'no hot-swap claim');
        assert.match(src, /restart open Claude Code tabs/i);
    });

    await check('a failed settings write shows an error message instead of vanishing', async () => {
        const realUpdate = vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration = () => ({ get: (k) => cfg[k], update: async () => { throw new Error('settings.json is read-only'); } });
        said.length = 0;
        try { await e.changeAutoSwitch(false); } finally { vscode.workspace.getConfiguration = realUpdate; }
        assert.deepStrictEqual(said, ['ERROR Could not change auto-switch: settings.json is read-only']);
    });

    console.log('----------------------------------------');
    console.log(`Passed: ${passed}  Failed: ${failed}`);
    process.exit(failed ? 1 : 0);
})();
