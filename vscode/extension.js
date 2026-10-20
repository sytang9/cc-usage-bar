// VS Code sidebar + status bar for ccswitch (cc-usage-bar): every saved account's 5h/weekly usage, which one has
// the most headroom, one-click switching, auto-switch. Usage comes from ccswitch's own per-account cache
// (~/.claude/accounts/<label>/.usage-cache, refreshed by `ccswitch usage`), or from a team snapshot file if
// `claudeUsage.usageFile` is set.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const usageFile = () => vscode.workspace.getConfiguration('claudeUsage').get('usageFile') || '';  // '' = ccswitch's cache
const POLL_MS = 60 * 1000;  // keeps reset times and the per-account data age current
const HOME = require('os').homedir();
const CCSWITCH = path.join(HOME, '.claude', 'ccswitch');
const ACCOUNTS = path.join(HOME, '.claude', 'accounts');
const saved = (label) => fs.existsSync(path.join(ACCOUNTS, label, 'credentials.json'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const emailOf = (label) => (readJson(path.join(ACCOUNTS, label, 'oauthAccount.json')) || {}).emailAddress || null;
const savedLabels = () => { try { return fs.readdirSync(ACCOUNTS).filter(saved).sort(); } catch { return []; } };

// The saved account the live login belongs to (matched by email, like ccswitch's '*'); else the email's local part.
function activeLabel() {
    const email = ((readJson(path.join(HOME, '.claude.json')) || {}).oauthAccount || {}).emailAddress;
    if (!email) return null;
    return savedLabels().find((l) => emailOf(l) === email) || email.split('@')[0];
}

// Usage snapshot in one shape, from either source: { accounts: [{ label, state, fetched_at, five_pct, week_pct, ... }] }.
// Every account carries its OWN fetched_at; there is no global age. ccswitch's cache: one file per saved account.
// Team file: it has no per-account age, so an account's age is the file's generated_at (else its mtime).
const FRESH_SECS = 1800;  // data younger than 30 min is fresh (ccswitch's cache TTL is 10 min)
function readSnapshot() {
    if (usageFile()) {
        const f = usageFile(), doc = JSON.parse(fs.readFileSync(f, 'utf8'));
        const fileAge = doc.generated_at ?? Math.floor(fs.statSync(f).mtimeMs / 1000);
        return { accounts: (doc.accounts || []).map((a) => ({ ...a, fetched_at: a.fetched_at ?? fileAge })) };
    }
    return { accounts: savedLabels().map((label) => {
        const c = readJson(path.join(ACCOUNTS, label, '.usage-cache')) || {};
        return { label, provider: 'claude', state: c.fetched_at ? 'ok' : 'no data yet', fetched_at: c.fetched_at ?? null,
            five_pct: c.five_hour_pct ?? null, week_pct: c.seven_day_pct ?? null,
            five_reset_epoch: c.five_hour_reset_epoch ?? null, week_reset_epoch: c.seven_day_reset_epoch ?? null };
    }) };
}

const isFresh = (a, now) => a.state === 'ok' && a.fetched_at != null && now - a.fetched_at < FRESH_SECS;
const loadOf = (a) => Math.max(...[a.five_pct, a.week_pct].filter((v) => v != null));  // a missing window is not full

// A switch target: saved, login not dead, its own data fresh, neither window full, not the active account, Claude only.
function qualifies(a, ctx) {
    if ((a.provider || 'claude') !== 'claude' || (a.five_pct == null && a.week_pct == null)) return false;
    return a.label !== ctx.you && ctx.isSaved(a.label) && !ctx.relogin.has(a.label) && isFresh(a, ctx.now) && loadOf(a) < 100;
}

// HTML-escape a label before it goes into innerHTML or a quoted attribute. Labels come from folder names, or from
// a team file when claudeUsage.usageFile is set, so they are input. The webview gets this same function.
function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function resetText(epoch) {
    const secs = epoch - Date.now() / 1000;
    if (secs < 60) return '⟳ now';
    const d = new Date(epoch * 1000), now = new Date();
    const clock = d.toTimeString().slice(0, 5);
    const dayDiff = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 864e5);
    if (dayDiff === 0) { const m = Math.floor(secs / 60); return `⟳ ${m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`} (${clock})`; }
    if (dayDiff === 1) return `⟳ tomorrow ${clock}`;
    return `⟳ ${DAYS[d.getDay()]} ${clock}`;
}

// Load = max(5h, weekly) (the CtrlA hub's rules); free = load < 50%; best = lowest load among qualifying accounts.
function capacity(u, ctx) {
    const seats = u.accounts.filter((a) => (a.provider || 'claude') === 'claude' && (a.five_pct != null || a.week_pct != null));
    const best = seats.filter((a) => qualifies(a, ctx)).sort((x, y) => loadOf(x) - loadOf(y))[0];
    const fresh = Object.fromEntries(seats.map((a) => [a.label, isFresh(a, ctx.now)]));
    return { you: ctx.you, free: seats.filter((a) => loadOf(a) < 50).length, total: seats.length,
        best: best ? { label: best.label, five: best.five_pct, week: best.week_pct } : null,
        loads: Object.fromEntries(seats.map((a) => [a.label, loadOf(a)])), fresh,
        activeFresh: !!ctx.you && fresh[ctx.you] === true };
}

// Auto-switch target: the best qualifying account, but only when the active account is full (100% on 5h or weekly)
// and its own data is fresh. Returns a label or null.
function autoTarget(cap) {
    if (!cap.you || !cap.activeFresh || !(cap.loads[cap.you] >= 100) || !cap.best) return null;
    return cap.best.label;
}

// Data age as shown on a row: null while fresh by time, 'no data' when there never was any, else '45m old' / '5h old' / '13d old'.
function ageText(fetchedAt, now) {
    if (fetchedAt == null) return 'no data';
    const secs = now - fetchedAt;
    if (secs < FRESH_SECS) return null;
    return secs >= 86400 ? Math.floor(secs / 86400) + 'd old' : secs >= 3600 ? Math.floor(secs / 3600) + 'h old' : Math.floor(secs / 60) + 'm old';
}

function readAccounts() {
    const u = readSnapshot();
    const now = Date.now() / 1000;
    const cap = capacity(u, { you: activeLabel(), isSaved: saved, relogin, now });
    const accounts = u.accounts.map((a) => ({ ...a, email: emailOf(a.label) }));
    cap.loginHealth = loginHealth;
    cap.saved = fs.existsSync(CCSWITCH) ? accounts.map((a) => a.label).filter(saved) : null;  // null = no ccswitch
    cap.relogin = [...relogin];
    return { accounts, cap };
}

// What the panel shows (layout A), decided here so the webview only draws it. Every status is one icon with a fixed
// tooltip, and the Accounts header counts the same icons. An active account with no row (not saved, no data) gets one.
const TIPS = { active: 'Active account', relogin: 'Needs re-login', full: 'A limit is at 100%', switch: 'You can switch here', '': '' };
function panelData(accounts, cap, { now, installed, auto }) {
    const savedSet = new Set(cap.saved || []), dead = new Set(cap.relogin || []);
    const ctx = { you: cap.you, isSaved: (l) => savedSet.has(l), relogin: dead, now };
    const pct = (v) => (v == null ? null : Math.round(v));
    const reset = (epoch) => (epoch ? resetText(epoch) : null);
    const age = (a) => (isFresh(a, now) ? null : ageText(a.fetched_at, now) || a.state);
    const list = cap.you && !accounts.some((a) => a.label === cap.you)
        ? [...accounts, { label: cap.you, provider: 'claude', state: 'no data yet', fetched_at: null, five_pct: null, week_pct: null, email: null }]
        : accounts;
    const rows = list.map((a) => {
        const claude = (a.provider || 'claude') === 'claude', you = a.label === cap.you;
        const icon = you ? 'active' : dead.has(a.label) ? 'relogin' : (a.five_pct >= 100 || a.week_pct >= 100) ? 'full'
            : qualifies(a, ctx) ? 'switch' : '';
        const actions = !claude || !installed ? [] : [
            ...(you && !savedSet.has(a.label) ? ['save'] : []),
            ...(!you && !dead.has(a.label) ? ['switch'] : []),
            ...(dead.has(a.label) ? ['relogin'] : []),
            ...(savedSet.has(a.label) ? ['delete'] : []),
        ];
        return { label: a.label, provider: a.provider || 'claude', icon, tip: TIPS[icon], five: pct(a.five_pct), week: pct(a.week_pct),
            fiveReset: reset(a.five_reset_epoch), weekReset: reset(a.week_reset_epoch), age: age(a), email: a.email || null, actions };
    });
    const mine = list.find((a) => a.label === cap.you);
    return {
        installed, auto, loginHealth: cap.loginHealth || 'unknown',
        active: mine ? { label: mine.label, five: pct(mine.five_pct), week: pct(mine.week_pct),
            fiveReset: reset(mine.five_reset_epoch), weekReset: reset(mine.week_reset_epoch), age: age(mine) } : null,
        next: cap.best ? { label: cap.best.label, five: pct(cap.best.five), week: pct(cap.best.week) } : null,
        counts: { total: rows.length, relogin: rows.filter((r) => r.icon === 'relogin').length, full: rows.filter((r) => r.icon === 'full').length },
        rows,
    };
}

// input = what to type at ccswitch's own [y/N] prompts; we always ask in VS Code first.
const run = (cmd, args, input = '') => new Promise((res) => {
    const c = execFile(cmd, args, { timeout: 90000 }, (err, out, errOut) =>
        res({ ok: !err, out: String(out || ''), err: String(errOut || ''), msg: String(out || errOut || err || '').trim() }));
    c.stdin.on('error', () => {});  // ccswitch may exit without reading (no prompt) - not an error
    c.stdin.end(input);
});

// Running Claude Code sessions rewrite ~/.claude.json constantly; ccswitch refuses a half-written one.
// That is a timing clash, not damage, so try again a few times before giving up.
async function ccswitch(args, input) {
    let r;
    for (let i = 0; i < 5; i++) {
        r = await run(CCSWITCH, args, input);
        if (r.ok || !r.msg.includes('not valid JSON')) return r;
        await new Promise((ok) => setTimeout(ok, 400));
    }
    return r;
}

// Click a seat: saved -> `ccswitch <label>` (instant). Everything goes through ccswitch; a seat that isn't
// saved yet (or whose saved login expired) is enrolled once with Claude's own /login, then SAVE.
async function switchSeat(label, onDone) {
    if (!/^[\w-]+$/.test(label)) return;  // ccswitch's own label charset - never anything else
    if (!fs.existsSync(CCSWITCH)) return installCcswitch();
    if (label === activeLabel()) { vscode.window.showInformationMessage(`You are already on ${label}.`); return; }
    if (relogin.has(label) || !saved(label)) return enroll(label, relogin.has(label), onDone);

    const ok = await vscode.window.showWarningMessage(`Switch Claude Code to ${label}?`,
        { modal: true, detail: 'Instant, using your saved login (ccswitch). New Claude Code sessions use it; restart open Claude Code tabs to move them over.' },
        'Switch');
    if (ok !== 'Switch') return;
    const r = await ccswitch([label]);
    if (!r.ok) { vscode.window.showErrorMessage('ccswitch failed: ' + r.msg); return; }
    onDone();
    vscode.window.showInformationMessage(`Switched Claude Code to ${label}. Restart open Claude Code tabs to use it.`);
}

// One-time enrolment of a seat ccswitch can't switch to yet: log in to it with Claude's /login, then SAVE.
async function enroll(label, expired, onDone) {
    const ok = await vscode.window.showInformationMessage(
        expired ? `The saved login for ${label} has expired (ccswitch: re-login).` : `${label} isn't saved in ccswitch yet.`,
        { modal: true, detail: `Log in to ${label} once: a terminal opens with Claude Code - type /login and sign in as ${label}. `
            + `Then click SAVE on the ${label} card. After that, switching to it is instant.` },
        'Open terminal');
    if (ok !== 'Open terminal') return;
    await checkLogins();  // ccswitch copies your current seat's newest tokens into its saved copy before /login replaces them
    onDone();
    const t = vscode.window.createTerminal(`Claude login: ${label}`);
    t.show();
    t.sendText('claude');
}

// cc-usage-bar (sytang9) provides ccswitch; run its own installer where the user can see and answer it.
async function installCcswitch() {
    const ok = await vscode.window.showWarningMessage('Install ccswitch (cc-usage-bar)?',
        { modal: true, detail: 'Seat switching needs ccswitch from github.com/sytang9/cc-usage-bar. Its installer copies three scripts into ~/.claude, '
            + 'links ccswitch into ~/.local/bin and sets the Claude Code status line (your settings.json is backed up first). It runs in a terminal you can watch.' },
        'Install');
    if (ok !== 'Install') return;
    const dir = '$HOME/.local/share/cc-usage-bar';
    const t = vscode.window.createTerminal('Install ccswitch');
    t.show();
    t.sendText(`(git -C "${dir}" pull -q 2>/dev/null || git clone -q https://github.com/sytang9/cc-usage-bar.git "${dir}") && bash "${dir}/install.sh"`);
}

// Keep-alive + health check, all decided by ccswitch itself: `ccswitch usage --json` refreshes every saved
// account's tokens and reports each account's login (`ok` | `re-login` | `unknown`) as data, not as text to parse.
const relogin = new Set();
let loginHealth = 'unknown';  // 'known' | 'unknown': whether the last run could judge dead logins at all

// The parsed `usage --json` document, or null unless it is schema 1 with an accounts array.
function parseUsageJson(text) {
    try {
        const d = JSON.parse(text);
        return d && d.schema === 1 && Array.isArray(d.accounts) ? d : null;
    } catch { return null; }
}

// New re-login set: no document -> empty; re-login adds, ok removes, unknown keeps the previous verdict; saved only.
function mergeLogins(prev, doc, isSaved) {
    if (!doc) return new Set();
    const next = new Set(prev);
    for (const a of doc.accounts) {
        if (a.login === 're-login') next.add(a.label);
        else if (a.login === 'ok') next.delete(a.label);
    }
    return new Set([...next].filter(isSaved));
}

async function checkLogins() {
    if (!fs.existsSync(CCSWITCH)) return;
    const r = await run(CCSWITCH, ['usage', '--json']);
    const doc = r.ok ? parseUsageJson(r.out) : null;  // old ccswitch (no --json) or stray output: trust nothing
    const next = mergeLogins(relogin, doc, saved);
    relogin.clear();  // same Set object, so saveSeat's relogin.delete keeps working
    for (const l of next) relogin.add(l);
    loginHealth = doc && doc.login_health === 'known' ? 'known' : 'unknown';
}

// Save the CURRENT login under its seat name (ccswitch save always snapshots whichever login is active).
async function saveSeat(label, onDone) {
    if (label !== activeLabel()) { vscode.window.showWarningMessage(`You can only save the seat you are on (${activeLabel()}).`); return; }
    if (saved(label)) {
        const ok = await vscode.window.showWarningMessage(`Overwrite the saved login for ${label}?`,
            { modal: true, detail: 'Replaces it with your current login. Only needed if the saved one stopped working.' }, 'Overwrite');
        if (ok !== 'Overwrite') return;
    }
    const r = await ccswitch(['save', label], 'y\n');
    if (r.ok) { relogin.delete(label); vscode.window.showInformationMessage(`Saved ${label} - switching to it is now instant.`); }
    else vscode.window.showErrorMessage('ccswitch save failed: ' + r.msg);
    onDone();
}

async function deleteSeat(label, onDone) {
    const ok = await vscode.window.showWarningMessage(`Delete the saved login for ${label}?`,
        { modal: true, detail: 'Your current Claude Code login is not affected. To switch to this seat again you will need to log in to it once and SAVE.' }, 'Delete');
    if (ok !== 'Delete') return;
    const r = await ccswitch(['delete', label], 'y\n');
    if (r.ok && !saved(label)) vscode.window.showInformationMessage(`Deleted the saved login for ${label}.`);
    else vscode.window.showErrorMessage('ccswitch delete failed: ' + r.msg);
    onDone();
}

// Pre-release copies were published as meng-local.claude-usage (+ a Chrome helper); remove them so there is one sidebar.
function removeOldHelper() {
    for (const id of ['meng-local.claude-usage', 'meng-local.claude-usage-chrome']) {
        if (vscode.extensions.getExtension(id)) vscode.commands.executeCommand('workbench.extensions.uninstallExtension', id).then(undefined, () => {});
    }
}

function activate(context) {
    removeOldHelper();
    let view = null;
    let accounts = [], cap = null;
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    status.command = 'workbench.view.extension.claudeUsage';
    status.text = '$(pulse) Claude …';
    status.show();

    const push = () => view && cap && view.webview.postMessage(panelData(accounts, cap, { now: Date.now() / 1000, installed: fs.existsSync(CCSWITCH), auto: !!cap.auto }));
    const autoOn = () => vscode.workspace.getConfiguration('claudeUsage').get('autoSwitch');
    let lastAuto = 0;  // cooldown so a lagging snapshot can't bounce us between seats
    const autoSwitch = async () => {
        if (!autoOn() || !fs.existsSync(CCSWITCH) || Date.now() - lastAuto < 10 * 60 * 1000) return;
        const from = cap.you, to = autoTarget(cap);
        if (!to) return;
        lastAuto = Date.now();
        const r = await ccswitch([to]);
        if (!r.ok) { vscode.window.showErrorMessage(`Auto-switch to ${to} failed: ` + r.msg); return; }
        poll();
        const next = await vscode.window.showWarningMessage(`Auto-switched Claude Code: ${from} is full, now on ${to} (most headroom). Restart open Claude Code tabs to use it.`, 'Turn auto-switch off');
        if (next === 'Turn auto-switch off') vscode.workspace.getConfiguration('claudeUsage').update('autoSwitch', false, vscode.ConfigurationTarget.Global);
    };
    const toggleAuto = () => vscode.workspace.getConfiguration('claudeUsage').update('autoSwitch', !autoOn(), vscode.ConfigurationTarget.Global);

    const poll = () => {
        try { ({ accounts, cap } = readAccounts()); cap.auto = autoOn(); } catch (err) { status.text = '$(warning) Claude usage unreadable'; status.tooltip = String(err); return; }
        const r = (v) => (v == null ? '–' : Math.round(v) + '%');
        status.text = (cap.you && !cap.activeFresh ? '$(warning) ' : '$(pulse) ') + (cap.auto ? '$(sync) ' : '') + (cap.you ? `current ${cap.you} · ` : '') + `${cap.free}/${cap.total} free`
            + (cap.best ? ` · most headroom ${cap.best.label} (${r(cap.best.five)}/${r(cap.best.week)})` : '');
        status.tooltip = (cap.you && !cap.activeFresh ? `Data for ${cap.you} is over 30 min old\n` : '') + `Auto-switch: ${cap.auto ? 'ON' : 'off'}\n` + 'Accounts (5h / weekly)\n'
            + accounts.map((a) => `${a.email || a.label}: session ${r(a.five_pct)}, weekly ${r(a.week_pct)}`).join('\n');
        push();
        autoSwitch();
    };

    context.subscriptions.push(status,
        vscode.commands.registerCommand('claudeUsage.toggleAutoSwitch', toggleAuto),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('claudeUsage.usageFile')) { fs.unwatchFile(watched); watched = usageFile() || ACCOUNTS; fs.watchFile(watched, { interval: 5000 }, poll); }
            if (e.affectsConfiguration('claudeUsage')) poll();
        }),
        vscode.commands.registerCommand('claudeUsage.refresh', poll),
        vscode.window.registerWebviewViewProvider('claudeUsage.view', {
            resolveWebviewView(v) {
                view = v;
                v.webview.options = { enableScripts: true };
                v.webview.html = webviewHtml();
                v.webview.onDidReceiveMessage((m) => {
                    if (m === 'ready') push();
                    else if (m.seat) switchSeat(m.seat, poll);
                    else if (m.save && /^[\w-]+$/.test(m.save)) saveSeat(m.save, poll);
                    else if (m.del && /^[\w-]+$/.test(m.del)) deleteSeat(m.del, poll);
                    else if (m.toggleAuto) toggleAuto();
                    else if (m.installCc) installCcswitch();
                });
                v.onDidDispose(() => { view = null; });
            },
        }, { webviewOptions: { retainContextWhenHidden: true } }));

    poll();
    const timer = setInterval(poll, POLL_MS);
    const health = () => checkLogins().then(poll, () => {});
    const firstCheck = setTimeout(health, 30 * 1000);
    // ccswitch's own cache: refresh at its 10-min TTL; with a team file, hourly is enough to keep tokens alive
    const healthTimer = setInterval(health, (usageFile() ? 60 : 10) * 60 * 1000);
    context.subscriptions.push({ dispose: () => { clearTimeout(firstCheck); clearInterval(healthTimer); } });
    let watched = usageFile() || ACCOUNTS;
    fs.watchFile(watched, { interval: 5000 }, poll);  // refresh as soon as new numbers land
    fs.watchFile(path.join(HOME, '.claude.json'), { interval: 5000 }, poll);  // "you" follows ccswitch run in a terminal
    context.subscriptions.push({ dispose: () => { clearInterval(timer); fs.unwatchFile(watched); fs.unwatchFile(path.join(HOME, '.claude.json')); } });
}

// One native panel: panel.css + esc + panel.js inlined. No network, no external files, no frames.
function webviewHtml() {
    const read = (f) => fs.readFileSync(path.join(__dirname, 'webview', f), 'utf8');
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
${read('panel.css')}</style></head><body><main id="root"></main><script>
${esc.toString()}
${read('panel.js')}</script></body></html>`;
}

module.exports = { activate };
