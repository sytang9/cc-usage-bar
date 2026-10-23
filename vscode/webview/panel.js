// Sidebar panel, in the style of Claude Code's own "Account & Usage" view. render(data, ui) turns a panelData() result
// (extension.js) into HTML; it is pure so the tests can call it. Every label, email and reset text goes through esc(),
// which extension.js inlines before this script. Icons are codicons (vendored font). The bootstrap at the end runs
// only inside a VS Code webview.

const ICON = { active: 'circle-filled', relogin: 'warning', full: 'circle-slash', switch: 'arrow-swap', readonly: 'lock' };
const ACTION = { switch: 'Switch', save: 'Save login', relogin: 'How to re-login', delete: 'Delete' };
const ACTION_TIP = { save: 'Save your current login under this name (ccswitch save)', delete: 'Delete the saved login (ccswitch delete)' };

// Numbers reach the HTML only as finite numbers: anything else (a tampered cache or history file) is a dash.
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const pctText = (p) => (num(p) === null ? '–' : p + '%');
const ci = (name, cls = '', tip = '') => '<span class="codicon codicon-' + name + (cls ? ' ' + cls : '') + '"'
    + (tip ? ' title="' + esc(tip) + '" role="img" aria-label="' + esc(tip) + '"' : ' aria-hidden="true"') + '></span>';
const kv = (k, v) => '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';

// A section header: chevron + title (the toggle), then grey text or a link on the right.
function section(key, title, open, right = '', extra = '') {
    return '<div class="sec"><div class="hd" data-a="' + key + '" role="button" tabindex="0" aria-expanded="' + open + '"' + extra + '>'
        + ci(open ? 'chevron-down' : 'chevron-right') + '<span class="t">' + title + '</span></div>' + right + '</div>';
}

// One bar per limit. Like Claude Code's own: the theme's progress blue, Claude orange from 80% (HIGH) up.
const HIGH = 80;
function usage(name, p, reset, pace) {
    return '<div class="use"><div class="top"><span>' + name + '</span><span class="p">' + pctText(p) + '</span></div>'
        + '<div class="bar' + (p >= HIGH ? ' hi' : '') + '">' + (num(p) === null ? '' : '<i style="width:' + Math.max(0, Math.min(100, p)) + '%"></i>') + '</div>'
        + (reset ? '<div class="rs">Resets ' + esc(reset) + '</div>' : '') + (pace ? '<div class="rs">' + esc(pace) + '</div>' : '') + '</div>';
}

function active(a) {
    if (!a) return '<div class="kv"><span class="k">Not logged in to Claude Code</span></div>';
    return '<div class="grp">Account</div>' + kv('Nickname', esc(a.label)) + (a.email ? kv('Email', esc(a.email)) : '')
        + (a.age ? kv('Last data', esc(a.age)) : '')
        + '<div class="grp">Usage</div>' + usage('Session (5hr)', a.five, a.fiveReset, a.fivePace) + usage('Weekly (7 day)', a.week, a.weekReset, a.weekPace);
}

function nextLine(d) {
    if (!d.installed) {
        return '<div class="next"><div class="who">Switching needs ccswitch</div>'
            + '<button class="btn" data-a="install">Install ccswitch</button></div>';
    }
    if (!d.next) return '<div class="next"><div class="who d">No account to switch to</div></div>';
    const n = d.next;
    return '<div class="next">' + ci(ICON.switch, 'i-switch') + '<div class="who"><b>' + esc(n.label) + '</b>'
        + '<div class="d">Session ' + pctText(n.five) + ' · Weekly ' + pctText(n.week) + '</div></div>'
        + '<button class="btn" data-a="switch" data-l="' + esc(n.label) + '">Switch</button></div>';
}

function row(r, open) {
    const l = esc(r.label);
    let html = '<div class="row' + (open ? ' open' : '') + '" data-a="row" data-l="' + l
        + '" role="button" tabindex="0" aria-expanded="' + open + '">'
        + (r.icon ? ci(ICON[r.icon], 'i-' + r.icon, r.tip) : '<span class="codicon" aria-hidden="true"></span>')
        + '<span class="nm">' + l + '</span><span class="d">' + esc(r.summary) + '</span>'
        + ci(open ? 'chevron-down' : 'chevron-right') + '</div>';
    if (!open) return html;
    const use = (p, reset) => pctText(p) + (reset ? ' · resets ' + esc(reset) : '');
    html += '<div class="det">'
        + (r.email ? kv('Email', esc(r.email)) : '')
        + (r.provider && r.provider !== 'claude' ? kv('Read-only', 'Codex usage, never a switch target') : '')
        + (r.age ? kv('Last data', esc(r.age))
            : kv('Session (5hr)', use(r.five, r.fiveReset)) + kv('Weekly (7 day)', use(r.week, r.weekReset)))
        + (r.actions.length ? '<div class="acts">' + r.actions.map((a) => '<button class="' + (a === 'switch' ? 'btn' : 'lnk') + '" data-a="' + a + '" data-l="' + l + '"'
            + (ACTION_TIP[a] ? ' title="' + ACTION_TIP[a] + '"' : '') + '>' + ACTION[a] + '</button>').join('') + '</div>' : '')
        + '</div>';
    return html;
}

// Collapsed by default: the one switch that acts without you watching. The line stays visible when open so touch and
// keyboard users can read it (the tooltip is not reachable for them).
function automation(d, ui) {
    const open = ui.automationOpen === true;
    return section('automation', 'Automation', open, '<span class="r">' + (d.auto ? 'On' : 'Off') + '</span>')
        + (open ? '<div class="kv"><span>Auto-switch at 100%</span>'
            + '<button class="tg' + (d.auto ? ' on' : '') + '" data-a="auto" role="switch" aria-checked="' + !!d.auto + '" aria-label="Auto-switch at 100%"'
            + ' title="When the active account reaches 100%, switch to the next-best account (fresh data, working login, at most once per 10 min), without asking. Restart open Claude Code tabs to use it."></button></div>'
            + '<div class="note">Moves every new Claude Code session on this machine to the account in "If you run out". Asks once when you turn it on.</div>' : '');
}

// One limit over time: an SVG line from `from` to `to` (epoch s), 0-100%, with a dashed 80% guide. A new window (the
// reset time changes, or the percent drops) starts a new line and gets a faint tick. Orange when the latest is 80%+.
// Hovering shows a guide line and a tooltip (hoverAt); every drawn chart is registered in CHARTS for that.
const CW = 300, CH = 56;
let CHARTS = [];
const newWindow = (a, b) => a !== b && !(a != null && b != null && Math.abs(a - b) <= 60);  // reset times a second apart: one window
function chart(title, pts, from, to, ago, pace, now, kind) {
    const x = (t) => ((t - from) / (to - from) * CW).toFixed(1);
    const y = (p) => (CH - Math.max(0, Math.min(100, p)) / 100 * CH).toFixed(1);
    pts = downsample(pts, from, to, CW);
    const runs = [];
    pts.forEach((q, i) => { const b = pts[i - 1]; if (!b || newWindow(q[2], b[2]) || q[1] < b[1]) runs.push([]); runs[runs.length - 1].push(q); });
    const svg = runs.map((run, i) => {
        const xy = run.map((q) => x(q[0]) + ',' + y(q[1]));
        if (xy.length === 1) xy.unshift(Math.max(0, x(run[0][0]) - 3).toFixed(1) + ',' + y(run[0][1]));  // a lone point: a short dash, inside the chart
        return (i ? '<line class="rz" x1="' + x(run[0][0]) + '" x2="' + x(run[0][0]) + '" y1="0" y2="' + CH + '"/>' : '')
            + '<polyline class="ln" points="' + xy.join(' ') + '"/>';
    }).join('');
    const cid = CHARTS.push({ pts, from, to, kind }) - 1;
    return '<div class="ch' + (now >= HIGH ? ' hi' : '') + '"><div class="top"><span>' + title + '</span><span class="p">' + pctText(now) + '</span></div>'
        + '<svg viewBox="0 0 ' + CW + ' ' + CH + '" data-cid="' + cid + '" preserveAspectRatio="none" role="img" aria-label="' + title + ', ' + pts.length + ' points">'
        + '<line class="g80" x1="0" x2="' + CW + '" y1="' + y(HIGH) + '" y2="' + y(HIGH) + '"/>'
        + '<line class="base" x1="0" x2="' + CW + '" y1="' + CH + '" y2="' + CH + '"/>' + svg
        + '<line class="gl" x1="0" x2="0" y1="0" y2="' + CH + '"/></svg><div class="tip" role="presentation"></div>'
        + '<div class="ax"><span>' + ago + '</span><span>now</span></div>'
        + (pace ? '<div class="rs">' + esc(pace) + '</div>' : '') + '</div>';
}

// About one point per pixel column (the chart is CW columns wide): the last point in each column, so 30 days of
// samples stay fast. A point that starts a new window (usage falls, or the reset time changes) is always kept, so the
// reset ticks survive; the result is at most `cols` points plus two for each window start.
function downsample(pts, from, to, cols) {
    if (pts.length <= cols) return pts;
    const out = [];
    let last = -1, keep = false;
    pts.forEach((q, i) => {
        const b = Math.max(0, Math.min(cols - 1, Math.floor((q[0] - from) / (to - from) * cols))), p = pts[i - 1];
        const starts = !!p && (q[1] < p[1] || newWindow(q[2], p[2]));
        if (b === last && !starts && !keep) out[out.length - 1] = q; else out.push(q);
        last = b; keep = starts;
    });
    return out;
}

// What the tooltip says at time t (epoch s) on a registered chart: time ago and clock time, the usage % at the nearest
// sample, and the rate on the segment around t (%/h for the 5h chart, %/day for the weekly one). A fall in usage or a
// new window is a "reset", not a negative rate; a segment longer than 3x the usual sample spacing, or t outside the
// data, is "no data". Pure, so the tests can call it.
function hoverAt(spec, t) {
    const pts = spec.pts;
    if (!pts.length) return null;
    const dts = pts.slice(1).map((q, i) => q[0] - pts[i][0]).sort((a, b) => a - b);
    const gap = dts.length ? 3 * dts[Math.floor(dts.length / 2)] : Infinity;
    let i = 0;
    pts.forEach((q, k) => { if (Math.abs(q[0] - t) < Math.abs(pts[i][0] - t)) i = k; });
    const j = pts.findIndex((q, k) => k < pts.length - 1 && q[0] <= t && t <= pts[k + 1][0]);
    let rate = 'no data';
    if (j >= 0) {
        const a = pts[j], b = pts[j + 1], dt = b[0] - a[0], week = spec.kind === 'week';
        if (b[1] < a[1] || newWindow(a[2], b[2])) rate = 'reset';
        else if (dt <= gap && dt > 0) rate = '+' + ((b[1] - a[1]) / dt * (week ? 86400 : 3600)).toFixed(1) + (week ? '%/day' : '%/h');
    }
    const s = Math.max(0, Math.round(spec.to - t)), m = Math.floor(s / 60), h = Math.floor(m / 60), dd = Math.floor(h / 24);
    const agoText = s < 60 ? 'just now' : (dd ? dd + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + (m % 60) + 'm' : m + 'm') + ' ago';
    const dt0 = new Date(t * 1000), z = (n) => String(n).padStart(2, '0');
    const clock = (dd ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt0.getDay()] + ' ' : '') + z(dt0.getHours()) + ':' + z(dt0.getMinutes());
    const near = Math.abs(pts[i][0] - t) <= gap;
    return { when: agoText + ' \u00b7 ' + clock, pct: near ? pctText(pts[i][1]) : '\u2013', rate };
}

// History: one row per account with recorded points (active first, open by default); an open row shows both charts.
// The range selector sets how far back the charts reach. 'auto' is the default and keeps the original look: the 5h chart
// shows 24h and the weekly chart 7d; 24h / 7d / 30d give both charts that span. The host sends the series for the range.
const HRANGES = [['auto', 'Auto'], ['24h', '24h'], ['7d', '7d'], ['30d', '30d']];
const HSPAN = { '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };
// List (the default) is one expandable row per account; Grid shows every account's charts at once.
const HLAYOUTS = [['list', 'List'], ['grid', 'Grid']];
const histLayoutOf = (ui) => (ui.histLayout === 'grid' ? 'grid' : 'list');
const histRangeOf = (ui) => (HRANGES.some(([k]) => k === ui.histRange) ? ui.histRange : 'auto');
const spanOf = (range, dflt) => HSPAN[range] || dflt;
const spanName = (secs) => (secs >= 86400 * 2 ? secs / 86400 + 'd' : secs / 3600 + 'h');
const histOpenLabel = (d, ui) => (ui.histOpen === undefined ? (d.history[0] || {}).label : ui.histOpen);
function historyView(d, ui) {
    if (d.team) return '<div class="note empty">History is not shown for a team usage file: ccswitch records it on each machine.</div>';
    if (!d.history || !d.history.length) {
        return '<div class="note empty">No history yet: ccswitch records a point each time it fetches (every 10-20 min while VS Code is open).</div>';
    }
    const openL = histOpenLabel(d, ui), range = histRangeOf(ui), s5 = spanOf(range, 86400), s7 = spanOf(range, 7 * 86400);
    const charts = (h) => chart('Session (5hr) \u00b7 last ' + spanName(s5), h.fiveSeries, d.now - s5, d.now, spanName(s5) + ' ago', h.fivePace, h.five, 'five')
        + chart('Weekly (7 day) \u00b7 last ' + spanName(s7), h.weekSeries, d.now - s7, d.now, spanName(s7) + ' ago', h.weekPace, h.week, 'week');
    const head = (h) => (h.icon ? ci(ICON[h.icon], 'i-' + h.icon, h.tip) : '<span class="codicon" aria-hidden="true"></span>')
        + '<span class="nm">' + esc(h.label) + '</span><span class="d">' + pctText(h.five) + ' \u00b7 ' + pctText(h.week) + '</span>';
    const ctl = '<div class="hctl">' + seg('hrange', HRANGES, range) + seg('hlay', HLAYOUTS, histLayoutOf(ui)) + '</div>';
    // Grid: every account's charts at once, as cards in a CSS grid whose column count follows the panel width.
    if (histLayoutOf(ui) === 'grid') {
        return ctl + '<div class="hgrid">' + d.history.map((h) => '<div class="card"><div class="ch-h">' + head(h) + '</div>' + charts(h) + '</div>').join('') + '</div>';
    }
    return ctl + '<div class="rows">' + d.history.map((h) => {
        const l = esc(h.label), open = h.label === openL;
        return '<div class="row' + (open ? ' open' : '') + '" data-a="hrow" data-l="' + l + '" role="button" tabindex="0" aria-expanded="' + open + '">'
            + head(h) + ci(open ? 'chevron-down' : 'chevron-right') + '</div>'
            + (open ? '<div class="det">' + charts(h) + '</div>' : '');
    }).join('') + '</div>';
}

// Stats: like Claude Code's /stats, from this machine's transcripts (all accounts). st = the host's stats message.
const RANGES = [['7d', 'Last 7 days'], ['30d', 'Last 30 days'], ['all', 'All time']];
const big = (n) => (num(n) === null ? '–' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
const count = (n) => (num(n) === null ? '–' : String(n));
const span = (ms) => { const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
    return d ? d + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + (m % 60) + 'm' : m + 'm'; };
const days = (n) => (num(n) === null ? '–' : n + (n === 1 ? ' day' : ' days'));
const hh = (h) => String(h).padStart(2, '0') + ':00';
function seg(a, items, on) {
    return '<div class="seg" role="tablist">' + items.map(([k, t]) => '<button class="sg' + (k === on ? ' on' : '') + '" role="tab" aria-selected="'
        + (k === on) + '" data-a="' + a + '" data-l="' + k + '">' + t + '</button>').join('') + '</div>';
}

// Messages per day for the last 26 weeks (UTC days, Sunday on top), five levels like the CLI's heatmap.
const WEEKS = 26;
function heatmap(daily, today) {
    const counts = new Map(daily.map((x) => [x.date, x.messageCount]));
    const v = daily.map((x) => num(x.messageCount)).filter((n) => n > 0).sort((a, b) => a - b);
    const q = (f) => v[Math.floor(v.length * f)];
    const level = (n) => (!n || !v.length ? 0 : n >= q(0.75) ? 4 : n >= q(0.5) ? 3 : n >= q(0.25) ? 2 : 1);
    const end = new Date(today + 'T00:00:00Z'), start = new Date(end);
    start.setUTCDate(end.getUTCDate() - end.getUTCDay() - (WEEKS - 1) * 7);
    let cells = '';
    for (let d = new Date(start), i = 0; d <= end; d.setUTCDate(d.getUTCDate() + 1), i++) {
        const key = d.toISOString().slice(0, 10), n = num(counts.get(key)) || 0;
        cells += '<rect class="lv' + level(n) + '" x="' + Math.floor(i / 7) * 11 + '" y="' + (i % 7) * 11 + '" width="9" height="9" rx="2"><title>'
            + key + ': ' + n + ' messages</title></rect>';
    }
    return '<svg class="hm" viewBox="0 0 ' + (WEEKS * 11 - 2) + ' 75" role="img" aria-label="Messages per day, last ' + WEEKS + ' weeks">' + cells + '</svg>'
        + '<div class="ax"><span>' + WEEKS + ' weeks ago</span><span>Less <i class="lg lv1"></i><i class="lg lv2"></i><i class="lg lv3"></i><i class="lg lv4"></i> More</span></div>';
}

// Tokens per day for the top 3 models: one line each, a shared scale, a legend.
function tokensChart(t) {
    if (!t.days.length || !t.models.length) return '';
    const max = Math.max(1, ...t.days.flatMap((x) => t.models.map((m) => x.tokensByModel[m] || 0)));
    const x = (i) => (t.days.length === 1 ? CW / 2 : i / (t.days.length - 1) * CW).toFixed(1);
    const lines = t.models.map((m, k) => '<polyline class="ln m' + k + '" points="'
        + t.days.map((d, i) => x(i) + ',' + (CH - (d.tokensByModel[m] || 0) / max * CH).toFixed(1)).join(' ') + '"/>').join('');
    return '<div class="grp">Tokens per day</div><div class="ch tk"><svg viewBox="0 0 ' + CW + ' ' + CH + '" preserveAspectRatio="none" role="img" aria-label="Tokens per day, top 3 models">'
        + '<line class="base" x1="0" x2="' + CW + '" y1="' + CH + '" y2="' + CH + '"/>' + lines + '</svg>'
        + '<div class="ax"><span>' + esc(t.days[0].date) + '</span><span>peak ' + big(max) + '</span><span>' + esc(t.days[t.days.length - 1].date) + '</span></div>'
        + '<div class="lgd">' + t.models.map((m, k) => '<span><i class="sw m' + k + '"></i>' + esc(m) + '</span>').join('') + '</div></div>';
}

function statsView(st, ui) {
    const s = st && st.stats;
    if (!s) return '<div class="note empty">' + (st && st.error ? 'Stats failed: ' + esc(st.error) : 'Building stats from this machine\'s Claude Code sessions…') + '</div>';
    const range = RANGES.some(([k]) => k === ui.statsRange) ? ui.statsRange : 'all', r = s[range];
    const ls = r.longestSession;
    return seg('srange', RANGES, range)
        + '<div class="note">This machine · all accounts' + (st.building ? ' · updating…' : '') + (st.error ? ' · last update failed' : '') + '</div>'
        + '<div class="grp">Activity</div><div class="hmw">' + heatmap(s.all.dailyActivity, s.meta.today) + '</div>'
        + '<div class="grp">Overview</div>'
        + kv('Favorite model', r.favoriteModel ? esc(r.favoriteModel) : '–') + kv('Total tokens', big(r.totalTokens)) + kv('Sessions', count(r.sessions))
        + kv('Longest session', ls && num(ls.ms) ? span(ls.ms) + ' <span class="d">' + esc(ls.date) + '</span>' : '–')
        + kv('Current streak', days(s.all.currentStreak)) + kv('Longest streak', days(r.longestStreak))
        + kv('Active days', count(r.activeDays) + '/' + count(r.totalDays)) + kv('Peak hour', num(r.peakHour) === null ? '–' : hh(r.peakHour) + '-' + hh((r.peakHour + 1) % 24))
        + (r.funFact ? '<div class="fun">' + esc(r.funFact) + '</div>' : '')
        + tokensChart(r.tokensPerDay)
        + (r.models.length ? '<div class="grp">Models</div>' + r.models.map((m) => kv(esc(m.model), 'In ' + big(m.inputTokens) + ' · Out ' + big(m.outputTokens))).join('') : '');
}

// The view switcher at the top, like Claude Code's own Day / Week toggle.
const VIEWS = [['accounts', 'Accounts'], ['history', 'History'], ['stats', 'Stats']];
const viewOf = (ui) => (VIEWS.some(([k]) => k === ui.view) ? ui.view : 'accounts');
// The reload button sits at the end of the switcher row. It spins while the host runs a fetch (busy).
const reload = (busy) => '<button class="rl' + (busy ? ' spin' : '') + '" data-a="reload" title="' + (busy ? 'Refreshing…' : 'Refresh usage now')
    + '" aria-label="Refresh usage" aria-busy="' + !!busy + '">' + ci('refresh') + '</button>';
function render(d, ui, st, busy) {
    CHARTS = [];
    const view = viewOf(ui);
    return '<div class="vbar">' + seg('view', VIEWS, view) + reload(busy) + '</div>' + (view === 'history' ? historyView(d, ui) : view === 'stats' ? statsView(st, ui) : accountsView(d, ui));
}

function accountsView(d, ui) {
    const activeOpen = ui.activeOpen !== false, nextOpen = ui.nextOpen !== false, open = ui.accountsOpen !== false;
    const health = d.loginHealth === 'unknown' ? ' title="ccswitch could not check logins, so none is marked re-login"' : '';
    const n = d.installed ? d.counts.saved + ' saved' : d.counts.total + (d.counts.total === 1 ? ' account' : ' accounts');
    return section('active', 'Active account', activeOpen)
        + (activeOpen ? active(d.active) : '')
        + section('next', 'If you run out', nextOpen) + (nextOpen ? nextLine(d) : '')
        + section('accounts', 'Accounts', open, '<span class="r">' + n + '</span>', health)
        + (open ? '<div class="rows">' + d.rows.map((r) => row(r, r.label === ui.openRow)).join('')
            + (d.installed ? '<div class="row add" data-a="add" role="button" tabindex="0" title="Log in to another account and save it (ccswitch add)">'
                + ci('add') + '<span class="nm">Add account</span></div>' : '') + '</div>' : '')
        + (d.installed ? automation(d, ui) : '');
}

if (typeof acquireVsCodeApi === 'function') {
    const vsc = acquireVsCodeApi();
    const ui = Object.assign({ activeOpen: true, nextOpen: true, accountsOpen: true, automationOpen: false, openRow: null }, vsc.getState() || {});
    const root = document.getElementById('root');
    let data = null, stats = null, busy = false;
    const paint = () => {
        if (!data) return;
        const f = document.activeElement, keep = f && f.dataset && f.dataset.a ? [f.dataset.a, f.dataset.l] : null;
        root.innerHTML = render(data, ui, stats, busy);
        const ic = busy && root.querySelector('.rl.spin .codicon');
        if (ic) ic.style.animationDelay = -(Date.now() % 1000) + 'ms';  // the new icon joins the turn at the phase the old one had (1 s period), so a repaint does not jump it back
        if (keep) {  // a repaint (every poll) must not drop keyboard focus
            const again = [...root.querySelectorAll('[data-a]')].find((el) => el.dataset.a === keep[0] && el.dataset.l === keep[1]);
            if (again) again.focus();
        }
    };
    const SECTIONS = { active: 'activeOpen', next: 'nextOpen', accounts: 'accountsOpen', automation: 'automationOpen' };
    const act = (el) => {
        const a = el.dataset.a, l = el.dataset.l;
        if (a === 'reload') return busy ? undefined : vsc.postMessage({ refresh: 1 });  // the host sends busy back; one fetch at a time
        if (SECTIONS[a]) ui[SECTIONS[a]] = !ui[SECTIONS[a]];
        else if (a === 'row') ui.openRow = ui.openRow === l ? null : l;
        else if (a === 'view') { ui.view = l; vsc.postMessage({ wantHistory: l === 'history' }); if (l === 'stats') vsc.postMessage({ wantStats: 1 }); }
        else if (a === 'srange') ui.statsRange = l;
        else if (a === 'hlay') ui.histLayout = l;
        else if (a === 'hrange') { ui.histRange = l; vsc.postMessage({ histRange: l }); }  // the host sends the series for that span
        else if (a === 'hrow') ui.histOpen = histOpenLabel(data, ui) === l ? null : l;
        else if (a === 'switch' || a === 'relogin') return vsc.postMessage({ seat: l });  // switchSeat routes re-login to enrol
        else if (a === 'add') return vsc.postMessage({ add: 1 });
        else if (a === 'save') return vsc.postMessage({ save: l });
        else if (a === 'delete') return vsc.postMessage({ del: l });
        else if (a === 'auto') return vsc.postMessage({ toggleAuto: 1 });
        else if (a === 'install') return vsc.postMessage({ installCc: 1 });
        vsc.setState(ui);
        paint();
    };
    root.addEventListener('click', (ev) => { const el = ev.target.closest('[data-a]'); if (el) act(el); });
    root.addEventListener('keydown', (ev) => {
        if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[role="button"][data-a]')) { ev.preventDefault(); act(ev.target); }
    });
    // History hover: a guide line and a tooltip follow the pointer (mouse, pen and touch). No keyboard path: the % and
    // the pace line stay printed under each chart. Text goes in with textContent; no inline handlers (the CSP).
    const clearHover = () => root.querySelectorAll('.ch.hov').forEach((c) => c.classList.remove('hov'));
    root.addEventListener('pointermove', (ev) => {
        const svg = ev.target.closest && ev.target.closest('svg[data-cid]'), spec = svg && CHARTS[+svg.dataset.cid];
        clearHover();
        if (!spec) return;
        const r = svg.getBoundingClientRect(), f = Math.max(0, Math.min(1, (ev.clientX - r.left) / (r.width || 1)));
        const h = hoverAt(spec, spec.from + f * (spec.to - spec.from));
        if (!h) return;
        const ch = svg.closest('.ch'), tip = ch.querySelector('.tip'), box = ch.getBoundingClientRect();
        svg.querySelector('.gl').setAttribute('x1', f * CW); svg.querySelector('.gl').setAttribute('x2', f * CW);
        tip.textContent = h.when + '\n' + h.pct + ' \u00b7 ' + h.rate;
        ch.classList.add('hov');
        tip.style.left = Math.max(0, Math.min(box.width - tip.offsetWidth, r.left - box.left + f * r.width - tip.offsetWidth / 2)) + 'px';
        tip.style.top = Math.max(0, svg.offsetTop - tip.offsetHeight - 2) + 'px';
    });
    root.addEventListener('pointerleave', clearHover);
    window.addEventListener('message', (ev) => {
        if (ev.data && ev.data.kind === 'busy') busy = ev.data.on === true;
        else if (ev.data && ev.data.kind === 'stats') stats = ev.data;
        else { data = ev.data; if (viewOf(ui) === 'stats') vsc.postMessage({ wantStats: 1 }); }  // the host rebuilds at most every 10 min
        paint();
    });
    vsc.postMessage({ wantHistory: viewOf(ui) === 'history', histRange: histRangeOf(ui) });
    vsc.postMessage('ready');
}
