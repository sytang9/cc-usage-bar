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
const CW = 300, CH = 56;
function chart(title, pts, from, to, ago, pace, now) {
    const x = (t) => ((t - from) / (to - from) * CW).toFixed(1);
    const y = (p) => (CH - Math.max(0, Math.min(100, p)) / 100 * CH).toFixed(1);
    const runs = [];
    const newWindow = (a, b) => a !== b && !(a != null && b != null && Math.abs(a - b) <= 60);  // reset times a second apart: one window
    pts.forEach((q, i) => { const b = pts[i - 1]; if (!b || newWindow(q[2], b[2]) || q[1] < b[1]) runs.push([]); runs[runs.length - 1].push(q); });
    const svg = runs.map((run, i) => {
        const xy = run.map((q) => x(q[0]) + ',' + y(q[1]));
        if (xy.length === 1) xy.unshift(Math.max(0, x(run[0][0]) - 3).toFixed(1) + ',' + y(run[0][1]));  // a lone point: a short dash, inside the chart
        return (i ? '<line class="rz" x1="' + x(run[0][0]) + '" x2="' + x(run[0][0]) + '" y1="0" y2="' + CH + '"/>' : '')
            + '<polyline class="ln" points="' + xy.join(' ') + '"/>';
    }).join('');
    return '<div class="ch' + (now >= HIGH ? ' hi' : '') + '"><div class="top"><span>' + title + '</span><span class="p">' + pctText(now) + '</span></div>'
        + '<svg viewBox="0 0 ' + CW + ' ' + CH + '" preserveAspectRatio="none" role="img" aria-label="' + title + ', ' + pts.length + ' points">'
        + '<line class="g80" x1="0" x2="' + CW + '" y1="' + y(HIGH) + '" y2="' + y(HIGH) + '"/>'
        + '<line class="base" x1="0" x2="' + CW + '" y1="' + CH + '" y2="' + CH + '"/>' + svg + '</svg>'
        + '<div class="ax"><span>' + ago + '</span><span>now</span></div>'
        + (pace ? '<div class="rs">' + esc(pace) + '</div>' : '') + '</div>';
}

// History: one row per account with recorded points (active first, open by default); an open row shows both charts.
const histOpenLabel = (d, ui) => (ui.histOpen === undefined ? (d.history[0] || {}).label : ui.histOpen);
function historyView(d, ui) {
    if (d.team) return '<div class="note empty">History is not shown for a team usage file: ccswitch records it on each machine.</div>';
    if (!d.history || !d.history.length) {
        return '<div class="note empty">No history yet: ccswitch records a point each time it fetches (every 10-20 min while VS Code is open).</div>';
    }
    const openL = histOpenLabel(d, ui);
    return '<div class="rows">' + d.history.map((h) => {
        const l = esc(h.label), open = h.label === openL;
        return '<div class="row' + (open ? ' open' : '') + '" data-a="hrow" data-l="' + l + '" role="button" tabindex="0" aria-expanded="' + open + '">'
            + (h.icon ? ci(ICON[h.icon], 'i-' + h.icon, h.tip) : '<span class="codicon" aria-hidden="true"></span>')
            + '<span class="nm">' + l + '</span><span class="d">' + pctText(h.five) + ' · ' + pctText(h.week) + '</span>'
            + ci(open ? 'chevron-down' : 'chevron-right') + '</div>'
            + (open ? '<div class="det">' + chart('Session (5hr) · last 24h', h.fiveSeries, d.now - 86400, d.now, '24h ago', h.fivePace, h.five)
                + chart('Weekly (7 day) · last 7d', h.weekSeries, d.now - 7 * 86400, d.now, '7d ago', h.weekPace, h.week) + '</div>' : '');
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
const reload = (busy) => '<button class="rl' + (busy ? ' spin' : '') + '" data-a="reload" title="' + (busy ? 'Refreshing…' : 'Refresh usage now (ccswitch usage)')
    + '" aria-label="Refresh usage" aria-busy="' + !!busy + '">' + ci('refresh') + '</button>';
function render(d, ui, st, busy) {
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
        + (open ? '<div class="rows">' + d.rows.map((r) => row(r, r.label === ui.openRow)).join('') + '</div>' : '')
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
        else if (a === 'hrow') ui.histOpen = histOpenLabel(data, ui) === l ? null : l;
        else if (a === 'switch' || a === 'relogin') return vsc.postMessage({ seat: l });  // switchSeat routes re-login to enrol
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
    window.addEventListener('message', (ev) => {
        if (ev.data && ev.data.kind === 'busy') busy = ev.data.on === true;
        else if (ev.data && ev.data.kind === 'stats') stats = ev.data;
        else { data = ev.data; if (viewOf(ui) === 'stats') vsc.postMessage({ wantStats: 1 }); }  // the host rebuilds at most every 10 min
        paint();
    });
    vsc.postMessage({ wantHistory: viewOf(ui) === 'history' });
    vsc.postMessage('ready');
}
