// VS Code sidebar + status bar for ccswitch (cc-usage-bar): every saved account's 5h/weekly usage, which one has
// the most headroom, one-click switching, auto-switch. Usage comes from ccswitch's own per-account cache
// (~/.claude/accounts/<label>/.usage-cache, refreshed by `ccswitch usage`), or from a team snapshot file if
// `claudeUsage.usageFile` is set.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { buildStats } = require('./stats');
const { downsample, CW } = require('./webview/panel');  // the History chart's own downsample and width

const usageFile = () => vscode.workspace.getConfiguration('claudeUsage').get('usageFile') || '';  // '' = ccswitch's cache
const POLL_MS = 60 * 1000;  // keeps reset times and the per-account data age current
const HOME = require('os').homedir();
const CCSWITCH = path.join(HOME, '.claude', 'ccswitch');
const ACCOUNTS = path.join(HOME, '.claude', 'accounts');
// ccswitch's label rule: letters, digits, '_' and '-', never a leading '-' (ccswitch would read it as an option).
const isLabel = (l) => typeof l === 'string' && /^[A-Za-z0-9_][\w-]*$/.test(l);
const saved = (label) => fs.existsSync(path.join(ACCOUNTS, label, 'credentials.json'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const emailOf = (label) => (readJson(path.join(ACCOUNTS, label, 'oauthAccount.json')) || {}).emailAddress || null;
const savedLabels = () => { try { return fs.readdirSync(ACCOUNTS).filter((l) => isLabel(l) && saved(l)).sort(); } catch { return []; } };
const isClaude = (a) => (a.provider || 'claude') === 'claude';
const CODEX = process.env.CODEX_HOME || path.join(HOME, '.codex');  // ccswitch's ${CODEX_HOME:-~/.codex}

// The saved account the live login belongs to (matched by email, like ccswitch's '*'); else the email's local part.
function activeLabel() {
    const email = ((readJson(path.join(HOME, '.claude.json')) || {}).oauthAccount || {}).emailAddress;
    if (!email) return null;
    return savedLabels().find((l) => emailOf(l) === email) || email.split('@')[0];
}

// Usage snapshot in one shape, from either source: { accounts: [{ label, state, fetched_at, five_pct, week_pct, ... }] }.
// Every account carries its OWN fetched_at; there is no global age. ccswitch's cache: one file per saved account.
// Team file: it has no per-account age, so an account's age is the file's generated_at (else its mtime).
const FRESH_SECS = 1800;  // display: data younger than 30 min is shown as current (ccswitch's cache TTL is 10 min)
const SWITCH_FRESH_SECS = 900;  // switching (a target, or the active account's 'full'): data younger than 15 min
const CLOCK_SLACK_SECS = 60;  // a fetched_at further in the future than this is not fresh (clock skew, a bad file)
function readSnapshot() {
    if (usageFile()) {
        const f = usageFile(), doc = JSON.parse(fs.readFileSync(f, 'utf8'));
        const fileAge = doc.generated_at ?? Math.floor(fs.statSync(f).mtimeMs / 1000);
        // Team labels are input: a row that breaks ccswitch's label rule never reaches a path.join or ccswitch.
        const rows = (doc.accounts || []).filter((a) => a && isLabel(a.label));
        return { accounts: rows.map((a) => ({ ...a, fetched_at: a.fetched_at ?? fileAge })) };
    }
    return { accounts: [...savedLabels().map((label) => {
        const c = readJson(path.join(ACCOUNTS, label, '.usage-cache')) || {};
        return { label, provider: 'claude', state: c.fetched_at ? 'ok' : 'no data yet', fetched_at: c.fetched_at ?? null,
            five_pct: c.five_hour_pct ?? null, week_pct: c.seven_day_pct ?? null,
            five_reset_epoch: c.five_hour_reset_epoch ?? null, week_reset_epoch: c.seven_day_reset_epoch ?? null };
    }), ...codexRows()] };
}

// The read-only Codex row: ccswitch's Codex cache, which `ccswitch usage --json` (the 10-min health check) refreshes.
// Shown when that cache or a Codex login exists; auth.json is only checked for existence, never read.
function codexRows() {
    const f = path.join(CODEX, '.usage-cache');
    if (!fs.existsSync(f) && !fs.existsSync(path.join(CODEX, 'auth.json'))) return [];
    const c = readJson(f) || {};
    return [{ label: 'codex', provider: 'codex', state: c.fetched_at ? 'ok' : 'no data yet', fetched_at: c.fetched_at || null,  // 0 = never fetched
        five_pct: c.five_hour_pct ?? null, week_pct: c.seven_day_pct ?? null,
        five_reset_epoch: c.five_hour_reset_epoch ?? null, week_reset_epoch: c.seven_day_reset_epoch ?? null }];
}

// History: ccswitch appends one line per live fetch to <label>/.usage-history.jsonl ({t, p5, p7, r5, r7}). The panel
// reads the last 30 days (the longest History range; ccswitch keeps 30 days); a bad line is skipped. Only the file's last HISTORY_READ_BYTES are
// read, and the parsed points are reused while the file's size and mtime are unchanged.
const HISTORY_SECS = 30 * 86400;
// The History range selector: how far back the charts reach. 'auto' keeps the original look (5h chart 24h, weekly chart 7d).
const HIST_RANGES = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };
// minimize: a fixed tail, not a scan back to the 30-day cutoff. A line is about 70 bytes and ccswitch adds one per
// live fetch (about every 10 min), so 512 KB holds about 52 days (30 days is about 300 KB). If fetches get much more frequent, scan back instead.
const HISTORY_READ_BYTES = 512 * 1024;
const fin = Number.isFinite;
// A usable line: a finite t, and each percent and reset a finite number or null (ccswitch writes null for no data).
const isPoint = (o) => !!o && fin(o.t) && ['p5', 'p7', 'r5', 'r7'].every((k) => o[k] === null || fin(o[k]));
const historyCache = new Map();  // label -> { size, mtimeMs, points }
function readTail(f, size) {
    const n = Math.min(size, HISTORY_READ_BYTES), buf = Buffer.alloc(n), fd = fs.openSync(f, 'r');
    try { fs.readSync(fd, buf, 0, n, size - n); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8');
    return n < size ? text.slice(text.indexOf('\n') + 1) : text;  // the first line of a tail is cut: drop it
}
function readHistory(label, now) {
    const f = path.join(ACCOUNTS, label, '.usage-history.jsonl');
    let hit = historyCache.get(label);
    try {
        const st = fs.statSync(f);
        if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
            const points = [];
            for (const line of readTail(f, st.size).split('\n')) {
                let o;
                try { o = JSON.parse(line); } catch { continue; }
                if (isPoint(o)) points.push(o);
            }
            hit = { size: st.size, mtimeMs: st.mtimeMs, points: points.sort((a, b) => a.t - b.t) };
            historyCache.set(label, hit);
        }
    } catch { historyCache.delete(label); return []; }
    return hit.points.filter((o) => o.t >= now - HISTORY_SECS && o.t <= now + CLOCK_SLACK_SECS);
}

// History costs a file read per account, so push() asks for it only while the sidebar is visible: every saved account
// while the History tab is shown, else the active one (its pace line, computed in the host; no series are posted then);
// want(label) says which. Never with a team
// file: those rows are not this machine's ccswitch accounts, so a matching local label must not lend its history.
function withHistory(accounts, want, now) {
    if (usageFile()) return accounts;
    return accounts.map((a) => (isClaude(a) && want(a.label) && saved(a.label) ? { ...a, history: readHistory(a.label, now) } : a));
}

// "At this pace": the rise of one limit since its window started (the points that share the latest reset time),
// extended in a straight line. Needs 20 min of points, a rise, and a last point under 30 min old. Returns { full: epoch }
// when the limit would reach 100% before it resets, { lasts: true } when it would not, null when there is nothing to judge.
// Reset times within a minute are one window (the API's reset time can move across a second boundary).
const PACE_MIN_SECS = 1200;
const sameWindow = (a, b) => a != null && b != null && Math.abs(a - b) <= 60;
// Points that are not finite numbers (a hand-edited file) give null; it never throws.
const usable = (x, p, r) => !!x && fin(x.t) && fin(x[p]) && fin(x[r]);
function forecast(points, p, r, now) {
    const last = points[points.length - 1];
    if (!usable(last, p, r) || last[r] <= now || now - last.t > FRESH_SECS) return null;
    if (last[p] >= 100) return null;  // already full: the bar says so
    const first = points.find((x) => usable(x, p, r) && sameWindow(x[r], last[r]));
    const span = last.t - first.t, rise = last[p] - first[p];
    if (span < PACE_MIN_SECS || rise <= 0) return null;
    const full = last.t + (100 - last[p]) * span / rise;
    if (!fin(full) || full <= now) return null;  // the line says it is full already, but no fetch saw it
    return full < last[r] ? { full } : { lasts: true };
}

// A window whose reset time passed after the numbers were fetched has started again: its old percent is gone. Until
// ccswitch fetches again, show it as 0% with no reset time (a 32% session that reset 4 min ago is not 32% used).
// Only for data inside the display window (FRESH_SECS): an older row gets a dash, since its old percent is over and
// 0% would be a guess. A missing percent stays missing.
function rolled(a, now) {
    const out = { ...a }, from = a.fetched_at;
    for (const [p, r] of [['five_pct', 'five_reset_epoch'], ['week_pct', 'week_reset_epoch']]) {
        if (from != null && out[p] != null && out[r] != null && out[r] <= now && from < out[r]) {
            out[p] = now - from < FRESH_SECS ? 0 : null;
            out[r] = null;
        }
    }
    return out;
}

const isFresh = (a, now, secs = FRESH_SECS) => a.state === 'ok' && a.fetched_at != null
    && now - a.fetched_at < secs && a.fetched_at - now <= CLOCK_SLACK_SECS;
const loadOf = (a) => Math.max(...[a.five_pct, a.week_pct].filter((v) => v != null));  // a missing window is not full

// A switch target: saved, login not dead, its own data fresh, neither window full, not the active account, Claude only.
function qualifies(a, ctx) {
    if ((a.provider || 'claude') !== 'claude' || (a.five_pct == null && a.week_pct == null)) return false;
    return a.label !== ctx.you && ctx.isSaved(a.label) && !ctx.relogin.has(a.label) && isFresh(a, ctx.now, SWITCH_FRESH_SECS) && loadOf(a) < 100;
}

// HTML-escape a label before it goes into innerHTML or a quoted attribute. Labels come from folder names, or from
// a team file when claudeUsage.usageFile is set, so they are input. The webview gets this same function.
function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// When a window resets, as the panel says it after "Resets": 'in 48m', 'in 4h 12m', 'tomorrow 01:00', 'Fri 01:00', 'now'.
// short (the one-line row summary) drops minutes and clock: 'in 4h', 'tomorrow', 'Fri'.
function resetText(epoch, short = false) {
    const secs = epoch - Date.now() / 1000;
    if (secs < 60) return 'now';
    const d = new Date(epoch * 1000), now = new Date();
    const dayDiff = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 864e5);
    if (dayDiff === 0) {
        const m = Math.floor(secs / 60), h = Math.floor(m / 60);
        return 'in ' + (!h ? m + 'm' : short ? h + 'h' : `${h}h ${m % 60}m`);
    }
    const day = dayDiff === 1 ? 'tomorrow' : DAYS[d.getDay()];
    return short ? day : `${day} ${d.toTimeString().slice(0, 5)}`;
}

// Load = max(5h, weekly) (the CtrlA hub's rules); best = lowest load among qualifying accounts.
function capacity(u, ctx) {
    const seats = u.accounts.filter((a) => (a.provider || 'claude') === 'claude' && (a.five_pct != null || a.week_pct != null));
    const best = seats.filter((a) => qualifies(a, ctx)).sort((x, y) => loadOf(x) - loadOf(y))[0];
    const fresh = Object.fromEntries(seats.map((a) => [a.label, isFresh(a, ctx.now)]));
    return { you: ctx.you,
        best: best ? { label: best.label, five: best.five_pct, week: best.week_pct } : null,
        loads: Object.fromEntries(seats.map((a) => [a.label, loadOf(a)])), fresh,
        activeFresh: !!ctx.you && fresh[ctx.you] === true,
        activeSwitchFresh: !!ctx.you && seats.some((a) => a.label === ctx.you && isFresh(a, ctx.now, SWITCH_FRESH_SECS)) };
}

// Auto-switch target: the best qualifying account, but only when the active account is full (100% on 5h or weekly)
// and its own data is under 15 min old. Returns a label (ccswitch's rule) or null.
function autoTarget(cap) {
    if (!cap.you || !cap.activeSwitchFresh || !(cap.loads[cap.you] >= 100) || !cap.best) return null;
    return isLabel(cap.best.label) ? cap.best.label : null;
}

// Status bar: `● <you> <5h>%/<wk>% · ⇄ <next-best>`. ◷ marks data that is not fresh; $(sync) marks auto-switch on.
// Only the best qualifying account is named, so a stale or dead account is never counted as available.
const pctOr = (v) => (v == null ? '–' : Math.round(v) + '%');
function statusText(cap, accounts, auto) {
    const lead = auto ? '$(sync) ' : '';
    if (!cap.you) return lead + '● none';
    const me = accounts.find((a) => isClaude(a) && a.label === cap.you) || {};
    return `${lead}● ${cap.you} ${pctOr(me.five_pct)}/${pctOr(me.week_pct)}${cap.activeFresh ? '' : ' ◷'} · ⇄ ${cap.best ? cap.best.label : 'none'}`;
}

// Tooltip: the auto-switch state, then one line per account (an active account with no row gets one too).
function statusTooltip(cap, accounts, auto, now = Date.now() / 1000) {
    const list = cap.you && !accounts.some((a) => isClaude(a) && a.label === cap.you) ? [...accounts, { label: cap.you, fetched_at: null, state: 'no data yet' }] : accounts;
    const dead = new Set(cap.relogin || []);
    const lines = list.map((a) => {
        const age = isFresh(a, now) ? null : ageText(a.fetched_at, now), claude = isClaude(a);
        return `${a.label}: 5h ${pctOr(a.five_pct)}, wk ${pctOr(a.week_pct)}` + (claude && dead.has(a.label) ? ' · re-login' : '')
            + (age === 'no data' ? ' · no data' : age ? ` · data ${age}` : !isFresh(a, now) ? ` · ${a.state}` : '')
            + (!claude ? ' · ' + TIPS.readonly : a.label === cap.you ? ' · active' : '');
    });
    return [`Auto-switch: ${auto ? 'ON' : 'off'}`, ...lines].join('\n');
}

// Data age as shown on a row: null while fresh by time, 'no data' when there never was any, 'in the future' past the
// clock slack, else '45m old' / '5h old' / '13d old'.
function ageText(fetchedAt, now) {
    if (fetchedAt == null) return 'no data';
    const secs = now - fetchedAt;
    if (secs < -CLOCK_SLACK_SECS) return 'in the future';
    if (secs < FRESH_SECS) return null;
    return secs >= 86400 ? Math.floor(secs / 86400) + 'd old' : secs >= 3600 ? Math.floor(secs / 3600) + 'h old' : Math.floor(secs / 60) + 'm old';
}

function readAccounts() {
    const now = Date.now() / 1000;
    const u = readSnapshot();
    u.accounts = u.accounts.map((a) => rolled(a, now));
    const cap = capacity(u, { you: activeLabel(), isSaved: saved, relogin, now });
    const accounts = u.accounts.map((a) => ({ ...a, email: isClaude(a) ? emailOf(a.label) : null }));
    cap.loginHealth = loginHealth;
    cap.saved = fs.existsSync(CCSWITCH) ? accounts.map((a) => a.label).filter(saved) : null;  // null = no ccswitch
    cap.relogin = [...relogin];
    return { accounts, cap };
}

// What the panel shows, decided here so the webview only draws it. Every status is one icon with a fixed tooltip and
// one grey summary ('82% · 74%', 'Weekly full · resets Thu', 'Re-login needed', 'No recent data').
// An active account with no row (not saved, no data) gets one. A Codex row is read-only: a lock (or 'full'), no actions.
const TIPS = { active: 'Active account', relogin: 'Needs re-login', full: 'A limit is at 100%', switch: 'You can switch here',
    readonly: 'Codex (read-only)', '': '' };
function panelData(accounts, cap, { now, installed, auto, team = false, histRange = 'auto', historyOn = false }) {
    const savedSet = new Set(cap.saved || []), dead = new Set(cap.relogin || []);
    const ctx = { you: cap.you, isSaved: (l) => savedSet.has(l), relogin: dead, now };
    const pct = (v) => (v == null ? null : Math.round(v));
    const live = (epoch) => epoch && epoch > now - 60;  // a past reset says nothing about now
    const reset = (epoch) => (live(epoch) ? resetText(epoch) : null);
    const full = (name, epoch) => name + ' full' + (live(epoch) ? ' · resets ' + resetText(epoch, true) : '');
    const age = (a) => (isFresh(a, now) ? null : ageText(a.fetched_at, now) || a.state);
    const list = cap.you && !accounts.some((a) => isClaude(a) && a.label === cap.you)
        ? [...accounts, { label: cap.you, provider: 'claude', state: 'no data yet', fetched_at: null, five_pct: null, week_pct: null, email: null }]
        : accounts;
    const rows = list.map((a) => {
        const claude = isClaude(a), you = claude && a.label === cap.you;
        const icon = you ? 'active' : claude && dead.has(a.label) ? 'relogin' : (a.five_pct >= 100 || a.week_pct >= 100) ? 'full'
            : !claude ? 'readonly' : qualifies(a, ctx) ? 'switch' : '';
        const tip = claude ? TIPS[icon] : TIPS.readonly + (icon === 'full' ? ' · ' + TIPS.full : '');
        const actions = !claude || !installed ? [] : [
            ...(you && !savedSet.has(a.label) ? ['save'] : []),
            ...(!you && !dead.has(a.label) ? ['switch'] : []),
            ...(dead.has(a.label) ? ['relogin'] : []),
            ...(savedSet.has(a.label) ? ['delete'] : []),
        ];
        const summary = icon === 'relogin' ? 'Re-login needed' : age(a) ? 'No recent data'
            : icon === 'full' ? (a.week_pct >= 100 ? full('Weekly', a.week_reset_epoch) : full('Session', a.five_reset_epoch))
            : pctOr(a.five_pct) + ' · ' + pctOr(a.week_pct);
        return { label: a.label, provider: a.provider || 'claude', icon, tip, summary, five: pct(a.five_pct), week: pct(a.week_pct),
            fiveReset: reset(a.five_reset_epoch), weekReset: reset(a.week_reset_epoch), age: age(a), email: a.email || null, actions };
    });
    const mine = list.find((a) => isClaude(a) && a.label === cap.you);
    // History view (only while its tab is shown): one block per Claude account with points, the active account first.
    // Each chart is [t, %, reset], downsampled here to the chart's width (window starts and peaks kept), so a 30-day
    // range posts about CW points per chart, not every sample.
    const fullAt = (f) => 'Full ' + resetText(f.full) + ' at this pace';
    const pace = (h, p, r) => { const f = forecast(h, p, r, now); return !f ? null : f.lasts ? 'Lasts until reset' : fullAt(f); };
    const activePace = (p, r) => { const f = mine && forecast(mine.history || [], p, r, now); return f && f.full ? fullAt(f) : null; };
    const series = (h, p, r, secs) => downsample(h.filter((x) => x.t >= now - secs && x[p] != null)
        .map((x) => [x.t, Math.round(x[p] * 10) / 10, x[r] ?? null]), now - secs, now, CW);
    const history = !historyOn ? [] : list.filter((a) => isClaude(a) && a.history && a.history.length)
        .sort((a, b) => (b.label === cap.you) - (a.label === cap.you))
        .map((a) => {
            const r = rows.find((x) => x.provider === 'claude' && x.label === a.label);
            return { label: a.label, icon: r.icon, tip: r.tip, five: pct(a.five_pct), week: pct(a.week_pct),
                fiveSeries: series(a.history, 'p5', 'r5', (Object.hasOwn(HIST_RANGES, histRange) ? HIST_RANGES[histRange] : 86400)), weekSeries: series(a.history, 'p7', 'r7', (Object.hasOwn(HIST_RANGES, histRange) ? HIST_RANGES[histRange] : 7 * 86400)),
                fivePace: pace(a.history, 'p5', 'r5'), weekPace: pace(a.history, 'p7', 'r7') };
        });
    return {
        installed, auto, team, loginHealth: cap.loginHealth || 'unknown',
        active: mine ? { label: mine.label, email: mine.email || null, five: pct(mine.five_pct), week: pct(mine.week_pct),
            fiveReset: reset(mine.five_reset_epoch), weekReset: reset(mine.week_reset_epoch), age: age(mine),
            fivePace: activePace('p5', 'r5'), weekPace: activePace('p7', 'r7') } : null,
        next: cap.best ? { label: cap.best.label, five: pct(cap.best.five), week: pct(cap.best.week) } : null,
        counts: { total: rows.length, saved: rows.filter((r) => r.provider === 'claude' && savedSet.has(r.label)).length,
            relogin: rows.filter((r) => r.icon === 'relogin').length, full: rows.filter((r) => r.icon === 'full').length },
        rows, history, now, histRange: Object.hasOwn(HIST_RANGES, histRange) ? histRange : 'auto',
    };
}

// Turning auto-switch ON switches accounts with nobody watching, so it asks in a modal and records the yes in
// globalState (state); auto-switch never acts without it. OFF needs no dialog. Returns true when the setting changed.
const AUTO_DETAIL = 'Auto-switch changes the Claude Code account for every new Claude Code session on this machine, without asking, '
    + 'when the active account reaches 100% (5h or weekly). If it is already at 100%, it switches right away. '
    + 'Open Claude Code tabs keep the old account until you restart them.';
const CONSENT = 'claudeUsage.autoSwitchConsent';
async function askAutoConsent(state) {
    const ok = await vscode.window.showWarningMessage('Turn on auto-switch?', { modal: true, detail: AUTO_DETAIL }, 'Turn on') === 'Turn on';
    if (ok) await state.update(CONSENT, true);
    return ok;
}
async function setAutoSwitch(on, state) {
    if (on && !(await askAutoConsent(state))) return false;
    await vscode.workspace.getConfiguration('claudeUsage').update('autoSwitch', on, vscode.ConfigurationTarget.Global);
    return true;
}
// Fire-and-forget callers (toggle, toast): a failed settings write must be shown, not dropped.
const changeAutoSwitch = (on, state) => setAutoSwitch(on, state).catch((err) =>
    vscode.window.showErrorMessage('Could not change auto-switch: ' + (err && err.message || err)));
// The setting is on, but nobody confirmed the dialog on this machine (settings.json, an older version):
// ask once (polls share the pending dialog); No turns the setting off.
let pendingConsent = null;
function confirmAutoOn(state) {
    pendingConsent = pendingConsent || askAutoConsent(state)
        .then((ok) => ok || changeAutoSwitch(false).then(() => false))
        .finally(() => { pendingConsent = null; });
    return pendingConsent;
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
// saved yet (or whose saved login expired) is enrolled once with `ccswitch add <label>`.
async function switchSeat(label, onDone) {
    if (!isLabel(label)) return;  // ccswitch's own label rule - never anything else
    if (!fs.existsSync(CCSWITCH)) return installCcswitch();
    if (label === activeLabel()) { vscode.window.showInformationMessage(`You are already on ${label}.`); return; }
    if (relogin.has(label) || !saved(label)) return enroll(label, relogin.has(label));

    const ok = await vscode.window.showWarningMessage(`Switch Claude Code to ${label}?`,
        { modal: true, detail: 'Instant, using your saved login (ccswitch). New Claude Code sessions use it; restart open Claude Code tabs to move them over.' },
        'Switch');
    if (ok !== 'Switch') return;
    const r = await ccswitch([label]);
    if (!r.ok) { vscode.window.showErrorMessage('ccswitch failed: ' + r.msg); return; }
    onDone();
    vscode.window.showInformationMessage(`Switched Claude Code to ${label}. Restart open Claude Code tabs to use it.`);
}

// ccswitch's reserved words (RESERVED_WORDS in the ccswitch script): a label may not be one of them.
const RESERVED = ['save', 'delete', 'list', 'usage', 'help', 'version', 'refresh-pause', 'refresh-resume', 'add'];
// The input box's check of a new label: null when fine, else the text (or a warning) to show under the box.
function labelProblem(v) {
    if (!isLabel(v)) return 'Use letters, digits, _ and - only, and do not start with -.';
    if (RESERVED.includes(v)) return `"${v}" is a ccswitch command: pick another label.`;
    if (saved(v)) return { message: `${v} is already saved: ccswitch will ask before it overwrites it.`, severity: vscode.InputBoxValidationSeverity.Warning };
    return null;
}

// `ccswitch add` arrived in 1.2.0. An older ccswitch prints its version (`ccswitch 1.1.0`) but fails on `add`.
async function ccswitchHasAdd() {
    const r = await run(CCSWITCH, ['version']);
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(r.out);
    return r.ok && !!m && (+m[1] > 1 || (+m[1] === 1 && +m[2] >= 2));
}

// Add terminal -> { label, before }: before = the label folder's inode when the terminal opened (null: none). ccswitch
// swaps a new snapshot in as a new folder, so a different inode after a clean exit means it saved (a "no" at its
// prompt also exits 0, and a token refresh rewrites files inside the folder, not the folder).
const addTerminals = new Map();
const snapshotId = (label) => { try { return fs.statSync(path.join(ACCOUNTS, label)).ino; } catch { return null; } };
// Log in to a label and save it with `ccswitch add <label>`, in a terminal the user can see: it prints a URL, the user
// logs in and pastes the code back there. The live login is never touched. `&& exit` closes the terminal after a
// successful run, so the close hook says "Saved", shows the row and fetches (and clears a stale "Re-login needed");
// on failure it stays open to read the error.
async function runAdd(label) {
    if (!isLabel(label)) return;
    if (!fs.existsSync(CCSWITCH)) return installCcswitch();
    if (!(await ccswitchHasAdd())) return installCcswitch('Adding an account needs ccswitch 1.2.0 or newer (`ccswitch add`). The installed one is older, and this installer updates it.');
    const t = vscode.window.createTerminal(`Add account: ${label}`);
    addTerminals.set(t, { label, before: snapshotId(label) });
    t.show();
    t.sendText(`"${CCSWITCH}" add ${label} && exit`);
}

// The "+ Add account" row: ask for a label, then runAdd.
async function addAccount() {
    const label = await vscode.window.showInputBox({ title: 'Add account', prompt: 'A short name for the account (letters, digits, _ and -)',
        placeHolder: 'work', validateInput: labelProblem });
    if (label) return runAdd(label.trim());
}

// One-time enrolment of a seat ccswitch can't switch to yet (not saved, or its login expired): `ccswitch add`.
async function enroll(label, expired) {
    const ok = await vscode.window.showInformationMessage(
        expired ? `The saved login for ${label} has expired (ccswitch: re-login).` : `${label} isn't saved in ccswitch yet.`,
        { modal: true, detail: `Log in to ${label} once: a terminal opens and runs ccswitch add ${label}. Open the URL it prints, sign in as ${label} `
            + `and paste the code if it asks for one. `
            + (expired ? `ccswitch asks before it overwrites the saved login for ${label}: answer y. ` : '') + `Your current Claude Code login is not touched. After that, switching to ${label} is instant.` },
        'Open terminal');
    if (ok !== 'Open terminal') return;
    await runAdd(label);
}

// cc-usage-bar (sytang9) provides ccswitch; run its own installer where the user can see and answer it.
async function installCcswitch(why = 'Seat switching needs ccswitch from github.com/sytang9/cc-usage-bar.') {
    const ok = await vscode.window.showWarningMessage('Install ccswitch (cc-usage-bar)?',
        { modal: true, detail: why + ' Its installer copies three scripts into ~/.claude, '
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
let loginChecked = false;  // true once a check returned a valid document; auto-switch waits for it

// The parsed `usage --json` document, or null unless it is schema 1 with an accounts array.
function parseUsageJson(text) {
    try {
        const d = JSON.parse(text);
        return d && d.schema === 1 && Array.isArray(d.accounts) ? d : null;
    } catch { return null; }
}

// New re-login set: no document (failed run) -> the previous set; re-login adds, ok removes, unknown keeps the
// previous verdict; saved only. One failed run must never forget a dead login.
function mergeLogins(prev, doc, isSaved) {
    if (!doc) return new Set(prev);
    const next = new Set(prev);
    for (const a of doc.accounts) {
        if (a.login === 're-login') next.add(a.label);
        else if (a.login === 'ok') next.delete(a.label);
    }
    return new Set([...next].filter(isSaved));
}

// The one guarded fetch: every `ccswitch usage --json` run goes through here, so two never overlap. A caller that
// arrives while one runs gets that run's promise. onBusy (set by activate) tells the panel to spin; it never rejects.
// A manual fetch (the reload button, the Refresh command) adds --refresh, past ccswitch's 10-min usage cache, at most
// once per MANUAL_LIVE_MS; ccswitch still keeps its 429 backoff and its refresh lock. Timers always read the cache.
const MANUAL_LIVE_MS = 60 * 1000;
let inflight = null, onBusy = () => {}, lastLive = -Infinity;
function fetchLogins(manual = false) {
    if (inflight) return inflight;
    const live = manual === true && Date.now() - lastLive >= MANUAL_LIVE_MS;
    if (live) lastLive = Date.now();
    onBusy(true);
    return (inflight = checkLogins(live).catch(() => {}).finally(() => { inflight = null; onBusy(false); }));
}

async function checkLogins(live = false) {
    if (!fs.existsSync(CCSWITCH)) return;
    const r = await run(CCSWITCH, ['usage', '--json', ...(live ? ['--refresh'] : [])]);
    const doc = r.ok ? parseUsageJson(r.out) : null;  // old ccswitch (no --json) or stray output: trust nothing
    const next = mergeLogins(relogin, doc, saved);
    relogin.clear();  // same Set object, so saveSeat's relogin.delete keeps working
    for (const l of next) relogin.add(l);
    loginHealth = doc && doc.login_health === 'known' ? 'known' : 'unknown';
    if (doc) loginChecked = true;
}

// Save the CURRENT login under its seat name (ccswitch save always snapshots whichever login is active).
async function saveSeat(label, onDone) {
    if (!isLabel(label)) return;
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
    if (!isLabel(label)) return;
    const ok = await vscode.window.showWarningMessage(`Delete the saved login for ${label}?`,
        { modal: true, detail: 'Your current Claude Code login is not affected. To switch to this seat again you will need to log in to it once (+ Add account).' }, 'Delete');
    if (ok !== 'Delete') return;
    const r = await ccswitch(['delete', label], 'y\n');
    if (r.ok && !saved(label)) vscode.window.showInformationMessage(`Deleted the saved login for ${label}.`);
    else vscode.window.showErrorMessage('ccswitch delete failed: ' + r.msg);
    onDone();
}

// --- Auto-switch. Every VS Code window runs its own copy, so the cooldown is a file and one window at a time
// decides and switches, under an mkdir lock (atomic). Both sit next to ccswitch's own state files.
const AUTO_STAMP = path.join(ACCOUNTS, '.autoswitch.json');  // { last_switch: <epoch secs> }
const AUTO_LOCK = path.join(ACCOUNTS, '.autoswitch.lock');
const AUTO_COOLDOWN_SECS = 10 * 60;  // a lagging snapshot can't bounce us between accounts
const AUTO_LOCK_STALE_SECS = 10 * 60;  // longer than ccswitch()'s worst case (5 tries x 90 s): a crashed window left it

// Why auto-switch must not act now, or null when it may. Every gate but the machine-wide cooldown and lock.
function autoBlock(g) {
    if (!g.on) return 'off';
    if (!g.consented) return 'no consent';
    if (!g.installed) return 'no ccswitch';
    if (!g.checked) return 'no login check yet';
    if (g.health !== 'known') return 'login health unknown';
    return autoTarget(g.cap) ? null : 'no target';
}

function writeAutoStamp(secs) {
    const tmp = `${AUTO_STAMP}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ last_switch: secs }));
    fs.renameSync(tmp, AUTO_STAMP);
}

function takeAutoLock(now) {
    try { fs.mkdirSync(AUTO_LOCK); return true; } catch { /* held by another window, or stale */ }
    try {
        if (now - fs.statSync(AUTO_LOCK).mtimeMs / 1000 < AUTO_LOCK_STALE_SECS) return false;
        fs.rmSync(AUTO_LOCK, { recursive: true, force: true });
        fs.mkdirSync(AUTO_LOCK);
        return true;
    } catch { return false; }
}

// One attempt: { skip: reason } or { from, to, r } (r = the ccswitch result). The stamp is written before the
// switch, so a failed switch also waits out the cooldown instead of retrying on every poll.
async function autoSwitchOnce(cap, state) {
    const on = !!vscode.workspace.getConfiguration('claudeUsage').get('autoSwitch');
    if (on && !state.get(CONSENT) && !(await confirmAutoOn(state))) return { skip: 'no consent' };
    const why = autoBlock({ on, consented: !!state.get(CONSENT), installed: fs.existsSync(CCSWITCH), checked: loginChecked, health: loginHealth, cap });
    if (why) return { skip: why };
    const now = Date.now() / 1000;
    const cooling = () => {
        const last = Number((readJson(AUTO_STAMP) || {}).last_switch) || 0;
        return last <= now && now - last < AUTO_COOLDOWN_SECS;  // a stamp in the future (a wrong clock) is ignored
    };
    if (cooling()) return { skip: 'cooldown' };  // before the lock: a lock made on every poll wakes every window's watcher
    if (!takeAutoLock(now)) return { skip: 'busy' };
    try {
        if (cooling()) return { skip: 'cooldown' };  // again under the lock: another window may have just switched
        const live = readAccounts().cap, from = cap.you, to = autoTarget(live);  // the poll's cap may be a minute old
        if (live.you !== from || !to) return { skip: 'moved' };
        writeAutoStamp(now);
        return { from, to, r: await ccswitch([to]) };
    } finally { fs.rmSync(AUTO_LOCK, { recursive: true, force: true }); }
}

// Polls call this without waiting, so an error (an unreadable file, a stamp it cannot write) is shown here.
async function autoSwitch(cap, state, onDone) {
    let res;
    try { res = await autoSwitchOnce(cap, state); } catch (err) {
        vscode.window.showErrorMessage('Auto-switch failed: ' + (err && err.message || err));
        return { skip: 'error' };
    }
    if (!res.r) return res;
    if (!res.r.ok) { vscode.window.showErrorMessage(`Auto-switch to ${res.to} failed: ` + res.r.msg); return res; }
    onDone();
    const next = await vscode.window.showWarningMessage(`Auto-switched Claude Code: ${res.from} is full, now on ${res.to} (most headroom). Restart open Claude Code tabs to use it.`, 'Turn auto-switch off');
    if (next === 'Turn auto-switch off') changeAutoSwitch(false);
    return res;
}


// Stats view: built from this machine's Claude Code transcripts (stats.js) only while the view is shown, at most every
// 10 min, one build at a time, with an incremental cache in the extension's global storage. send gets each message.
// A failed build is tried again after STATS_RETRY_MS, keeping the last good stats on screen meanwhile.
const STATS_EVERY_MS = 10 * 60 * 1000;
const STATS_RETRY_MS = 60 * 1000;
function statsFeed(cachePath, send, build = buildStats) {
    let last = null, at = 0, wait = 0, busy = false;
    return () => {
        if (busy) return;
        if (last && Date.now() - at < wait) { send(last); return; }
        busy = true;
        send({ kind: 'stats', building: true, stats: last && last.stats });
        return build({ cachePath }).then((stats) => { last = { kind: 'stats', stats }; wait = STATS_EVERY_MS; },
            (err) => { last = { kind: 'stats', error: String((err && err.message) || err), stats: last && last.stats }; wait = STATS_RETRY_MS; })
            .then(() => { at = Date.now(); busy = false; send(last); });
    };
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

    const wantStats = statsFeed(path.join(context.globalStorageUri.fsPath, 'stats-cache.json'), (m) => view && view.webview.postMessage(m));
    let histRange = 'auto';  // the History range the webview shows (it says so at start and on every change)
    let historyOn = false;  // the webview shows its History tab (it says so on every view change)
    const push = () => {
        if (!view || !cap) return;
        const now = Date.now() / 1000, want = (l) => historyOn || l === cap.you;
        view.webview.postMessage(panelData(view.visible ? withHistory(accounts, want, now) : accounts, cap,
            { now, installed: fs.existsSync(CCSWITCH), auto: !!cap.auto, team: !!usageFile(), histRange, historyOn }));
    };
    const autoOn = () => vscode.workspace.getConfiguration('claudeUsage').get('autoSwitch');
    const toggleAuto = () => changeAutoSwitch(!autoOn(), context.globalState);

    const poll = () => {
        try { ({ accounts, cap } = readAccounts()); cap.auto = autoOn(); } catch (err) { status.text = '$(warning) Claude usage unreadable'; status.tooltip = String(err); return; }
        status.text = statusText(cap, accounts, cap.auto);
        status.tooltip = statusTooltip(cap, accounts, cap.auto);
        push();
        autoSwitch(cap, context.globalState, poll);
    };

    // The fetch (timed, from the button or the command). The panel spins from start to end; a request while one runs is dropped.
    const post = (m) => view && view.webview.postMessage(m);
    onBusy = (on) => post({ kind: 'busy', on });
    const health = (manual) => { if (!inflight) fetchLogins(manual === true).then(poll); };
    const manualHealth = () => health(true);
    // An Add account terminal closed: say so when ccswitch saved a new snapshot, show the row now, then fetch its
    // numbers (after a fetch already in flight, which started before the save and would not see it).
    const addClosed = (t) => {
        const add = addTerminals.get(t);
        if (!add) return;
        addTerminals.delete(t);
        const id = snapshotId(add.label);
        if (t.exitStatus && t.exitStatus.code === 0 && id !== null && id !== add.before) {
            vscode.window.showInformationMessage(`Saved account ${add.label}. It is in the Accounts list now.`);
        }
        poll();
        (inflight || Promise.resolve()).then(() => fetchLogins()).then(poll);
    };

    context.subscriptions.push(status,
        vscode.commands.registerCommand('claudeUsage.toggleAutoSwitch', toggleAuto),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('claudeUsage.usageFile')) { fs.unwatchFile(watched); watched = usageFile() || ACCOUNTS; fs.watchFile(watched, { interval: 5000 }, poll); }
            if (e.affectsConfiguration('claudeUsage')) poll();
        }),
        vscode.commands.registerCommand('claudeUsage.refresh', manualHealth),
        vscode.window.onDidCloseTerminal(addClosed),
        vscode.window.registerWebviewViewProvider('claudeUsage.view', {
            resolveWebviewView(v) {
                view = v;
                v.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(CODICONS)] };
                v.webview.html = webviewHtml(v.webview);
                v.webview.onDidReceiveMessage((m) => {
                    if (!m) return;
                    if (m === 'ready') { push(); if (inflight) post({ kind: 'busy', on: true }); }
                    else if (m.refresh) manualHealth();
                    else if (m.seat) switchSeat(m.seat, poll);
                    else if (m.add) addAccount();
                    else if (m.save) saveSeat(m.save, poll);
                    else if (m.del) deleteSeat(m.del, poll);
                    else if (m.toggleAuto) toggleAuto();
                    else if (m.installCc) installCcswitch();
                    else if (m.wantStats) { if (v.visible) wantStats(); }  // a hidden, retained Stats tab never rebuilds
                    else if (m.wantHistory !== undefined || m.histRange !== undefined) {
                        if (m.wantHistory !== undefined) historyOn = m.wantHistory === true;
                        if (m.histRange !== undefined) histRange = Object.hasOwn(HIST_RANGES, m.histRange) ? m.histRange : 'auto';
                        push();
                    }
                });
                v.onDidChangeVisibility(() => { if (v.visible) push(); });  // shown again: Stats asks for a rebuild if it is due
                v.onDidDispose(() => { view = null; });
            },
        }, { webviewOptions: { retainContextWhenHidden: true } }));

    poll();
    const timer = setInterval(poll, POLL_MS);
    const firstCheck = setTimeout(health, 30 * 1000);
    // ccswitch's own cache: refresh at its 10-min TTL; with a team file, hourly is enough to keep tokens alive
    const healthTimer = setInterval(health, (usageFile() ? 60 : 10) * 60 * 1000);
    context.subscriptions.push({ dispose: () => { clearTimeout(firstCheck); clearInterval(healthTimer); } });
    let watched = usageFile() || ACCOUNTS;
    fs.watchFile(watched, { interval: 5000 }, poll);  // refresh as soon as new numbers land
    fs.watchFile(path.join(HOME, '.claude.json'), { interval: 5000 }, poll);  // "you" follows ccswitch run in a terminal
    context.subscriptions.push({ dispose: () => { clearInterval(timer); fs.unwatchFile(watched); fs.unwatchFile(path.join(HOME, '.claude.json')); } });
}

// One native panel: panel.css + esc + panel.js inlined; the vendored codicon font is the only file it loads.
// No network, no frames.
const CODICONS = path.join(__dirname, 'webview', 'codicons');
function webviewHtml(webview) {
    const read = (f) => fs.readFileSync(path.join(__dirname, 'webview', f), 'utf8');
    const src = webview.cspSource;
    return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${src}; font-src ${src}; script-src 'unsafe-inline'; img-src data:">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${webview.asWebviewUri(vscode.Uri.file(path.join(CODICONS, 'codicon.css')))}">
<style>
${read('panel.css')}</style></head><body><main id="root"></main><script>
${esc.toString()}
${read('panel.js')}</script></body></html>`;
}

module.exports = { activate };
