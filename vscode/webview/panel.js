// Sidebar panel (layout A). render(data, ui) turns a panelData() result (extension.js) into HTML; it is pure so the
// tests can call it. Every label, email and reset text goes through esc(), which extension.js inlines before this
// script. The bootstrap at the end runs only inside a VS Code webview.

const BAR_CLASS = (p) => (p > 85 ? 'r' : p > 59 ? 'y' : 'g');  // ccswitch's bands: green to 59%, amber to 85%, red above
const ICON = { active: '●', relogin: '⚠', full: '⛔', switch: '⇄', '': '' };
const TRASH = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M6 1h4a1 1 0 0 1 1 1v1h3v1.5H2V3h3V2a1 1 0 0 1 1-1zm0 2h4V2.5H6zM3.5 6h9l-.7 8.1A1 1 0 0 1 10.8 15H5.2a1 1 0 0 1-1-.9zm2.6 1.5.3 6h1.2l-.2-6zm2.5 0-.2 6h1.2l.3-6z"/></svg>';

const pctText = (p) => (p == null ? '–' : p + '%');
const track = (p) => '<div class="trk">' + (p == null ? '' : '<i class="' + BAR_CLASS(p) + '" style="width:' + Math.max(0, Math.min(100, p)) + '%"></i>') + '</div>';

function heroBar(key, p, reset) {
    return '<div class="brow"><span class="k">' + key + '</span>' + track(p) + '<span class="p">' + pctText(p) + '</span>'
        + (reset ? '<span class="rst">' + esc(reset) + '</span>' : '') + '</div>';
}

function hero(a) {
    if (!a) return '<div class="hero"><div class="dim">Not logged in to Claude Code</div></div>';
    return '<div class="hero"><div class="name"><span class="ico i-active" title="Active account">●</span>' + esc(a.label) + '</div>'
        + heroBar('5h', a.five, a.fiveReset) + heroBar('wk', a.week, a.weekReset)
        + (a.age ? '<div class="age">◷ ' + esc(a.age) + '</div>' : '') + '</div>';
}

function nextLine(d) {
    if (!d.installed) {
        return '<div class="next"><div class="lbl">Switching needs ccswitch</div>'
            + '<button class="btn" data-a="install">Install ccswitch</button></div>';
    }
    if (!d.next) return '<div class="next"><div><div class="lbl">If you run out</div>No account to switch to</div></div>';
    const n = d.next;
    return '<div class="next"><span class="ico i-switch">⇄</span><div><div class="lbl">If you run out</div><b>' + esc(n.label)
        + '</b> <span class="lbl">5h ' + pctText(n.five) + ' · wk ' + pctText(n.week) + '</span></div>'
        + '<button class="btn" data-a="switch" data-l="' + esc(n.label) + '">Switch</button></div>';
}

function countsText(c) {
    return c.total + (c.relogin ? ' · ' + c.relogin + ' ⚠' : '') + (c.full ? ' · ' + c.full + ' ⛔' : '');
}

const ACTION = {
    switch: (l) => '<button class="btn2" data-a="switch" data-l="' + l + '">⇄ Switch</button>',
    relogin: (l) => '<button class="btn2" data-a="relogin" data-l="' + l + '">⚠ Re-login help</button>',
    save: (l) => '<button class="btn" data-a="save" data-l="' + l + '" title="Save your current login under this name (ccswitch save)">Save login</button>',
    delete: (l) => '<button class="btn2 del" data-a="delete" data-l="' + l + '" title="Delete the saved login (ccswitch delete)" aria-label="Delete the saved login">' + TRASH + '</button>',
};

function row(r, open) {
    const l = esc(r.label);
    const body = r.icon === 'relogin'
        ? '<div class="note">re-login' + (r.age ? ' · ' + esc(r.age) : '') + '</div>'
        : '<div class="mini">' + track(r.five) + track(r.week) + '</div>';
    let html = '<div class="row' + (open ? ' open' : '') + (r.age ? ' muted' : '') + '" data-a="row" data-l="' + l
        + '" role="button" tabindex="0" aria-expanded="' + open + '">'
        + '<span class="ico i-' + (r.icon || 'none') + '"' + (r.tip ? ' title="' + esc(r.tip) + '"' : '') + '>' + ICON[r.icon] + '</span>'
        + '<span class="nm">' + l + '</span>' + body + '<span class="chev">' + (open ? '⌄' : '›') + '</span></div>';
    if (!open) return html;
    const resets = [r.fiveReset && '5h ' + esc(r.fiveReset), r.weekReset && 'wk ' + esc(r.weekReset)].filter(Boolean).join(' · ');
    html += '<div class="det">'
        + (r.email ? '<div>✉ <b>' + esc(r.email) + '</b></div>' : '')
        + '<div>5h ' + pctText(r.five) + ' · wk ' + pctText(r.week) + '</div>'
        + (resets ? '<div>' + resets + '</div>' : '')
        + (r.age ? '<div>◷ ' + esc(r.age) + '</div>' : '')
        + (r.actions.length ? '<div class="acts">' + r.actions.map((a) => ACTION[a](l)).join('') + '</div>' : '')
        + '</div>';
    return html;
}

// Collapsed by default: the one switch that acts without you watching. The line stays visible when open so touch and
// keyboard users can read it (the tooltip is not reachable for them).
function automation(d, ui) {
    const open = ui.automationOpen === true;
    return '<div class="sec tog" data-a="automation" role="button" tabindex="0" aria-expanded="' + open + '">'
        + '<span class="chev">' + (open ? '▾' : '▸') + '</span>⚠ Automation<span class="n">' + (d.auto ? 'on' : 'off') + '</span></div>'
        + (open ? '<div class="auto"><div class="lbl">Switches at 100%. Asks once, when you turn it on.</div><div class="tgrow"><span>Auto-switch</span>'
            + '<button class="tg' + (d.auto ? ' on' : '') + '" data-a="auto" role="switch" aria-checked="' + !!d.auto + '" aria-label="Auto-switch"'
            + ' title="When the active account reaches 100%, switch to the next-best account (fresh data, working login, at most once per 10 min), without asking. Restart open Claude Code tabs to use it."></button></div></div>' : '');
}

function render(d, ui) {
    const open = ui.accountsOpen !== false;
    const health = d.loginHealth === 'unknown' ? ' title="ccswitch could not check logins, so none is marked re-login"' : '';
    return '<div class="sec">Active account</div>' + hero(d.active) + nextLine(d)
        + '<div class="sec tog" data-a="accounts" role="button" tabindex="0" aria-expanded="' + open + '"' + health + '>'
        + '<span class="chev">' + (open ? '▾' : '▸') + '</span>Accounts<span class="n">' + countsText(d.counts) + '</span></div>'
        + (open ? '<div class="rows">' + d.rows.map((r) => row(r, r.label === ui.openRow)).join('') + '</div>' : '')
        + (d.installed ? automation(d, ui) : '');
}

if (typeof acquireVsCodeApi === 'function') {
    const vsc = acquireVsCodeApi();
    const ui = Object.assign({ accountsOpen: true, automationOpen: false, openRow: null }, vsc.getState() || {});
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
    const act = (el) => {
        const a = el.dataset.a, l = el.dataset.l;
        if (a === 'accounts') ui.accountsOpen = !ui.accountsOpen;
        else if (a === 'automation') ui.automationOpen = !ui.automationOpen;
        else if (a === 'row') ui.openRow = ui.openRow === l ? null : l;
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
    window.addEventListener('message', (ev) => { data = ev.data; paint(); });
    vsc.postMessage('ready');
}
