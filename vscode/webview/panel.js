// Sidebar panel, in the style of Claude Code's own "Account & Usage" view. render(data, ui) turns a panelData() result
// (extension.js) into HTML; it is pure so the tests can call it. Every label, email and reset text goes through esc(),
// which extension.js inlines before this script. Icons are codicons (vendored font). The bootstrap at the end runs
// only inside a VS Code webview.

const ICON = { active: 'circle-filled', relogin: 'warning', full: 'circle-slash', switch: 'arrow-swap' };
const ACTION = { switch: 'Switch', save: 'Save login', relogin: 'How to re-login', delete: 'Delete' };
const ACTION_TIP = { save: 'Save your current login under this name (ccswitch save)', delete: 'Delete the saved login (ccswitch delete)' };

const pctText = (p) => (p == null ? '–' : p + '%');
const ci = (name, cls = '', tip = '') => '<span class="codicon codicon-' + name + (cls ? ' ' + cls : '') + '"'
    + (tip ? ' title="' + esc(tip) + '" role="img" aria-label="' + esc(tip) + '"' : ' aria-hidden="true"') + '></span>';
const kv = (k, v) => '<div class="kv"><span class="k">' + k + '</span><span class="v">' + v + '</span></div>';

// A section header: chevron + title (the toggle), then grey text or a link on the right.
function section(key, title, open, right = '', extra = '') {
    return '<div class="sec"><div class="hd" data-a="' + key + '" role="button" tabindex="0" aria-expanded="' + open + '"' + extra + '>'
        + ci(open ? 'chevron-down' : 'chevron-right') + '<span class="t">' + title + '</span></div>' + right + '</div>';
}

function usage(name, cls, p, reset) {
    return '<div class="use"><div class="top"><span>' + name + '</span><span class="p">' + pctText(p) + '</span></div>'
        + '<div class="bar ' + cls + '">' + (p == null ? '' : '<i style="width:' + Math.max(0, Math.min(100, p)) + '%"></i>') + '</div>'
        + (reset ? '<div class="rs">Resets ' + esc(reset) + '</div>' : '') + '</div>';
}

function active(a) {
    if (!a) return '<div class="kv"><span class="k">Not logged in to Claude Code</span></div>';
    return '<div class="grp">Account</div>' + kv('Nickname', esc(a.label)) + (a.email ? kv('Email', esc(a.email)) : '')
        + (a.age ? kv('Last data', esc(a.age)) : '')
        + '<div class="grp">Usage</div>' + usage('Session (5hr)', 's', a.five, a.fiveReset) + usage('Weekly (7 day)', 'w', a.week, a.weekReset);
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
        + (r.age ? kv('Last data', esc(r.age))
            : kv('Session (5hr)', use(r.five, r.fiveReset)) + kv('Weekly (7 day)', use(r.week, r.weekReset)))
        + (r.actions.length ? '<div class="acts">' + r.actions.map((a) => '<button class="lnk" data-a="' + a + '" data-l="' + l + '"'
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

function render(d, ui) {
    const activeOpen = ui.activeOpen !== false, nextOpen = ui.nextOpen !== false, open = ui.accountsOpen !== false;
    const health = d.loginHealth === 'unknown' ? ' title="ccswitch could not check logins, so none is marked re-login"' : '';
    const n = d.installed ? d.counts.saved + ' saved' : d.counts.total + (d.counts.total === 1 ? ' account' : ' accounts');
    return section('active', 'Active account', activeOpen, '<button class="lnk" data-a="details" title="Open claude.ai/settings/usage">View details</button>')
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
    let data = null;
    const paint = () => {
        if (!data) return;
        const f = document.activeElement, keep = f && f.dataset && f.dataset.a ? [f.dataset.a, f.dataset.l] : null;
        root.innerHTML = render(data, ui);
        if (keep) {  // a repaint (every poll) must not drop keyboard focus
            const again = [...root.querySelectorAll('[data-a]')].find((el) => el.dataset.a === keep[0] && el.dataset.l === keep[1]);
            if (again) again.focus();
        }
    };
    const SECTIONS = { active: 'activeOpen', next: 'nextOpen', accounts: 'accountsOpen', automation: 'automationOpen' };
    const act = (el) => {
        const a = el.dataset.a, l = el.dataset.l;
        if (SECTIONS[a]) ui[SECTIONS[a]] = !ui[SECTIONS[a]];
        else if (a === 'row') ui.openRow = ui.openRow === l ? null : l;
        else if (a === 'switch' || a === 'relogin') return vsc.postMessage({ seat: l });  // switchSeat routes re-login to enrol
        else if (a === 'save') return vsc.postMessage({ save: l });
        else if (a === 'delete') return vsc.postMessage({ del: l });
        else if (a === 'auto') return vsc.postMessage({ toggleAuto: 1 });
        else if (a === 'install') return vsc.postMessage({ installCc: 1 });
        else if (a === 'details') return vsc.postMessage({ openUsage: 1 });
        vsc.setState(ui);
        paint();
    };
    root.addEventListener('click', (ev) => { const el = ev.target.closest('[data-a]'); if (el) act(el); });
    root.addEventListener('keydown', (ev) => {
        if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[role="button"][data-a]')) { ev.preventDefault(); act(ev.target); }
    });
    window.addEventListener('message', (ev) => { data = ev.data; paint(); });
    vsc.postMessage('ready');
}
