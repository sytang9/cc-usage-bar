// Unit tests for vscode/extension.js. Loads the extension with a stub `vscode` module in a sandboxed HOME
// (set by vscode_extension_test.sh) and a stub ccswitch that only records its arguments. Never touches ~/.claude.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const HOME = process.env.HOME;
// This file writes ~/.claude.json and ~/.claude/ccswitch: refuse unless vscode_extension_test.sh made a sandbox HOME.
// It also writes ${CODEX_HOME}/.usage-cache, so CODEX_HOME must sit inside that sandbox HOME.
if (process.env.CCUB_TEST_SANDBOX !== '1' || !path.resolve(HOME || '/').startsWith(path.resolve(require('os').tmpdir()) + path.sep)
    || !path.resolve(process.env.CODEX_HOME || '/').startsWith(path.resolve(HOME || '/') + path.sep)) {
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
fs.writeFileSync(ccswitch, `#!/usr/bin/env bash\necho "$*" >> "${LOG}"\n[[ "$1" == version ]] && { cat "$HOME/version.out" 2>/dev/null || echo "ccswitch 1.2.0"; exit 0; }\n[[ "$1" == usage ]] && { cat "$HOME/usage.out"; exit "$(cat "$HOME/usage.rc" 2>/dev/null || echo 0)"; }\nexit "$(cat "$HOME/switch.rc" 2>/dev/null || echo 0)"\n`);
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
let answer, inputAnswer, closeTerminal;
const terminals = [], inputOpts = [];
const vscode = {
    window: {
        showWarningMessage: async (m, o, ...b) => { said.push(m); saidOpts.push(o); return answer; },
        showInformationMessage: async (m, o, ...b) => { said.push(m); return typeof o === 'object' ? answer : undefined; },
        showErrorMessage: (m) => said.push('ERROR ' + m),
        createTerminal: (name) => { const t = { name, show() {}, sendText(x) { said.push('TERMINAL ' + x); } }; terminals.push(t); return t; },
        onDidCloseTerminal: (f) => { closeTerminal = f; return { dispose() {} }; },
        // Like VS Code: an Error from validateInput blocks the Enter key (a string counts as an error), so nothing is returned.
        showInputBox: async (o) => {
            inputOpts.push(o);
            const v = o.validateInput && inputAnswer !== undefined ? o.validateInput(inputAnswer) : null;
            return v && (typeof v === 'string' || v.severity !== 2) ? undefined : inputAnswer;
        },
    },
    InputBoxValidationSeverity: { Warning: 2 },
    workspace: { getConfiguration: () => ({ get: (k) => cfg[k], update: async (k, v, t) => { updates.push([k, v, t]); } }) },
    ConfigurationTarget: { Global: 1 },
    commands: {},
    Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }), parse: (u) => ({ toString: () => u }) },
};
// A stand-in for the view's webview: the extension asks it for the CSP source and the resource URI of codicon.css.
const fakeWebview = { cspSource: 'https://res.test', asWebviewUri: (u) => 'https://res.test' + u.fsPath };
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? vscode : orig.call(this, r, ...a); };
const file = path.join(__dirname, '..', 'vscode', 'extension.js');
// Each load is one fresh extension instance, as in one VS Code window.
function load() {
    const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    m._compile(fs.readFileSync(file, 'utf8') + '\n;Object.assign(module.exports, { isLabel, autoBlock, autoSwitch, deleteSeat, CONSENT, readSnapshot, isFresh, qualifies, capacity, parseUsageJson, mergeLogins, readAccounts, activeLabel, autoTarget, checkLogins, relogin, switchSeat, saveSeat, addAccount, runAdd, labelProblem, ccswitchHasAdd, esc, webviewHtml, panelData, ageText, setAutoSwitch, changeAutoSwitch, AUTO_DETAIL, statusText, statusTooltip, resetText, CODICONS, rolled, readHistory, forecast, statsFeed, STATS_EVERY_MS, STATS_RETRY_MS, withHistory, HISTORY_READ_BYTES });', file);
    return m.exports;
}
const e = load();
// context.globalState stand-in; consented = the user confirmed the auto-switch dialog on this machine.
const memento = (consented) => { const s = consented ? { [e.CONSENT]: true } : {}; return { get: (k) => s[k], update: async (k, v) => { s[k] = v; } }; };
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
        assert.strictEqual(cx.icon, 'readonly', 'a lock, never the ⇄ switch icon');
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
        assert.strictEqual(e.autoTarget({ ...cap, activeFresh: false, activeSwitchFresh: false }), null);
        assert.strictEqual(e.autoTarget({ ...cap, loads: { ...cap.loads, work: 99 } }), null);
        assert.strictEqual(e.autoTarget({ ...cap, best: null }), null);
        assert.strictEqual(e.autoTarget({ ...cap, you: null }), null);
    });

    await check('switching needs data under 15 min; display keeps 30 min', () => {
        const a = [acct('work', 100, 40, now - 1000), acct('p16', 10, 5, now - 1000), acct('p13', 20, 5, now - 800)];
        const cap = capOf(a, 'work');
        assert.strictEqual(cap.best.label, 'p13', 'a 16-min-old account is not a switch target');
        assert.strictEqual(e.autoTarget(cap), null, 'a 16-min-old full reading does not auto-switch');
        assert.strictEqual(cap.activeFresh, true, 'the status bar still shows it as current');
        const d = e.panelData(a, cap, opts);
        assert.strictEqual(d.rows[1].icon, '');
        assert.strictEqual(d.rows[1].summary, '10% · 5%', 'display: not stale yet');
        assert.strictEqual(e.autoTarget(capOf([acct('work', 100, 40, now - 800), a[2]], 'work')), 'p13');
    });

    await check('a fetched_at in the future is not fresh (beyond 60 s of clock slack)', () => {
        const ahead = acct('x', 1, 1, now + 3600);
        assert.strictEqual(e.isFresh(ahead, now), false);
        assert.strictEqual(e.qualifies(ahead, ctxFor(new Set(), 'work')), false);
        assert.strictEqual(e.ageText(ahead.fetched_at, now), 'in the future');
        assert.strictEqual(e.isFresh(acct('x', 1, 1, now + 30), now), true, 'a few seconds of skew is fine');
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

    await check('team file: rows whose label breaks the label rule are dropped; usageFile is machine-scoped', () => {
        const tf = path.join(HOME, 'team.json');
        fs.writeFileSync(tf, JSON.stringify({ generated_at: now, accounts: ['../../etc', '-h', 'a.b', 42, null, {}, 't1'].map((label) =>
            ({ label, provider: 'claude', state: 'ok', five_pct: 1, week_pct: 1 })) }));
        cfg.usageFile = tf;
        try { assert.deepStrictEqual(e.readAccounts().accounts.map((a) => a.label), ['t1']); } finally { delete cfg.usageFile; }
        const p = require('../vscode/package.json').contributes.configuration.properties['claudeUsage.usageFile'];
        assert.strictEqual(p.scope, 'machine', 'a workspace .vscode/settings.json cannot point it at a crafted file');
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

    await check('isLabel: ccswitch\'s label rule, never a leading dash', () => {
        for (const ok of ['work', 'work-2', '_x', '002']) assert.strictEqual(e.isLabel(ok), true, ok);
        for (const bad of ['-h', '--help', '../x', 'a.b', 'a b', '', 42, null, ['work']]) assert.strictEqual(e.isLabel(bad), false, String(bad));
    });

    await check('a saved folder that breaks the label rule is not an account', () => {
        seat('-h', 'h@x.example', { fetched_at: now - 60, five_hour_pct: 1, seven_day_pct: 1 });
        try { assert.ok(!e.readAccounts().accounts.some((a) => a.label === '-h')); } finally { fs.rmSync(path.join(ACC, '-h'), { recursive: true }); }
    });

    await check('switchSeat refuses anything that is not a ccswitch label', async () => {
        fs.rmSync(LOG, { force: true });
        await e.switchSeat('x; rm -rf ~', () => {});
        await e.switchSeat('../work', () => {});
        await e.switchSeat('-h', () => {});
        await e.saveSeat('-h', () => {});
        await e.deleteSeat('x; rm -rf ~', () => {});
        await e.deleteSeat('-h', () => {});
        assert.deepStrictEqual(calls(), []);
    });

    await check('switchSeat on a saved, healthy seat runs `ccswitch <label>` after confirmation', async () => {
        e.relogin.clear(); fs.rmSync(LOG, { force: true }); answer = 'Switch';
        let refreshed = false;
        await e.switchSeat('personal', () => { refreshed = true; });
        assert.deepStrictEqual(calls(), ['personal']);
        assert.ok(refreshed);
    });

    await check('switchSeat on an expired seat never switches: no fetch, no claude; runs `ccswitch add <label>` in an "Add account" terminal', async () => {
        e.relogin.add('personal'); fs.rmSync(LOG, { force: true }); answer = 'Open terminal'; said.length = 0; terminals.length = 0;
        await e.switchSeat('personal', () => {});
        assert.ok(!calls().includes('usage --json'), 'enroll no longer syncs tokens: ccswitch add leaves the live login alone');
        assert.ok(!calls().includes('personal'), 'never switches');
        assert.ok(!said.includes('TERMINAL claude'), 'no claude /login any more');
        assert.deepStrictEqual(said.filter((m) => m.startsWith('TERMINAL')), [`TERMINAL "${ccswitch}" add personal && exit`]);
        assert.strictEqual(terminals[0].name, 'Add account: personal');
    });

    await check('label prompt: a bad label and a reserved word are rejected; a saved one warns about overwrite; a fresh one passes', () => {
        for (const bad of ['', '-x', 'a b', 'a/b', '../x', 'a;rm']) assert.strictEqual(typeof e.labelProblem(bad), 'string', JSON.stringify(bad));
        for (const w of ['save', 'delete', 'list', 'usage', 'help', 'version', 'refresh-pause', 'refresh-resume', 'add']) {
            assert.ok(/ccswitch command/.test(e.labelProblem(w)), w);
        }
        const w = e.labelProblem('personal');
        assert.strictEqual(w.severity, 2); assert.ok(/will ask before it overwrites/.test(w.message));
        assert.strictEqual(e.labelProblem('brand-new_1'), null);
    });

    await check('+ Add account: the box validates with labelProblem; a valid label opens the terminal and sends `<ccswitch> add <label>`', async () => {
        fs.rmSync(LOG, { force: true }); said.length = 0; terminals.length = 0; inputOpts.length = 0; inputAnswer = 'newone';
        await e.addAccount(() => {});
        assert.strictEqual(inputOpts[0].validateInput, e.labelProblem);
        assert.deepStrictEqual(said.filter((m) => m.startsWith('TERMINAL')), [`TERMINAL "${ccswitch}" add newone && exit`]);
        assert.strictEqual(terminals[0].name, 'Add account: newone');
        inputAnswer = undefined; said.length = 0; terminals.length = 0;
        await e.addAccount(() => {});
        assert.deepStrictEqual([said, terminals], [[], []], 'cancelling the box opens nothing');
    });

    await check('an unsafe label never reaches the terminal: validateInput stops it in the box, and runAdd checks again', async () => {
        said.length = 0; terminals.length = 0;
        inputAnswer = 'a;rm -rf x';
        await e.addAccount(() => {});
        assert.deepStrictEqual([said, terminals], [[], []], 'the box rejects it (the stub runs validateInput like VS Code)');
        await e.runAdd('a;rm -rf x', () => {});
        await e.runAdd('--help', () => {});
        assert.deepStrictEqual([said, terminals], [[], []], 'runAdd refuses it even if the box did not');
    });

    await check('the sidebar "+ Add account" click ({add:1}) reaches addAccount through the host route', async () => {
        const cmds = {}, ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(HOME, 'gs') }, globalState: memento(false) };
        let provider, onMsg;
        const keep = { win: { ...vscode.window }, commands: vscode.commands, ws: vscode.workspace.onDidChangeConfiguration };
        Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: (id, p) => { provider = p; return { dispose() {} }; } });
        vscode.StatusBarAlignment = { Right: 2 };
        vscode.commands = { registerCommand: (id, f) => { cmds[id] = f; return { dispose() {} }; }, executeCommand: async () => {} };
        vscode.extensions = { getExtension: () => undefined };
        vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} });
        try {
            load().activate(ctx);
            provider.resolveWebviewView({ visible: true, onDidChangeVisibility: () => {}, onDidDispose: () => {},
                webview: { ...fakeWebview, postMessage: async () => {}, onDidReceiveMessage: (f) => { onMsg = f; } } });
            inputAnswer = 'viaclick'; terminals.length = 0; inputOpts.length = 0;
            onMsg({ add: 1 });
            for (let i = 0; i < 40 && !terminals.length; i++) await new Promise((r) => setTimeout(r, 50));
            assert.strictEqual(inputOpts.length, 1, 'the click asks for a label');
            assert.strictEqual(terminals[0].name, 'Add account: viaclick');
        } finally {
            Object.assign(vscode.window, keep.win); vscode.commands = keep.commands; vscode.workspace.onDidChangeConfiguration = keep.ws;
            for (const d of ctx.subscriptions) if (d && d.dispose) d.dispose();
        }
    });

    await check('the enroll dialog says to paste the code if prompted, and for an expired seat warns that ccswitch asks before overwriting', async () => {
        const detail = async (expired) => { saidOpts.length = 0; answer = undefined;
            const info = vscode.window.showInformationMessage;
            vscode.window.showInformationMessage = async (m, o) => { saidOpts.push(o); };
            try { await e.switchSeat(expired ? 'personal' : 'spare2', () => {}); } finally { vscode.window.showInformationMessage = info; }
            return saidOpts[0].detail; };
        e.relogin.add('personal');
        const d1 = await detail(true), d2 = await detail(false);
        assert.ok(/paste the code if it asks/.test(d1) && /ccswitch asks before it overwrites/.test(d1), d1);
        assert.ok(/paste the code if it asks/.test(d2) && !/overwrites/.test(d2), d2);
        e.relogin.delete('personal');
    });

    await check('an old ccswitch without `add` gets the install/update offer, not a failing command', async () => {
        fs.writeFileSync(path.join(HOME, 'version.out'), 'ccswitch 1.1.0\n');
        try {
            assert.strictEqual(await e.ccswitchHasAdd(), false);
            answer = 'Open terminal'; terminals.length = 0; said.length = 0; saidOpts.length = 0;
            const install = vscode.window.showWarningMessage;
            vscode.window.showWarningMessage = async (m, o, ...b) => { said.push(m); saidOpts.push(o); return 'Install'; };
            await e.switchSeat('spare2', () => {});
            vscode.window.showWarningMessage = install;
            assert.ok(said.includes('Install ccswitch (cc-usage-bar)?'), 'offers the installer');
            assert.ok(/1\.2\.0/.test(saidOpts.find((o) => o && o.detail && /installer/.test(o.detail)).detail), 'says why');
            assert.deepStrictEqual(terminals.map((t) => t.name), ['Install ccswitch'], 'only the installer terminal opens');
            assert.ok(!said.some((m) => /add spare2/.test(m)), 'no `add` is sent');
            fs.writeFileSync(path.join(HOME, 'version.out'), 'garbage');
            assert.strictEqual(await e.ccswitchHasAdd(), false, 'no readable version: treated as old');
            fs.writeFileSync(path.join(HOME, 'version.out'), 'ccswitch 2.0.0\n');
            assert.strictEqual(await e.ccswitchHasAdd(), true);
        } finally { fs.rmSync(path.join(HOME, 'version.out'), { force: true }); }
    });

    await check('the sidebar refreshes when the Add account terminal closes (and not for other terminals)', async () => {
        const ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(HOME, 'gs') }, globalState: memento(false) };
        const keep = { win: { ...vscode.window }, commands: vscode.commands, ws: vscode.workspace.onDidChangeConfiguration };
        Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: () => ({ dispose() {} }) });
        vscode.StatusBarAlignment = { Right: 2 };
        vscode.commands = { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} };
        vscode.extensions = { getExtension: () => undefined };
        vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} });
        try {
            usageReply(usageDoc({ work: 'ok' }));
            const x = load(); x.activate(ctx);
            inputAnswer = 'fresh'; terminals.length = 0; fs.rmSync(LOG, { force: true });
            await x.addAccount(() => {});
            closeTerminal({ name: 'something else' });
            await new Promise((r) => setTimeout(r, 100));
            assert.deepStrictEqual(calls().filter((c) => c === 'usage --json'), [], 'an unrelated terminal closing refreshes nothing');
            closeTerminal(terminals[0]);
            for (let i = 0; i < 40 && !calls().includes('usage --json'); i++) await new Promise((r) => setTimeout(r, 50));
            assert.ok(calls().includes('usage --json'), 'closing the Add account terminal runs the guarded fetch, then repaints');
        } finally {
            Object.assign(vscode.window, keep.win); vscode.commands = keep.commands; vscode.workspace.onDidChangeConfiguration = keep.ws;
            usageReply('');
            for (const d of ctx.subscriptions) if (d && d.dispose) d.dispose();
        }
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
        assert.ok(fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').includes('`@vscode/codicons` 0.0.46-24'), 'README names the vendored version');
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

    // --- the read-only Codex row ----------------------------------------------------------------------
    const CODEX = process.env.CODEX_HOME;
    const codexCache = (c) => { fs.mkdirSync(CODEX, { recursive: true }); fs.writeFileSync(path.join(CODEX, '.usage-cache'), JSON.stringify(c)); };
    const withCodex = (fn) => { try { return fn(); } finally { fs.rmSync(CODEX, { recursive: true, force: true }); } };
    const cx = (five, week, fetched, extra = {}) => acct('codex', five, week, fetched, { provider: 'codex', email: null, ...extra });

    await check('codex: the sidebar reads ${CODEX_HOME}/.usage-cache; no cache and no login -> no row', () => withCodex(() => {
        assert.ok(!e.readAccounts().accounts.some((a) => a.provider === 'codex'));
        codexCache({ fetched_at: now - 60, five_hour_pct: 0, seven_day_pct: 1, five_hour_reset_epoch: now + 600, seven_day_reset_epoch: now + 86400, plan_type: 'plus', rate_limited_until: null });
        const { accounts, cap } = e.readAccounts();
        const row = accounts.filter((a) => a.provider === 'codex');
        assert.deepStrictEqual(row, [{ label: 'codex', provider: 'codex', state: 'ok', fetched_at: now - 60, five_pct: 0, week_pct: 1,
            five_reset_epoch: now + 600, week_reset_epoch: now + 86400, email: null }]);
        assert.strictEqual(accounts[accounts.length - 1].provider, 'codex', 'after the Claude accounts');
        assert.notStrictEqual(cap.best && cap.best.label, 'codex', 'the emptiest seat, but never a target');
        assert.ok(!('codex' in cap.loads) && !cap.saved.includes('codex'));
    }));

    await check('codex: a login with no cache yet, or a never-fetched cache, shows "No recent data"', () => withCodex(() => {
        fs.mkdirSync(CODEX, { recursive: true });
        fs.writeFileSync(path.join(CODEX, 'auth.json'), 'not read by the sidebar');
        const only = e.readAccounts().accounts.find((a) => a.provider === 'codex');
        assert.strictEqual(only.state, 'no data yet');
        assert.strictEqual(only.fetched_at, null);
        codexCache({ fetched_at: 0, rate_limited_until: now + 600 });
        const { accounts, cap } = e.readAccounts();
        const r = e.panelData(accounts, cap, opts).rows.find((x) => x.provider === 'codex');
        assert.strictEqual(r.summary, 'No recent data');
        assert.strictEqual(r.age, 'no data');
    }));

    await check('codex: stale numbers say "No recent data" and their age, so a stuck number is visible', () => {
        const a = [acct('002', 23, 64, now - 60), cx(5, 6, now - 5 * 3600)];
        const r = e.panelData(a, capOf(a, '002'), opts).rows[1];
        assert.strictEqual(r.summary, 'No recent data');
        assert.strictEqual(r.age, '5h old');
        const html = panel().render(e.panelData(a, capOf(a, '002'), opts), ui({ openRow: 'codex' }));
        assert.ok(html.includes('Last data') && html.includes('5h old'));
    });

    await check('codex: read-only row: lock icon, Codex tooltip, own resets, no actions, never ⇄ or next, not saved', () => {
        // codex is the emptiest seat; 004 is the only Claude target.
        const a = [acct('002', 23, 64, now - 60), acct('004', 46, 13, now - 60), cx(0, 0, now - 60)];
        const d = e.panelData(a, capOf(a, '002', [], ['002', '004', 'codex']), opts);
        const r = d.rows.find((x) => x.provider === 'codex');
        assert.deepStrictEqual([r.icon, r.tip, r.actions, r.email], ['readonly', 'Codex (read-only)', [], null]);
        assert.strictEqual(r.summary, '0% · 0%');
        assert.ok(r.fiveReset && r.weekReset, 'its own reset times');
        assert.strictEqual(d.next.label, '004');
        assert.strictEqual(d.counts.saved, 2, 'not counted as a saved account');
        const html = panel().render(d, ui({ openRow: 'codex' }));
        const row = rowOf(html, 'codex');
        assert.ok(row.includes('codicon-lock') && row.includes('title="Codex (read-only)"'));
        const det = html.slice(html.indexOf(row) + row.length).split('<div class="sec">')[0];
        assert.ok(det.includes('Resets') || det.includes('resets'), 'details show its resets');
        assert.ok(det.includes('Read-only'), 'the open row says it is read-only (no hover needed)');
        assert.ok(!det.includes('<button'), 'no Switch, Save login or Delete');
    });

    await check('codex: a full Codex row is marked full but stays read-only and Codex-labelled', () => {
        const a = [acct('002', 23, 64, now - 60), cx(5, 100, now - 60)];
        const r = e.panelData(a, capOf(a, '002'), opts).rows[1];
        assert.strictEqual(r.icon, 'full');
        assert.match(r.tip, /^Codex \(read-only\)/);
        assert.match(r.summary, /^Weekly full · resets /);
        assert.deepStrictEqual(r.actions, []);
    });

    await check('codex: a saved Claude account named "codex" keeps its own row; the Codex row never borrows it', () => {
        const a = [acct('codex', 23, 64, now - 60), acct('004', 46, 13, now - 60), cx(1, 1, now - 60)];
        const d = e.panelData(a, capOf(a, 'codex', ['codex']), opts);
        const [claudeRow, codexRow] = [d.rows[0], d.rows[2]];
        assert.strictEqual(claudeRow.icon, 'active');
        assert.deepStrictEqual(claudeRow.actions, ['relogin', 'delete']);
        assert.deepStrictEqual([codexRow.provider, codexRow.icon, codexRow.actions], ['codex', 'readonly', []]);
        assert.strictEqual(d.counts.saved, 2);
        assert.strictEqual(d.counts.relogin, 0, 'the active Claude "codex" is not re-login-marked twice, the Codex row never');
        assert.strictEqual(d.active.five, 23, 'the hero is the Claude account');
        const tip = e.statusTooltip({ ...capOf(a, 'codex', ['codex']) }, a, false).split('\n');
        assert.ok(tip.includes('codex: 5h 1%, wk 1% · Codex (read-only)'), tip.join(' | '));
    });

    await check('codex: never the status-bar headroom, even when every Claude account is full', () => {
        const a = [acct('002', 100, 64, now - 60), acct('003', 100, 100, now - 60), cx(0, 0, now - 60)];
        const cap = capOf(a, '002');
        assert.strictEqual(cap.best, null);
        assert.strictEqual(e.autoTarget(cap), null);
        assert.ok(e.statusText(cap, a, false).endsWith('⇄ none'));
    });

    await check('codex: team-file provider "codex" rows behave the same', () => withCodex(() => {
        const tf = path.join(HOME, 'team.json');
        fs.writeFileSync(tf, JSON.stringify({ generated_at: now - 60, accounts: [
            { label: 't1', provider: 'claude', state: 'ok', five_pct: 50, week_pct: 50 },
            { label: 'codex', provider: 'codex', state: 'ok', five_pct: 0, week_pct: 0, five_reset_epoch: now + 600 }] }));
        codexCache({ fetched_at: now - 60, five_hour_pct: 77, seven_day_pct: 77 });
        cfg.usageFile = tf;
        try {
            const { accounts, cap } = e.readAccounts();
            assert.deepStrictEqual(accounts.map((x) => [x.label, x.provider, x.five_pct]), [['t1', 'claude', 50], ['codex', 'codex', 0]], 'the team file only, not the local cache');
            assert.ok(!('codex' in cap.loads) && !e.qualifies(accounts[1], { you: 't1', isSaved: () => true, relogin: new Set(), now }));
            const r = e.panelData(accounts, cap, opts).rows[1];
            assert.deepStrictEqual([r.icon, r.actions], ['readonly', []]);
        } finally { delete cfg.usageFile; }
    }));

    await check('codex: render escapes a Codex row too', () => {
        const bad = '<img src=x onerror="a()">';
        const d = { ...pdFour(), rows: [{ label: bad, provider: 'codex', icon: 'readonly', tip: 'Codex (read-only)', summary: '<q>', five: 1, week: 1,
            fiveReset: '<s>', weekReset: null, age: null, email: null, actions: [] }] };
        const html = panel().render(d, ui({ openRow: bad }));
        assert.ok(html.includes('&lt;img') && !html.includes('<img src=x') && !html.includes('onerror="'));
        assert.ok(!html.includes('<q>') && !html.includes('<s>') && html.includes('&lt;q&gt;') && html.includes('&lt;s&gt;'));
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

    // --- History view and pace (ccswitch's .usage-history.jsonl) -------------------------------------
    const pt = (dt, p5, p7, r5 = now + 3600, r7 = now + 3 * 86400) => ({ t: now - dt, p5, p7, r5, r7 });

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
            assert.deepStrictEqual(last().history.map((h) => h.label), ['work']);
            assert.deepStrictEqual(step(() => onMsg({ wantHistory: true })), ['dead', 'half', 'personal', 'spare', 'work'], 'History tab: every saved account');
            assert.deepStrictEqual(last().history.map((h) => h.label), ['work', 'personal']);
            assert.deepStrictEqual(step(() => onMsg({ wantHistory: false })), ['work']);
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

    const withHist = (h002, more = {}) => {
        const a = four().map((x) => ({ ...x, history: x.label === '002' ? h002 : (more[x.label] || []) }));
        return e.panelData(a, capOf(a, '002', ['003']), opts);
    };
    const rising = [pt(2400, 10, 50, now + 4 * 3600), pt(1200, 20, 51, now + 4 * 3600), pt(0, 30, 52, now + 4 * 3600)];

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
        assert.strictEqual(p.hoverAt(five, t0 + 900).rate, '+18.0%/h', '12 -> 15 in 10 min');
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
        assert.strictEqual(p.hoverAt(week, d2 + 5400).rate, '+12.0%/day');
        assert.ok(/^1d 23h ago \u00b7 (Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d\d:\d\d$/.test(w.when), w.when + ': a day or more back adds the weekday');
        assert.strictEqual(w.pct, '40%');
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
        const seg = (u) => p.render(d, ui({ view: 'history', ...u }));
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
        const mk = (histRange) => { const a = four().map((x) => ({ ...x, history: x.label === '002' ? hist : [] })); return e.panelData(a, capOf(a, '002', ['003']), { ...opts, histRange }); };
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
        const big = { ...d, history: [{ ...d.history[0], fiveSeries: series, weekSeries: series }] };
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
        const g30 = p.render(d, ui({ view: 'history', histLayout: 'grid', histRange: '30d' }));
        assert.strictEqual(g30.split('last 30d').length - 1, 8, 'range applies to every card: title and aria-label of 4 charts');
        assert.ok(p.render(d, ui({ view: 'history', histLayout: 'bogus' })).includes('class="rows"'), 'unknown layout = List');
        assert.ok(p.render({ ...d, history: [] }, ui({ view: 'history', histLayout: 'grid' })).includes('No history yet'));
        const css = readWv('panel.css');
        assert.match(css, /\.hgrid \{ display: grid; grid-template-columns: repeat\(auto-fill, minmax\(240px, 1fr\)\)/, 'columns follow the panel width');
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

    // --- Stats view (stats.js output, drawn by the panel) ---------------------------------------------
    const rangeOf = (over = {}) => ({ label: 'x', fromDate: '2026-10-01', favoriteModel: 'claude-opus-5-5', totalTokens: 23245249596, sessions: 57, totalMessages: 900,
        longestSession: { ms: (41 * 24 + 21) * 3600000, date: '2026-08-26' }, currentStreak: 3, longestStreak: 6, activeDays: 35, totalDays: 56, peakHour: 9,
        dailyActivity: [{ date: '2026-10-20', messageCount: 40 }, { date: '2026-10-21', messageCount: 10 }, { date: '2026-10-19', messageCount: 5 }, { date: '2026-10-18', messageCount: 80 }],
        models: [{ model: 'claude-opus-5-5', inputTokens: 1500, outputTokens: 2500000 }],
        tokensPerDay: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], days: [{ date: '2026-10-20', tokensByModel: { 'claude-opus-5-5': 10, 'claude-sonnet-5-5': 4 } }, { date: '2026-10-21', tokensByModel: { 'claude-opus-5-5': 20 } }] },
        funFact: 'Your input and output are ~3x the tokens in The Hobbit', ...over });
    const statsMsg = (over = {}) => ({ kind: 'stats', stats: { '7d': rangeOf({ sessions: 7, funFact: 'seven' }), '30d': rangeOf({ sessions: 30 }), all: rangeOf(), meta: { today: '2026-10-21' } }, ...over });

    await check('statsFeed: builds once, then reuses for 10 min; one build at a time; an error keeps the last stats', async () => {
        const sent = [], builds = [];
        let fail = false;
        const build = async (o) => { builds.push(o.cachePath); if (fail) throw new Error('boom'); return { n: builds.length }; };
        const feed = e.statsFeed('/tmp/c.json', (m) => sent.push(m), build);
        const first = feed();
        assert.strictEqual(feed(), undefined, 'a second request while building does nothing');
        await first;
        assert.deepStrictEqual(sent.map((m) => [m.building || false, m.stats ? m.stats.n : null]), [[true, null], [false, 1]]);
        feed();
        assert.strictEqual(builds.length, 1, 'within 10 min: the last result is sent again, no rebuild');
        assert.deepStrictEqual(sent[2].stats, { n: 1 });
        const real = Date.now;
        try {
            Date.now = () => real() + e.STATS_EVERY_MS + 1000;
            fail = true;
            await feed();
            assert.strictEqual(builds.length, 2);
            const last = sent[sent.length - 1];
            assert.strictEqual(last.error, 'boom');
            assert.deepStrictEqual(last.stats, { n: 1 }, 'the last good stats stay on screen');
        } finally { Date.now = real; }
        assert.deepStrictEqual(builds, ['/tmp/c.json', '/tmp/c.json']);
        const src = fs.readFileSync(file, 'utf8');
        assert.match(src, /statsFeed\(path\.join\(context\.globalStorageUri\.fsPath, 'stats-cache\.json'\)/, 'the cache lives in global storage');
        assert.match(src, /m\.wantStats\) \{ if \(v\.visible\) wantStats\(\); \}/, 'a hidden, retained Stats tab never rebuilds (review finding)');
        assert.match(src, /v\.onDidChangeVisibility\(\(\) => \{ if \(v\.visible\) push\(\); \}\)/, 'shown again: the panel gets data and can ask');
    });

    await check('statsFeed: a failed build is retried after about a minute, not kept for 10 min (review finding)', async () => {
        const sent = [];
        let fail = true, builds = 0;
        const feed = e.statsFeed('/tmp/c.json', (m) => sent.push(m), async () => { builds++; if (fail) throw new Error('boom'); return { n: builds }; });
        const real = Date.now, t0 = real();
        try {
            Date.now = () => t0;
            await feed();
            assert.strictEqual(sent[sent.length - 1].error, 'boom');
            feed();
            assert.strictEqual(builds, 1, 'right after a failure: the error is sent again, no rebuild loop');
            assert.ok(e.STATS_RETRY_MS <= 2 * 60 * 1000 && e.STATS_RETRY_MS < e.STATS_EVERY_MS);
            Date.now = () => t0 + e.STATS_RETRY_MS + 1000;
            fail = false;
            await feed();
            assert.strictEqual(builds, 2, 'a minute later: built again');
            assert.deepStrictEqual(sent[sent.length - 1].stats, { n: 2 });
            fail = true;
            Date.now = () => t0 + e.STATS_RETRY_MS + 1000 + e.STATS_EVERY_MS + 1000;
            await feed();
            Date.now = () => t0 + 2 * e.STATS_RETRY_MS + 3000 + e.STATS_EVERY_MS;
            await feed();
            assert.strictEqual(builds, 4, 'a failure after a good build is retried a minute later too');
            assert.deepStrictEqual(sent[sent.length - 1].stats, { n: 2 }, 'the last good stats stay on screen');
        } finally { Date.now = real; }
    });

    await check('render: Stats tab; building, error, and the overview like the CLI /stats', () => {
        const p = panel();
        assert.ok(p.render(pdFour(), ui({ view: 'stats' }), null).includes('Building stats'));
        assert.ok(p.render(pdFour(), ui({ view: 'stats' }), { kind: 'stats', error: '<x>' }).includes('Stats failed: &lt;x&gt;'));
        const html = p.render(pdFour(), ui({ view: 'stats' }), statsMsg());
        assert.ok(html.includes('aria-selected="true" data-a="view" data-l="stats"'));
        assert.ok(html.includes('This machine · all accounts') && !html.includes('updating'));
        let at = 0;
        for (const t of ['data-l="all">All time', 'Activity', 'Overview', 'Favorite model', 'claude-opus-5-5', 'Total tokens', '23.2B', 'Sessions', '>57<',
            'Longest session', '41d 21h', '2026-08-26', 'Current streak', '3 days', 'Longest streak', '6 days', 'Active days', '35/56', 'Peak hour', '09:00-10:00',
            'The Hobbit', 'Tokens per day', 'Models', 'In 1.5k · Out 2.5M']) { const k = html.indexOf(t, at); assert.ok(k >= 0, 'in order: ' + t); at = k; }
        assert.strictEqual(html.split('<rect ').length - 1, 25 * 7 + 4, '26 weeks of days: 25 full weeks, then Sunday to today (a Wednesday)');
        assert.match(html, /class="lv4"[^>]*><title>2026-10-18: 80 messages/);
        assert.match(html, /class="lv0"[^>]*><title>2026-10-17: 0 messages/);
        assert.strictEqual(html.split('<polyline class="ln m').length - 1, 2, 'one line per top model');
        assert.ok(p.render(pdFour(), ui({ view: 'stats' }), statsMsg({ building: true })).includes('updating…'), 'a rebuild keeps the old stats on screen');
    });

    await check('render: Stats ranges switch the numbers; the current streak is always all-time; text is escaped', () => {
        const p = panel();
        const week = p.render(pdFour(), ui({ view: 'stats', statsRange: '7d' }), statsMsg());
        assert.ok(week.includes('aria-selected="true" data-a="srange" data-l="7d"') && week.includes('>7<') && week.includes('seven'));
        const bad = statsMsg();
        bad.stats.all = rangeOf({ favoriteModel: '<img src=x>', funFact: '<b>f</b>', models: [{ model: '<m>', inputTokens: 1, outputTokens: 1 }],
            tokensPerDay: { models: ['<q>'], days: [{ date: '<d>', tokensByModel: {} }] } });
        const html = p.render(pdFour(), ui({ view: 'stats' }), bad);
        assert.ok(!/<img src=x|<b>f|<m>|<q>|<d>/.test(html), 'escaped');
        const src = readWv('panel.js');
        assert.match(src, /ev\.data\.kind === 'stats'\) stats = ev\.data/, 'stats messages do not replace the account data');
        assert.match(src, /l === 'stats'\) vsc\.postMessage\(\{ wantStats: 1 \}\)/, 'opening the tab asks for stats');
    });

    await check('render: a non-number where Stats or History expects a number never reaches the HTML (review finding)', () => {
        const p = panel(), x = '<img src=x onerror=a()>';
        const st = statsMsg();
        st.stats.all = rangeOf({ totalTokens: x, sessions: x, activeDays: x, totalDays: x, longestStreak: x, peakHour: x, currentStreak: x,
            longestSession: { ms: x, date: '2026-08-26' }, dailyActivity: [{ date: '2026-10-20', messageCount: x }, { date: '2026-10-21', messageCount: 3 }],
            models: [{ model: 'm', inputTokens: x, outputTokens: { toString: () => x } }],
            tokensPerDay: { models: ['m'], days: [{ date: '2026-10-20', tokensByModel: { m: x } }, { date: '2026-10-21', tokensByModel: { m: 5 } }] } });
        st.stats.all.currentStreak = x;
        const html = p.render(pdFour(), ui({ view: 'stats' }), st);
        assert.ok(!html.includes('<img'), 'stats: ' + html.slice(html.indexOf('<img') - 80, html.indexOf('<img') + 20));
        assert.ok(html.includes('Sessions</span><span class="v">–<'), 'a bad number shows a dash');
        const h = { ...withHist(rising), history: [{ label: 'a', icon: 'switch', tip: 't', five: x, week: '9" onmouseover="a()',
            fiveSeries: [[x, x, x], [now, 5, null]], weekSeries: [[now, { toString: () => x }, null]], fivePace: null, weekPace: null }] };
        const hist = p.render(h, ui({ view: 'history' }));
        assert.ok(!hist.includes('<img') && !hist.includes('onmouseover'), 'history: ' + hist.slice(0, 400));
        assert.ok(!p.render({ ...pdFour(), active: { ...pdFour().active, five: x } }, ui()).includes('<img'), 'the Usage bars too');
    });

    // --- G7: turning auto-switch on asks once ----------------------------------------------------------
    await check('G7 turning auto-switch on asks once, in a modal', async () => {
        said.length = saidOpts.length = updates.length = 0;
        answer = undefined;
        const st = memento(false);
        assert.strictEqual(await e.setAutoSwitch(true, st), false);
        assert.strictEqual(st.get(e.CONSENT), undefined, 'no consent recorded on No');
        assert.deepStrictEqual(updates, []);
        assert.strictEqual(said.length, 1);
        assert.strictEqual(saidOpts[0].modal, true);
        assert.strictEqual(said[0], 'Turn on auto-switch?');
        answer = 'Turn on';
        assert.strictEqual(await e.setAutoSwitch(true, st), true);
        assert.deepStrictEqual(updates, [['autoSwitch', true, 1]]);
        assert.strictEqual(st.get(e.CONSENT), true, 'the confirmation is recorded on this machine');
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
        assert.ok(!/skips/.test(p.markdownDescription), 'no door skips the dialog any more');
    });

    await check('the toggle command and the panel both go through setAutoSwitch', () => {
        const src = fs.readFileSync(file, 'utf8');
        assert.ok(!/update\('autoSwitch'/.test(src.replace(/async function setAutoSwitch[\s\S]*?\n}\n/, '')), 'one writer of the setting');
    });

    // --- auto-switch: the path that moves the live login (work is active, fresh, 5h at 100%) ---------------
    const STAMP = path.join(ACC, '.autoswitch.json'), LOCK = path.join(ACC, '.autoswitch.lock');
    const SWITCH_RC = path.join(HOME, 'switch.rc');
    const autoReset = () => { for (const f of [STAMP, LOCK, LOG, SWITCH_RC]) fs.rmSync(f, { recursive: true, force: true }); said.length = updates.length = 0; answer = undefined; };
    // One VS Code window whose login check has run: a fresh instance plus one `usage --json` with this health.
    const win = async (health = 'known') => {
        const w = load();
        usageReply(usageDoc({ work: 'ok', personal: 'ok', half: 'ok' }, health));
        await w.checkLogins();
        fs.rmSync(LOG, { force: true });
        return w;
    };
    const tryAuto = async (w, st = memento(true)) => w.autoSwitch(w.readAccounts().cap, st, () => {});
    const minsAgo = (m) => Math.floor(Date.now() / 1000) - m * 60;

    await check('auto-switch: off by default (package.json) and off does nothing', async () => {
        autoReset();
        assert.strictEqual(require('../vscode/package.json').contributes.configuration.properties['claudeUsage.autoSwitch'].default, false);
        const res = await tryAuto(await win());
        assert.strictEqual(res.skip, 'off');
        assert.deepStrictEqual(calls(), []);
    });

    cfg.autoSwitch = true;
    try {
        await check('auto-switch: active full and fresh, login check known, consent given -> one `ccswitch <best>`', async () => {
            autoReset();
            const res = await tryAuto(await win());
            assert.deepStrictEqual(calls(), ['personal']);
            assert.strictEqual(res.to, 'personal');
            assert.ok(said.some((t) => t.startsWith('Auto-switched Claude Code: work is full, now on personal')), said.join('|'));
            assert.ok(Math.abs(JSON.parse(fs.readFileSync(STAMP, 'utf8')).last_switch - Date.now() / 1000) < 5, 'the stamp holds the switch time');
            assert.ok(!fs.existsSync(LOCK), 'the lock is released');
        });

        await check('auto-switch: the 10-min cooldown holds across windows (stamp file)', async () => {
            autoReset();
            const a = await win(), b = await win();
            await tryAuto(a);
            const res = await tryAuto(b);
            assert.deepStrictEqual(calls(), ['personal'], 'the second window does not switch again');
            assert.strictEqual(res.skip, 'cooldown');
            autoReset(); fs.writeFileSync(STAMP, JSON.stringify({ last_switch: minsAgo(9) }));
            assert.strictEqual((await tryAuto(await win())).skip, 'cooldown', 'a reload does not reset it');
            autoReset(); fs.writeFileSync(STAMP, JSON.stringify({ last_switch: minsAgo(11) }));
            await tryAuto(await win());
            assert.deepStrictEqual(calls(), ['personal']);
        });

        await check('auto-switch: two windows at once -> one switch (mkdir lock); a stale lock is taken over', async () => {
            autoReset();
            const [a, b] = [await win(), await win()];
            await Promise.all([tryAuto(a), tryAuto(b)]);
            assert.deepStrictEqual(calls(), ['personal']);
            autoReset(); fs.mkdirSync(LOCK);
            assert.strictEqual((await tryAuto(await win())).skip, 'busy');
            assert.deepStrictEqual(calls(), []);
            assert.ok(fs.existsSync(LOCK), 'another window\'s lock is left alone');
            fs.utimesSync(LOCK, minsAgo(11), minsAgo(11));
            await tryAuto(await win());
            assert.deepStrictEqual(calls(), ['personal'], 'a lock left by a crashed window does not block forever');
        });

        await check('auto-switch: re-reads the live account; stops if it moved or is no longer full', async () => {
            autoReset();
            const w = await win(), cap = w.readAccounts().cap;
            const live = path.join(HOME, '.claude.json'), was = fs.readFileSync(live, 'utf8');
            const cache = path.join(ACC, 'work', '.usage-cache'), wasCache = fs.readFileSync(cache, 'utf8');
            try {
                fs.writeFileSync(live, JSON.stringify({ oauthAccount: { emailAddress: 'me@home.example' } }));  // ccswitch personal in a terminal
                assert.strictEqual((await w.autoSwitch(cap, memento(true), () => {})).skip, 'moved');
                fs.writeFileSync(live, was);
                fs.writeFileSync(cache, JSON.stringify({ ...JSON.parse(wasCache), five_hour_pct: 50 }));  // the window reset
                assert.strictEqual((await w.autoSwitch(cap, memento(true), () => {})).skip, 'moved');
                assert.deepStrictEqual(calls(), []);
                assert.ok(!fs.existsSync(STAMP), 'no switch, no cooldown');
            } finally { fs.writeFileSync(live, was); fs.writeFileSync(cache, wasCache); }
        });

        await check('auto-switch: a stamp in the future (a wrong clock) does not block switching', async () => {
            autoReset(); fs.writeFileSync(STAMP, JSON.stringify({ last_switch: minsAgo(-24 * 60) }));
            const res = await tryAuto(await win());
            assert.notStrictEqual(res.skip, 'cooldown');
        });

        await check('auto-switch: during the cooldown no lock is taken, so the watched folder stays still', async () => {
            // Every window watches the accounts folder; a lock made and removed on each poll would wake them all.
            autoReset(); fs.writeFileSync(STAMP, JSON.stringify({ last_switch: minsAgo(2) }));
            const w = await win(), before = fs.statSync(ACC).mtimeMs;
            await new Promise((ok) => setTimeout(ok, 20));
            assert.strictEqual((await tryAuto(w)).skip, 'cooldown');
            assert.strictEqual(fs.statSync(ACC).mtimeMs, before, 'no mkdir/rmdir in the accounts folder');
        });

        await check('auto-switch: a failed switch shows the error and still starts the cooldown', async () => {
            autoReset(); fs.writeFileSync(SWITCH_RC, '1');
            const res = await tryAuto(await win());
            assert.deepStrictEqual(calls(), ['personal']);
            assert.strictEqual(res.r.ok, false);
            assert.ok(said.some((t) => t.startsWith('ERROR Auto-switch to personal failed')), said.join('|'));
            assert.ok(!said.some((t) => t.startsWith('Auto-switched')));
            assert.ok(fs.existsSync(STAMP), 'no retry on every poll');
            assert.ok(!fs.existsSync(LOCK));
        });

        await check('auto-switch: an error (stamp not writable) is shown, not dropped, and the lock is released', async () => {
            autoReset(); fs.mkdirSync(STAMP);  // a directory where the stamp file goes
            try {
                const res = await tryAuto(await win());
                assert.strictEqual(res.skip, 'error');
                assert.deepStrictEqual(calls(), [], 'no stamp, no switch');
                assert.ok(said.some((t) => t.startsWith('ERROR Auto-switch failed: ')), said.join('|'));
                assert.ok(!fs.existsSync(LOCK));
            } finally { for (const f of fs.readdirSync(ACC)) if (f.startsWith('.autoswitch.json.')) fs.rmSync(path.join(ACC, f)); }
        });

        await check('auto-switch: nothing before the first login check, or after a failed one', async () => {
            autoReset();
            const fresh = load();
            assert.strictEqual((await tryAuto(fresh)).skip, 'no login check yet');
            const w = await win();
            usageReply('timeout', 1);
            await w.checkLogins();
            assert.strictEqual((await tryAuto(w)).skip, 'login health unknown');
            assert.deepStrictEqual(calls().filter((c) => c !== 'usage --json'), []);
        });

        await check('auto-switch: nothing while login health is unknown', async () => {
            autoReset();
            assert.strictEqual((await tryAuto(await win('unknown'))).skip, 'login health unknown');
            assert.deepStrictEqual(calls(), []);
        });

        await check('auto-switch: on without consent (settings.json, older version) asks once; No turns it off', async () => {
            autoReset();
            const w = await win(), st = memento(false);
            const [r1, r2] = await Promise.all([tryAuto(w, st), tryAuto(w, st)]);
            assert.strictEqual(said.filter((t) => t === 'Turn on auto-switch?').length, 1, 'one dialog, however many polls');
            assert.deepStrictEqual(updates, [['autoSwitch', false, 1]]);
            assert.strictEqual(r1.skip, 'no consent'); assert.strictEqual(r2.skip, 'no consent');
            assert.deepStrictEqual(calls(), []);
            autoReset(); answer = 'Turn on';
            await tryAuto(w, st);
            assert.strictEqual(st.get(e.CONSENT), true);
            assert.deepStrictEqual(calls(), ['personal'], 'confirmed: it switches');
        });

        await check('autoBlock: every gate, in order', () => {
            const cap = capNow(), g = { on: true, consented: true, installed: true, checked: true, health: 'known', cap };
            assert.strictEqual(e.autoBlock(g), null);
            assert.strictEqual(e.autoBlock({ ...g, on: false }), 'off');
            assert.strictEqual(e.autoBlock({ ...g, consented: false }), 'no consent');
            assert.strictEqual(e.autoBlock({ ...g, installed: false }), 'no ccswitch');
            assert.strictEqual(e.autoBlock({ ...g, checked: false }), 'no login check yet');
            assert.strictEqual(e.autoBlock({ ...g, health: 'unknown' }), 'login health unknown');
            assert.strictEqual(e.autoBlock({ ...g, cap: { ...cap, best: null } }), 'no target');
            assert.strictEqual(e.autoBlock({ ...g, cap: { ...cap, best: { label: '-h' } } }), 'no target', 'a target must pass the label rule');
        });
    } finally { delete cfg.autoSwitch; autoReset(); }

    // --- status bar text ---------------------------------------------------------------------------------
    const sb = (a, you, relogin = [], over = {}) => ({ ...capOf(a, you, relogin), ...over });
    const sbAcc = () => [acct('work', 100, 40, now - 60), acct('personal', 10, 5, now - 30)];

    await check('statusText: active and next-best', () => {
        const a = sbAcc();
        assert.strictEqual(e.statusText(sb(a, 'work'), a, false), '● work 100%/40% · ⇄ personal');
    });

    await check('statusText: a Codex row with the active label never shows as your numbers', () => {
        // A saved Claude account may be named codex; its own row is the one the status bar reads.
        const a = [{ ...acct('codex', 77, 66, now - 60), provider: 'codex' }, acct('codex', 20, 30, now - 60), acct('personal', 10, 5, now - 30)];
        assert.ok(e.statusText(sb(a, 'codex'), a, false).startsWith('● codex 20%/30%'));
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

    await check('dialog texts name what the terminal runs: ccswitch add, no SAVE card', () => {
        const src = fs.readFileSync(file, 'utf8');
        assert.ok(!/\bSAVE\b/.test(src), 'no SAVE button any more');
        assert.ok(!/\bcard\b/.test(src), 'no cards any more');
        assert.match(src, /runs ccswitch add \$\{label\}/);
        assert.ok(!/type \/login/.test(src), 'enroll no longer asks for /login');
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

    await check('reload button: the codicon refresh icon is in the panel; it spins only when busy; reduced motion stops the rotation', () => {
        const p = panel(), idle = p.render(pdFour(), ui()), busy = p.render(pdFour(), ui(), null, true);
        assert.match(idle, /<button class="rl" data-a="reload"[^>]*aria-busy="false"><span class="codicon codicon-refresh"/);
        assert.match(busy, /<button class="rl spin" data-a="reload"[^>]*aria-busy="true"/);
        const css = readWv('panel.css');
        assert.match(css, /\.rl\.spin \.codicon \{ animation: rl-spin/);
        assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.rl\.spin \.codicon \{ animation: none/);
    });

    await check('reload button: spin is set by a click and by the timed fetch, not by the 60 s poll; it clears on success and on failure; a second click runs no second fetch', async () => {
        const posted = [], timers = [], ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(HOME, 'gs') }, globalState: memento(false) };
        let provider, onMsg;
        const keep = { win: { ...vscode.window }, commands: vscode.commands, ws: vscode.workspace.onDidChangeConfiguration, st: global.setTimeout, si: global.setInterval };
        Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: (id, pr) => { provider = pr; return { dispose() {} }; } });
        vscode.StatusBarAlignment = { Right: 2 };
        vscode.commands = { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} };
        vscode.extensions = { getExtension: () => undefined };
        vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} });
        global.setTimeout = (f, ms, ...a) => (ms === 30000 || ms === 600000 ? (timers.push([ms, f]), 0) : keep.st(f, ms, ...a));  // capture the app's timers, keep the rest real
        global.setInterval = (f, ms) => { timers.push([ms, f]); return 0; };
        const fetches = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '').split('\n').filter((l) => l === 'usage --json').length;
        const busyOf = () => posted.filter((m) => m.kind === 'busy').map((m) => m.on);
        const idle = async () => { for (let i = 0; i < 200 && busyOf().length % 2; i++) await new Promise((r) => keep.st(r, 25)); };
        try {
            usageReply(usageDoc({ work: 'ok' }));
            load().activate(ctx);
            global.setTimeout = keep.st; global.setInterval = keep.si;
            const v = { visible: true, onDidChangeVisibility: () => {}, onDidDispose: () => {},
                webview: { ...fakeWebview, postMessage: async (m) => { posted.push(m); }, onDidReceiveMessage: (f) => { onMsg = f; } } };
            provider.resolveWebviewView(v);
            const poll = timers.find(([ms]) => ms === 60000)[1], timed = timers.filter(([ms]) => ms === 600000 || ms === 30000).map(([, f]) => f);
            assert.strictEqual(timed.length, 2, 'the 30 s first check and the 10 min check');
            poll(); await idle();
            assert.deepStrictEqual(busyOf(), [], 'the 60 s cache re-read never spins');
            const n0 = fetches();
            onMsg({ refresh: 1 }); onMsg({ refresh: 1 });  // a second click while the first fetch runs
            assert.deepStrictEqual(busyOf(), [true], 'a click sets the spin at once');
            await idle();
            assert.deepStrictEqual(busyOf(), [true, false], 'success clears the spin');
            assert.strictEqual(fetches() - n0, 1, 'the second click ran no second fetch');
            posted.length = 0;
            timed[1](); assert.deepStrictEqual(busyOf(), [true], 'the 10 min fetch spins');
            await idle(); assert.deepStrictEqual(busyOf(), [true, false]);
            posted.length = 0;
            timed[0](); assert.deepStrictEqual(busyOf(), [true], 'the 30 s first check spins');
            await idle();
            posted.length = 0;
            usageReply('not json', 1);  // a failed fetch
            onMsg({ refresh: 1 }); assert.deepStrictEqual(busyOf(), [true]);
            await idle(); assert.deepStrictEqual(busyOf(), [true, false], 'failure clears the spin');
            onMsg({ refresh: 1 }); await idle();
            assert.strictEqual(fetches() - n0, 5, 'after the fetch ends, a click fetches again');
        } finally {
            global.setTimeout = keep.st; global.setInterval = keep.si;
            Object.assign(vscode.window, keep.win);
            vscode.commands = keep.commands;
            vscode.workspace.onDidChangeConfiguration = keep.ws;
            usageReply('');
            for (const d of ctx.subscriptions) if (d && d.dispose) d.dispose();
        }
    });

    await check('reload: the Refresh command runs the guarded fetch with the spin; a rejecting fetch clears it; a seat switch runs no second fetch', async () => {
        const posted = [], cmds = {}, ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(HOME, 'gs') }, globalState: memento(false) };
        let provider, onMsg;
        const keep = { win: { ...vscode.window }, commands: vscode.commands, ws: vscode.workspace.onDidChangeConfiguration, exists: fs.existsSync };
        Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: (id, pr) => { provider = pr; return { dispose() {} }; } });
        vscode.StatusBarAlignment = { Right: 2 };
        vscode.commands = { registerCommand: (id, f) => { cmds[id] = f; return { dispose() {} }; }, executeCommand: async () => {} };
        vscode.extensions = { getExtension: () => undefined };
        vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} });
        const fetches = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '').split('\n').filter((l) => l === 'usage --json').length;
        const busyOf = () => posted.filter((m) => m.kind === 'busy').map((m) => m.on);
        const idle = async () => { for (let i = 0; i < 200 && busyOf().length % 2; i++) await new Promise((r) => setTimeout(r, 25)); };
        try {
            usageReply(usageDoc({ work: 'ok' }));
            const x = load();  // the instance that is activated is the one whose guard the switch must share
            x.activate(ctx);
            provider.resolveWebviewView({ visible: true, onDidChangeVisibility: () => {}, onDidDispose: () => {},
                webview: { ...fakeWebview, postMessage: async (m) => { posted.push(m); }, onDidReceiveMessage: (f) => { onMsg = f; } } });
            await idle();
            const n0 = fetches();
            cmds['claudeUsage.refresh'](); cmds['claudeUsage.refresh']();
            assert.deepStrictEqual(busyOf(), [true], 'the command spins at once, once');
            await idle();
            assert.deepStrictEqual(busyOf(), [true, false]);
            assert.strictEqual(fetches() - n0, 1, 'the command ran one real fetch');
            // #5: a seat switch to an expired seat (it syncs tokens first) while a fetch runs joins that fetch
            x.relogin.add('personal'); answer = 'Open terminal'; posted.length = 0;
            const n1 = fetches();
            onMsg({ refresh: 1 });
            await x.switchSeat('personal', () => {});
            await idle();
            assert.strictEqual(fetches() - n1, 1, 'the switch ran no second `ccswitch usage --json`');
            // #2: checkLogins rejects (not just a bad reply): the spin still clears
            posted.length = 0;
            fs.existsSync = (f) => { if (f === path.join(HOME, '.claude', 'ccswitch')) throw new Error('boom'); return keep.exists(f); };
            onMsg({ refresh: 1 });
            assert.deepStrictEqual(busyOf(), [true]);
            await idle();
            assert.deepStrictEqual(busyOf(), [true, false], 'a rejecting fetch clears the spin');
            fs.existsSync = keep.exists;
            onMsg({ refresh: 1 }); await idle();
            assert.deepStrictEqual(busyOf(), [true, false, true, false], 'after a rejection, the next click fetches again');
        } finally {
            fs.existsSync = keep.exists;
            Object.assign(vscode.window, keep.win);
            vscode.commands = keep.commands;
            vscode.workspace.onDidChangeConfiguration = keep.ws;
            usageReply('');
            for (const d of ctx.subscriptions) if (d && d.dispose) d.dispose();
        }
    });

    await check('reload (webview): idle click posts {refresh:1}; busy click posts nothing; busy toggles the spin; the spin survives a repaint and keeps its phase', () => {
        let T = 5250, onMessage, onClick;
        const sent = [], icon = { style: {} };
        const root = { innerHTML: '', addEventListener: (t, f) => { if (t === 'click') onClick = f; },
            querySelector: () => (/class="rl spin"/.test(root.innerHTML) ? icon : null), querySelectorAll: () => [] };
        const ctx = { esc: e.esc, document: { getElementById: () => root, activeElement: null },
            window: { addEventListener: (t, f) => { if (t === 'message') onMessage = f; } },
            acquireVsCodeApi: () => ({ getState: () => null, setState() {}, postMessage: (m) => sent.push(m) }), Date: { now: () => T } };
        require('vm').runInNewContext(readWv('panel.js'), ctx);
        const data = pdFour(), msg = (m) => onMessage({ data: m }), spinning = () => /class="rl spin"/.test(root.innerHTML);
        const click = () => onClick({ target: { closest: () => ({ dataset: { a: 'reload' } }) } });
        msg(data);
        sent.length = 0; click();
        assert.deepStrictEqual(JSON.parse(JSON.stringify(sent)), [{ refresh: 1 }], 'an idle click asks the host to fetch');
        assert.ok(!spinning());
        msg({ kind: 'busy', on: true });
        assert.ok(spinning(), 'busy:true starts the spin');
        assert.strictEqual(icon.style.animationDelay, '-250ms');
        sent.length = 0; click();
        assert.deepStrictEqual(sent, [], 'a click while busy posts nothing');
        T = 5750; msg(data);
        assert.ok(spinning(), 'a data repaint keeps the spin');
        assert.strictEqual(icon.style.animationDelay, '-750ms', 'the repainted icon starts at the phase the old one reached');
        msg({ kind: 'busy', on: false });
        assert.ok(!spinning(), 'busy:false stops the spin');
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

    console.log('----------------------------------------');
    console.log(`Passed: ${passed}  Failed: ${failed}`);
    process.exit(failed ? 1 : 0);
})();
