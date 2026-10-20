// VS Code sidebar + status bar for ccswitch (cc-usage-bar): every saved account's 5h/weekly usage, which one has
// the most headroom, one-click switching, auto-switch. Usage comes from ccswitch's own per-account cache
// (~/.claude/accounts/<label>/.usage-cache, refreshed by `ccswitch usage`), or from a team snapshot file if
// `claudeUsage.usageFile` is set. UI: ui/popup.* copied unchanged from github.com/jens-duttke/usage-monitor-for-claude.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const usageFile = () => vscode.workspace.getConfiguration('claudeUsage').get('usageFile') || '';  // '' = ccswitch's cache
const POLL_MS = 60 * 1000;  // keeps "Updated X ago", reset times and the stale warning current
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

// Usage snapshot in one shape, from either source: { generated_at, accounts: [{ label, five_pct, week_pct, ... }] }.
// ccswitch's cache: one file per saved account; "updated" is the OLDEST fetch, so staleness is never understated.
function readSnapshot() {
    if (usageFile()) return JSON.parse(fs.readFileSync(usageFile(), 'utf8'));
    const accounts = savedLabels().map((label) => {
        const c = readJson(path.join(ACCOUNTS, label, '.usage-cache')) || {};
        return { label, provider: 'claude', state: c.fetched_at ? 'ok' : 'no data yet', fetched_at: c.fetched_at,
            five_pct: c.five_hour_pct ?? null, week_pct: c.seven_day_pct ?? null,
            five_reset_epoch: c.five_hour_reset_epoch ?? null, week_reset_epoch: c.seven_day_reset_epoch ?? null };
    });
    const times = accounts.map((a) => a.fetched_at).filter(Boolean);
    return { generated_at: times.length ? Math.min(...times) : null, accounts };
}

// HTML-escape a label before it goes into innerHTML or a quoted attribute. Labels come from folder names, or from
// a team file when claudeUsage.usageFile is set, so they are input. The webview gets this same function.
function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function resetText(epoch) {
    const secs = epoch - Date.now() / 1000;
    if (secs < 60) return '↻ now';
    const d = new Date(epoch * 1000), now = new Date();
    const clock = d.toTimeString().slice(0, 5);
    const dayDiff = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 864e5);
    if (dayDiff === 0) { const m = Math.floor(secs / 60); return `↻ ${m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`} (${clock})`; }
    if (dayDiff === 1) return `↻ tomorrow ${clock}`;
    return `↻ ${DAYS[d.getDay()]} ${clock}`;
}

function dividers(epoch, period) {
    if (period < 86400) return [0.2, 0.4, 0.6, 0.8];
    const start = epoch * 1000 - period * 1000, out = [];
    const day = new Date(start); day.setHours(24, 0, 0, 0);  // next local midnight
    for (; day.getTime() < epoch * 1000; day.setDate(day.getDate() + 1)) out.push((day.getTime() - start) / (period * 1000));
    return out;
}

function bar(key, label, pct, epoch, period) {
    if (pct == null) return null;
    const elapsed = epoch ? Math.max(0, Math.min(1, 1 - (epoch - Date.now() / 1000) / period)) : null;
    return { key, label, pct, pct_text: `${Math.round(pct)}%`, fill_pct: Math.max(0, Math.min(1, pct / 100)),
        warn: pct >= 100 || (elapsed !== null && pct / 100 > elapsed),  // ahead of pace = red, like the app
        reset_text: epoch ? resetText(epoch) : '', dividers: epoch ? dividers(epoch, period) : [], marker_rel: elapsed };
}

// Load = max(5h, weekly) (the CtrlA hub's rules);
// free = load < 50%; most headroom = lowest load among readable Claude seats (codex never counts).
function capacity(u) {
    const seats = u.accounts.filter((a) => (a.provider || 'claude') === 'claude' && (a.five_pct != null || a.week_pct != null));
    const load = (a) => Math.max(...[a.five_pct, a.week_pct].filter((v) => v != null));
    const best = seats.filter((a) => a.state === 'ok').sort((x, y) => load(x) - load(y))[0];
    return { free: seats.filter((a) => load(a) < 50).length, total: seats.length,
        best: best && { label: best.label, five: best.five_pct, week: best.week_pct },
        loads: Object.fromEntries(seats.map((a) => [a.label, load(a)])),
        stale: !u.generated_at || Date.now() / 1000 - u.generated_at > 900, updated: u.generated_at };
}

// Auto-switch target: the most-headroom seat, but only when the current seat is full (100% on 5h or weekly),
// usage data is fresh, and the target is saved and not full itself. Returns a label or null.
function autoTarget(cap, isSaved) {
    if (cap.stale || !cap.you || !cap.best || cap.best.label === cap.you) return null;
    if (!(cap.loads[cap.you] >= 100)) return null;
    if (!(cap.loads[cap.best.label] < 100) || !isSaved(cap.best.label)) return null;
    return cap.best.label;
}

function readAccounts() {
    const u = readSnapshot();
    const cap = capacity(u);
    const accounts = u.accounts.map((a) => ({ name: a.label, data: {
        profile: emailOf(a.label) ? { email: emailOf(a.label), plan: '' } : null, extra: null, installations: [],
        usage: [bar('five_hour', '5H', a.five_pct, a.five_reset_epoch, 18000),
                bar('seven_day', 'Week', a.week_pct, a.week_reset_epoch, 604800)].filter(Boolean),
        status: a.state === 'ok'
            ? { last_success_time: u.generated_at, next_poll_time: null, refreshing: false, error: null }
            : { text: a.state, is_error: a.state !== 'no data yet' },
    } }));
    cap.you = activeLabel();
    cap.saved = fs.existsSync(CCSWITCH) ? accounts.map((a) => a.name).filter(saved) : null;  // null = no ccswitch
    cap.relogin = [...relogin];
    return { accounts, cap };
}

// Compact sidebar layout on top of the unchanged popup.css: title = seat (click to switch), one
// two-line row per bar (label · reset · % / bar), no section headings, account block or footer.
const COMPACT_CSS = `
.window-controls, h2, #accountSection, footer { display: none !important; }
body { gap: 6px; padding: 7px 10px 9px; }
header > span { font-size: 13px; }
#title.link { cursor: pointer; } #title.link:hover { text-decoration: underline; }
header { flex-wrap: wrap; row-gap: 4px; } #title { white-space: nowrap; flex-shrink: 0; }
#badges { display: flex; flex-wrap: wrap; gap: 4px; margin-left: auto; justify-content: flex-end; }
.badge { font-size: 10px; font-weight: 700; letter-spacing: .04em; padding: 2px 7px; border-radius: 9px; color: #fff; }
.badge.cur { background: #D97757; } .badge.best { background: #238636; }
.act { font-size: 10px; color: #888; cursor: pointer; padding: 2px 2px; align-self: center; } .act:hover { color: #fff; text-decoration: underline; }
.act.save { color: #d29922; font-weight: 700; }
.act.del { display: inline-flex; padding: 1px; } .act.del svg { width: 13px; height: 13px; } .act.del:hover { color: #f85149; }
.dim { font-size: 10px; color: #666; align-self: center; }
.act.relog { color: #fff; background: #d75f5f; font-weight: 700; padding: 1px 6px; border-radius: 9px; } .act.relog:hover { text-decoration: none; filter: brightness(1.15); }
section.visible ~ section.visible { border: 0; padding-top: 0; }
#usageBars { gap: 7px; }
.usage-entry { display: grid; grid-template-columns: auto 1fr auto; column-gap: 8px; row-gap: 3px; align-items: baseline; }
.bar-header { display: contents; }
.bar-header > span:first-child { grid-column: 1; grid-row: 1; font-weight: 600; }
.bar-pct { grid-column: 3; grid-row: 1; }
.reset-text { grid-column: 2; grid-row: 1; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar-container { grid-column: 1 / -1; grid-row: 2; height: 6px; }
`;

function popupDoc() {
    const read = (f) => fs.readFileSync(path.join(__dirname, 'ui', f), 'utf8');
    return read('popup.html')
        .replace('<link rel="stylesheet" href="popup.css">', () => `<style>${read('popup.css')}</style>`)
        .replace('</head>', () => `<style>${COMPACT_CSS}</style></head>`)
        .replace('<script src="popup.js"></script>', () => `<script>${read('popup.js')}</script>`);
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

// Keep-alive + health check, all decided by ccswitch itself: `ccswitch usage --no-switch` refreshes every
// saved seat's tokens and prints `re-login` for a seat whose saved refresh token is dead.
const relogin = new Set();
async function checkLogins() {
    if (!fs.existsSync(CCSWITCH)) return;
    const r = await run(CCSWITCH, ['usage', '--no-switch']);
    // ccswitch says when its re-login verdict can't be trusted (node missing, refresh paused) - then mark nothing
    if (!r.ok || /regardless of account health|until node is installed/.test(r.err)) return;
    const next = new Set();
    for (const line of r.out.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
        const m = line.match(/^[* ]\s*([\w-]+)\s+(.*)$/);
        if (m && saved(m[1]) && /\bre-login\b/.test(m[2])) next.add(m[1]);
    }
    relogin.clear();
    for (const l of next) relogin.add(l);
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

    const push = () => view && view.webview.postMessage({ accounts, cap });
    const autoOn = () => vscode.workspace.getConfiguration('claudeUsage').get('autoSwitch');
    let lastAuto = 0;  // cooldown so a lagging snapshot can't bounce us between seats
    const autoSwitch = async () => {
        if (!autoOn() || !fs.existsSync(CCSWITCH) || Date.now() - lastAuto < 10 * 60 * 1000) return;
        const from = cap.you, to = autoTarget(cap, (l) => saved(l) && !relogin.has(l));
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
        const pct = (a, key) => (a.data.usage.find((u) => u.key === key) || {}).pct_text || '–';
        const r = (v) => (v == null ? '–' : Math.round(v) + '%');
        status.text = (cap.stale ? '$(warning) ' : '$(pulse) ') + (cap.auto ? '$(sync) ' : '') + (cap.you ? `current ${cap.you} · ` : '') + `${cap.free}/${cap.total} free`
            + (cap.best ? ` · most headroom ${cap.best.label} (${r(cap.best.five)}/${r(cap.best.week)})` : '');
        status.tooltip = (cap.stale ? 'Usage data is over 15 min old\n' : '') + `Auto-switch: ${cap.auto ? 'ON' : 'off'}\n` + 'Accounts (5h / weekly)\n'
            + accounts.map((a) => `${a.data.profile ? a.data.profile.email : a.label}: session ${pct(a, 'five_hour')}, weekly ${pct(a, 'seven_day')}`).join('\n');
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
                v.webview.html = webviewHtml(popupDoc());
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

// Same driver as ui/index.html, but the data arrives by postMessage instead of fetch.
function webviewHtml(doc) {
    // No network, no external files: inline script/style only (the srcdoc frames inherit this policy).
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; frame-src 'self'">
<style>
body { margin: 0; padding: 8px 0; } #cap { color: #ccc; background: #1e1e1e; border-radius: 6px; padding: 7px 10px; margin-bottom: 6px; font: 12px system-ui, sans-serif; line-height: 1.5; }
#cap .k { color: #888; font-size: 11px; font-weight: 600; letter-spacing: .05em; display: block; } #cap b { color: #fff; } #cap .hop { color: #57bdb2; } #cap .stale { color: #e05050; } #cap .k2 { color: #888; }
#cap .head { display: flex; align-items: center; justify-content: space-between; gap: 6px; } #cap .head .k { display: inline; }
#cap .auto { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: #aaa; white-space: nowrap; }
#cap .sw { position: relative; width: 26px; height: 14px; border-radius: 7px; background: #555; cursor: pointer; transition: background .15s; flex-shrink: 0; }
#cap .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px; border-radius: 50%; background: #fff; transition: left .15s; }
#cap .sw.on { background: #D97757; } #cap .sw.on::after { left: 14px; } #cap .sw:focus-visible { outline: 2px solid #D97757; outline-offset: 2px; }
#cap .info { width: 14px; height: 14px; border-radius: 50%; border: 1px solid #777; color: #aaa; font: italic 700 10px/12px Georgia, serif; text-align: center; cursor: pointer; flex-shrink: 0; }
#cap .info:hover, #cap .info.open { border-color: #D97757; color: #D97757; }
#cap .install { cursor: pointer; font-size: 10px; font-weight: 700; color: #fff; background: #D97757; padding: 2px 8px; border-radius: 9px; white-space: nowrap; } #cap .install:hover { filter: brightness(1.1); }
#cap .explain { margin-top: 5px; padding: 6px 8px; border-left: 2px solid #D97757; background: #262626; color: #bbb; font-size: 11px; line-height: 1.45; }
iframe { display: block; box-sizing: content-box; border: 2px solid transparent; width: calc(100% - 4px); height: 90px; margin-bottom: 4px; border-radius: 8px; }
iframe.best { border-color: #238636; } iframe.cur { border-color: #D97757; }
#cap .best { color: #3fb950; }
</style></head><body><div id="cap"></div><div id="grid"></div><script>
const DOC = ${JSON.stringify(doc).replace(/</g, '\\u003c')};
${esc.toString()}
const COLORS = { bg: '#1e1e1e', fg: '#cccccc', fg_dim: '#888888', fg_heading: '#ffffff', fg_link: '#D97757',
    bar_bg: '#333333', bar_fg: '#D97757', bar_fg_warn: '#F0443A', bar_divider: '#000c', bar_marker: '#fffc' };
const T = { account: 'Account', email: 'Email', plan: 'Plan', usage: 'Usage', extra_usage: 'Extra usage',
    claude_code: 'Claude Code', changelog: 'Changelog', pin_popup: 'Pin', unpin_popup: 'Unpin',
    status_updated_s: 'Updated {s}s ago', status_updated: 'Updated {duration} ago',
    status_next_update: 'Next update in {duration}', status_refreshing: 'Refreshing...',
    duration_hm: '{h}h {m}m', duration_m: '{m}m', duration_s: '{s}s' };
const frames = {};
let lastCap = {};
const TRASH = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6 1h4a1 1 0 0 1 1 1v1h3v1.5H2V3h3V2a1 1 0 0 1 1-1zm0 2h4V2.5H6zM3.5 6h9l-.7 8.1A1 1 0 0 1 10.8 15H5.2a1 1 0 0 1-1-.9zm2.6 1.5.3 6h1.2l-.2-6zm2.5 0-.2 6h1.2l.3-6z"/></svg>';
// CURRENT (orange) = the seat you are logged in as; MOST HEADROOM (green) = the freest seat.
// Bar colours = ccswitch's (cc-usage-bar): green <= 59%, amber 60-85%, red > 85% (xterm 108/179/167).
const barColor = (pct) => (pct > 85 ? '#d75f5f' : pct > 59 ? '#d7af5f' : '#87af87');
function paint(name, data) {
    const w = frames[name];
    if (!w) return;
    for (const u of data.usage) {
        const fill = w.document.querySelector('.usage-entry[data-key="' + u.key + '"] .bar-fill');
        if (fill) fill.style.background = barColor(u.pct);
    }
}
function tag(name) {
    const w = frames[name], iframe = document.querySelector('iframe[data-name="' + CSS.escape(name) + '"]');
    if (!w || !iframe) return;
    const cur = lastCap.you === name, best = !!lastCap.best && lastCap.best.label === name;
    iframe.classList.toggle('cur', cur);
    iframe.classList.toggle('best', best);
    let b = w.document.getElementById('badges');
    if (!b) { b = w.document.createElement('span'); b.id = 'badges'; w.document.querySelector('header').append(b); }
    b.innerHTML = (cur ? '<span class="badge cur">CURRENT</span>' : '') + (best ? '<span class="badge best">MOST HEADROOM</span>' : '');
    // ccswitch actions: only for seats with an email (Claude seats) and when ccswitch is installed
    if (lastCap.saved && iframe.dataset.claude) {
        const isSaved = lastCap.saved.includes(name);
        if (cur && !isSaved) b.insertAdjacentHTML('afterbegin', '<span class="act save" data-a="save" title="Save your current login as ' + esc(name) + ' so switching back is instant (ccswitch save)">SAVE</span>');
        const dead = (lastCap.relogin || []).includes(name);
        if (dead) b.insertAdjacentHTML('beforeend', '<span class="act relog" data-a="login" title="The saved login expired (ccswitch: re-login). Click for how to refresh it">re-login</span>');
        else if (isSaved) b.insertAdjacentHTML('beforeend', '<span class="act del" data-a="del" aria-label="Delete saved login" title="Delete the saved login for ' + esc(name) + ' (ccswitch delete)">' + TRASH + '</span>');
        else if (!cur) b.insertAdjacentHTML('beforeend', '<span class="dim" title="Not saved in ccswitch yet - click the seat name for the one-time steps">not saved</span>');
        for (const el of b.querySelectorAll('[data-a]')) el.onclick = () => vsc.postMessage({ [el.dataset.a === 'login' ? 'seat' : el.dataset.a]: name });
    }
}
function addFrame(name, data) {
    const iframe = document.createElement('iframe');
    iframe.addEventListener('load', () => {
        const w = iframe.contentWindow;
        w.pywebview = { api: { close() {}, open_url() {}, end_drag() {},
            set_pinned: (p) => Promise.resolve(p), begin_drag: () => Promise.resolve(false), drag: () => Promise.resolve(false),
            report_height(h) { iframe.style.height = h + 'px'; } } };
        w.init({ colors: COLORS, t: { ...T, title: name }, app_version: '', compact_hide: [], data });
        const t = w.document.getElementById('title');
        if (iframe.dataset.claude) {  // the seat name is the switch button; the email lives in its tooltip
            t.classList.add('link');
            t.title = (data.profile ? data.profile.email + ' - ' : '') + 'click to switch Claude Code to this seat';
            t.onclick = () => vsc.postMessage({ seat: name });
        }
        frames[name] = w;
        tag(name);
        paint(name, data);
    }, { once: true });
    iframe.dataset.name = name;
    if (data.usage.some((u) => u.key === 'five_hour') || data.profile) iframe.dataset.claude = '1';  // codex rows aren't seats
    iframe.srcdoc = DOC;
    document.getElementById('grid').append(iframe);
}
const ago = (t) => { const m = Math.round((Date.now() / 1000 - t) / 60); return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago'; };
let infoOpen = false, last = null;
const EXPLAIN = 'When your seat hits <b>100%</b> (5h or weekly), switch to the seat with the <b>most headroom</b> '
    + 'automatically. Saved seats only, fresh usage data only, never to a full seat, at most once per 10 min. '
    + 'New Claude Code sessions use the new seat; restart open Claude Code tabs to move them over. Only your own login changes.';
const render = () => last && onData(last);
window.addEventListener('message', ({ data }) => { last = data; onData(data); });
function onData({ accounts, cap }) {
    lastCap = cap;
    const r = (v) => (v == null ? '–' : Math.round(v) + '%');
    document.getElementById('cap').innerHTML = '<div class="head"><span class="k">WHERE&#39;S FREE</span>'
        + (!cap.saved ? '<span class="install" id="installCc" title="Seat switching needs ccswitch (cc-usage-bar)">INSTALL CCSWITCH</span>' : '')
        + (cap.saved ? '<span class="auto">Auto-switch'
            + '<span class="sw' + (cap.auto ? ' on' : '') + '" id="auto" role="switch" tabindex="0" aria-checked="' + !!cap.auto + '" title="Auto-switch is ' + (cap.auto ? 'on' : 'off') + '"></span>'
            + '<span class="info' + (infoOpen ? ' open' : '') + '" id="info" role="button" tabindex="0" aria-label="What does auto-switch do?" title="What does auto-switch do?">i</span></span>' : '')
        + '</div>'
        + (cap.saved && infoOpen ? '<div class="explain">' + EXPLAIN + '</div>' : '')
        + '<b>' + cap.free + '/' + cap.total + '</b> seats free'
        + (cap.best ? ' · most headroom <b class="best">' + esc(cap.best.label) + '</b> 5H ' + r(cap.best.five) + ' · WK ' + r(cap.best.week) : '')
        + (cap.updated ? ' · <span class="' + (cap.stale ? 'stale' : 'k2') + '">updated ' + ago(cap.updated) + '</span>' : '');
    const auto = document.getElementById('auto'), info = document.getElementById('info');
    const key = (fn) => (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } };
    if (auto) { const flip = () => vsc.postMessage({ toggleAuto: 1 }); auto.onclick = flip; auto.onkeydown = key(flip); }
    const inst = document.getElementById('installCc');
    if (inst) inst.onclick = () => vsc.postMessage({ installCc: 1 });
    if (info) { const show = () => { infoOpen = !infoOpen; render(); }; info.onclick = show; info.onkeydown = key(show); }
    for (const { name, data } of accounts) {
        if (frames[name]) { frames[name].updateData(data); tag(name); paint(name, data); }
        else if (!(name in frames)) { frames[name] = null; addFrame(name, data); }
    }
}
const vsc = acquireVsCodeApi();
vsc.postMessage('ready');
</script></body></html>`;
}

module.exports = { activate };
