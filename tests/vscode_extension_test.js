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
fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'me@work.example' } }));
const ccswitch = path.join(HOME, '.claude', 'ccswitch');
fs.writeFileSync(ccswitch, `#!/usr/bin/env bash\necho "$*" >> "${LOG}"\n[[ "$1" == usage ]] && printf '  ACCOUNT  5H\\n* work     100%%\\n  personal re-login\\n  spare    wait\\n'\nexit 0\n`);
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
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    commands: {}, env: {},
};
const orig = Module._load;
Module._load = function (r, ...a) { return r === 'vscode' ? vscode : orig.call(this, r, ...a); };
const file = path.join(__dirname, '..', 'vscode', 'extension.js');
const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file, 'utf8') + '\n;Object.assign(module.exports, { readAccounts, activeLabel, autoTarget, checkLogins, relogin, switchSeat, saveSeat, esc, webviewHtml, popupDoc });', file);
const e = m.exports;
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n') : []);

(async () => {
    await check('activeLabel maps the live email to its saved label (not the email local part)', () =>
        assert.strictEqual(e.activeLabel(), 'work'));

    await check('readAccounts reads ccswitch usage caches and emails, no team file needed', () => {
        const { accounts, cap } = e.readAccounts();
        assert.deepStrictEqual(accounts.map((a) => a.name), ['personal', 'spare', 'work']);
        assert.strictEqual(accounts.find((a) => a.name === 'work').data.profile.email, 'me@work.example');
        assert.strictEqual(accounts.find((a) => a.name === 'work').data.usage[0].pct_text, '100%');
        assert.strictEqual(accounts.find((a) => a.name === 'spare').data.usage.length, 0);
        assert.strictEqual(cap.best.label, 'personal');
        assert.strictEqual(cap.free, 1);
        assert.strictEqual(cap.updated, now - 60, 'updated = oldest fetch');
        assert.strictEqual(cap.stale, false);
    });

    await check('autoTarget: full current seat -> most headroom; never stale, unsaved, full or same seat', () => {
        const cap = { stale: false, you: 'a', best: { label: 'b' }, loads: { a: 100, b: 10 } }, all = () => true;
        assert.strictEqual(e.autoTarget(cap, all), 'b');
        assert.strictEqual(e.autoTarget({ ...cap, loads: { a: 99, b: 10 } }, all), null);
        assert.strictEqual(e.autoTarget({ ...cap, stale: true }, all), null);
        assert.strictEqual(e.autoTarget(cap, (l) => l !== 'b'), null);
        assert.strictEqual(e.autoTarget({ ...cap, loads: { a: 100, b: 100 } }, all), null);
        assert.strictEqual(e.autoTarget({ ...cap, you: 'b' }, all), null);
    });

    await check('checkLogins trusts ccswitch: re-login marks a seat, wait does not', async () => {
        await e.checkLogins();
        assert.deepStrictEqual([...e.relogin], ['personal']);
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
        e.relogin.add('personal'); fs.rmSync(LOG, { force: true }); answer = 'Open terminal'; said.length = 0;
        await e.switchSeat('personal', () => {});
        assert.deepStrictEqual(calls(), ['usage --no-switch']);
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
