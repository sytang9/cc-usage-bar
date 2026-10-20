// Unit tests for vscode/extension.js. Loads the extension with a stub `vscode` module in a sandboxed HOME
// (set by vscode_extension_test.sh) and a stub ccswitch that only records its arguments. Never touches ~/.claude.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const HOME = process.env.HOME;
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
let answer;
const vscode = {
    window: {
        showWarningMessage: async (m, o, ...b) => { said.push(m); return answer; },
        showInformationMessage: async (m, o, ...b) => { said.push(m); return typeof o === 'object' ? answer : undefined; },
        showErrorMessage: (m) => said.push('ERROR ' + m),
        createTerminal: () => ({ show() {}, sendText(t) { said.push('TERMINAL ' + t); } }),
    },
    workspace: { getConfiguration: () => ({ get: (k) => cfg[k] }) },
    commands: {}, env: {},
};
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? vscode : orig.call(this, r, ...a); };
const file = path.join(__dirname, '..', 'vscode', 'extension.js');
const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file, 'utf8') + '\n;Object.assign(module.exports, { readSnapshot, isFresh, qualifies, capacity, parseUsageJson, mergeLogins, readAccounts, activeLabel, autoTarget, checkLogins, relogin, switchSeat, saveSeat, esc, webviewHtml, popupDoc, panelData, ageText });', file);
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
        assert.strictEqual(cap.free, 3);
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
        assert.deepStrictEqual(d.counts, { total: 4, relogin: 1, full: 1 });
        assert.deepStrictEqual(Object.fromEntries(d.rows.map((r) => [r.label, r.icon])), { '001': 'full', '002': 'active', '003': 'relogin', '004': 'switch' });
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
        assert.deepStrictEqual(d.counts, { total: 4, relogin: 1, full: 1 });
        assert.strictEqual(d.rows[0].icon, '', 'a stale account is not a switch target');
        assert.strictEqual(d.rows[0].age, '2h old');
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

    await check('old ccswitch without --json: marks nothing, health unknown', async () => {
        e.relogin.add('personal');
        usageReply("Error: unknown option '--json' for 'usage'.", 1);
        await e.checkLogins();
        assert.strictEqual(e.relogin.size, 0);
        assert.strictEqual(e.readAccounts().cap.loginHealth, 'unknown');
    });

    await check('garbage on stdout is not trusted', async () => {
        e.relogin.add('personal');
        usageReply('warning\n{"schema":1');
        await e.checkLogins();
        assert.strictEqual(e.relogin.size, 0);
        assert.strictEqual(e.readAccounts().cap.loginHealth, 'unknown');
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

    await check('the webview locks itself down with a CSP and escapes every label it writes as HTML', () => {
        const html = e.webviewHtml(e.popupDoc());
        assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; [^"]*">/);
        assert.ok(html.includes('function esc('), 'the page carries the same esc as the extension');
        // every label/name that reaches innerHTML or an attribute string goes through esc()
        assert.ok(html.includes("esc(cap.best.label)") && html.includes("Save your current login as ' + esc(name)")
            && html.includes("Delete the saved login for ' + esc(name)"));
        assert.ok(!/\+ cap\.best\.label \+|as ' \+ name \+|for ' \+ name \+/.test(html), 'no raw label in HTML strings');
    });

    await check('switch texts agree with ccswitch: open Claude Code tabs need a restart', () => {
        const src = fs.readFileSync(file, 'utf8');
        assert.ok(!/carry on as the new seat/.test(src), 'no hot-swap claim');
        assert.match(src, /restart open Claude Code tabs/i);
    });

    console.log('----------------------------------------');
    console.log(`Passed: ${passed}  Failed: ${failed}`);
    process.exit(failed ? 1 : 0);
})();
