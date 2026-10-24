// Shared harness for the VS Code sidebar tests (vscode/extension.js). Requiring it runs the sandbox guard first,
// then seeds the sandbox HOME (saved accounts, a stub ccswitch that only records its arguments), installs the stub
// `vscode` module and loads the extension. Each section file requires it first and wraps its tests in run().
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
// What the next dialog and input box answer; closeTerminal is the extension's onDidCloseTerminal handler.
// Fields, not variables: a section file cannot assign a binding it imported.
const stub = { answer: undefined, inputAnswer: undefined, closeTerminal: undefined };
const terminals = [], inputOpts = [];
const vscode = {
    window: {
        showWarningMessage: async (m, o, ...b) => { said.push(m); saidOpts.push(o); return stub.answer; },
        showInformationMessage: async (m, o, ...b) => { said.push(m); return typeof o === 'object' ? stub.answer : undefined; },
        showErrorMessage: (m) => said.push('ERROR ' + m),
        createTerminal: (name) => { const t = { name, show() {}, sendText(x) { said.push('TERMINAL ' + x); } }; terminals.push(t); return t; },
        onDidCloseTerminal: (f) => { stub.closeTerminal = f; return { dispose() {} }; },
        // Like VS Code: an Error from validateInput blocks the Enter key (a string counts as an error), so nothing is returned.
        showInputBox: async (o) => {
            inputOpts.push(o);
            const v = o.validateInput && stub.inputAnswer !== undefined ? o.validateInput(stub.inputAnswer) : null;
            return v && (typeof v === 'string' || v.severity !== 2) ? undefined : stub.inputAnswer;
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
const file = path.join(__dirname, '..', '..', 'vscode', 'extension.js');
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

// --- helpers shared by the section files ---------------------------------------------------------
const ctxFor = (relogin = new Set(), you = 'work') => ({ you, isSaved: (l) => fs.existsSync(path.join(ACC, l, 'credentials.json')), relogin, now });
const capNow = (relogin) => e.capacity(e.readSnapshot(), ctxFor(relogin));
// --- panelData: hand-built accounts (001 full, 002 active, 003 re-login and 13 d old, 004 fresh) ---
const acct = (label, five, week, fetched, extra = {}) => ({ label, provider: 'claude', state: 'ok', fetched_at: fetched,
    five_pct: five, week_pct: week, five_reset_epoch: now + 3600, week_reset_epoch: now + 86400, email: label + '@x.example', ...extra });
const capOf = (accounts, you, relogin = [], saved = accounts.map((a) => a.label)) => ({
    ...e.capacity({ accounts }, { you, isSaved: (l) => saved.includes(l), relogin: new Set(relogin), now }),
    relogin, saved, loginHealth: 'known' });
const four = () => [acct('001', 76, 100, now - 120), acct('002', 23, 64, now - 60), acct('003', 5, 5, now - 13 * 86400), acct('004', 46, 13, now - 60)];
const opts = { now, installed: true, auto: false };
const pdFour = () => { const a = four(); return e.panelData(a, capOf(a, '002', ['003']), opts); };
const WV = path.join(__dirname, '..', '..', 'vscode', 'webview');
function readWv(f) { return fs.readFileSync(path.join(WV, f), 'utf8'); }
function panel() { const ctx = { esc: e.esc }; require('vm').runInNewContext(readWv('panel.js'), ctx); return ctx; }
function ui(over = {}) { return { accountsOpen: true, automationOpen: false, openRow: null, ...over }; }
// The markup of one account row (the row line, not its details).
const rowOf = (html, label) => (html.match(new RegExp('<div class="row[^"]*" data-a="row" data-l="' + label + '"[\\s\\S]*?</div>')) || [''])[0];
// History points: dt seconds ago, 5h and weekly percent, their resets.
const pt = (dt, p5, p7, r5 = now + 3600, r7 = now + 3 * 86400) => ({ t: now - dt, p5, p7, r5, r7 });
const withHist = (h002, more = {}) => {
    const a = four().map((x) => ({ ...x, history: x.label === '002' ? h002 : (more[x.label] || []) }));
    return e.panelData(a, capOf(a, '002', ['003']), { ...opts, historyOn: true });
};
const rising = [pt(2400, 10, 50, now + 4 * 3600), pt(1200, 20, 51, now + 4 * 3600), pt(0, 30, 52, now + 4 * 3600)];

// Runs one file's tests, then prints its count line; exits 1 if any check failed.
const run = (fn) => (async () => {
    await fn();
    console.log('----------------------------------------');
    console.log(`Passed: ${passed}  Failed: ${failed}`);
    process.exit(failed ? 1 : 0);
})();

module.exports = {
    assert, fs, path, HOME, ACC, LOG, now, check, run, seat, ccswitch, usageReply,
    usageDoc, cfg, said, saidOpts, updates, stub, terminals, inputOpts, vscode, fakeWebview, file, load,
    e, memento, calls, ctxFor, capNow, acct, capOf, four, opts, pdFour, WV, readWv,
    panel, ui, rowOf, pt, withHist, rising,
};
