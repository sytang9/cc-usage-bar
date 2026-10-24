// Unit tests for vscode/extension.js, moving section by section into tests/vscode/ (see tests/vscode/harness.js).
'use strict';
const {
    assert, fs, path, HOME, LOG, now, check, run, seat, ccswitch, usageReply, usageDoc, cfg, said, stub, vscode,
    fakeWebview, file, load, e, memento, calls, acct, capOf, pdFour, readWv, panel, ui,
} = require('./vscode/harness');

run(async () => {
    // --- status bar text ---------------------------------------------------------------------------------
    const sb = (a, you, relogin = [], over = {}) => ({ ...capOf(a, you, relogin), ...over });
    const sbAcc = () => [acct('work', 100, 40, now - 60), acct('personal', 10, 5, now - 30)];

    await check('statusText: active and next-best', () => {
        const a = sbAcc();
        assert.strictEqual(e.statusText(sb(a, 'work'), a, false), '● work 100%/40% · ⇄ personal');
    });

    await check('statusText: a Codex row with the active label never shows as your numbers', () => {
        // A saved Claude account may be named codex; its own row is the one the status bar reads.
        const a = [{ ...acct('codex', 77, 66, now - 60), provider: 'codex' }, acct('codex', 20, 30, now - 60), acct('personal', 10, 5, now - 30)];
        assert.ok(e.statusText(sb(a, 'codex'), a, false).startsWith('● codex 20%/30%'));
    });

    await check('statusText: nothing qualifies (Review Focus 1)', () => {
        const a = [acct('work', 100, 40, now - 60), acct('old', 5, 5, now - 7200), acct('dead', 5, 5, now - 60)];
        const t = e.statusText(sb(a, 'work', ['dead']), a, false);
        assert.ok(t.endsWith('· ⇄ none'), t);
        assert.ok(!/free/.test(t), 'stale and dead accounts are not counted as free');
    });

    await check('statusText: stale active data and auto on', () => {
        const a = [acct('work', 100, 40, now - 7200), acct('personal', 10, 5, now - 30)];
        const t = e.statusText(sb(a, 'work'), a, true);
        assert.ok(t.startsWith('$(sync) ● work'), t);
        assert.ok(t.includes('100%/40% ◷'), t);
    });

    await check('statusText: no active account, and a missing window', () => {
        const a = sbAcc();
        assert.strictEqual(e.statusText(sb(a, null), a, false), '● none');
        assert.strictEqual(e.statusText(sb(a, null), a, true), '$(sync) ● none');
        const h = [acct('half', null, 30, now - 60)];
        assert.strictEqual(e.statusText(sb(h, 'half'), h, false), '● half –/30% · ⇄ none');
    });

    await check('statusText: an active account with no data at all', () => {
        const a = sbAcc();
        const t = e.statusText(sb(a, 'ghost'), a, false);  // not saved, no row
        assert.strictEqual(t, '● ghost –/– ◷ · ⇄ personal');
    });

    await check('statusTooltip lists every account', () => {
        const a = [...sbAcc(), acct('old', 5, 5, now - 7200), acct('dead', 5, 5, now - 13 * 86400)];
        const tip = e.statusTooltip(sb(a, 'work', ['dead']), a, false);
        const lines = tip.split('\n');
        assert.strictEqual(lines.length, a.length + 1);
        assert.strictEqual(lines[0], 'Auto-switch: off');
        assert.strictEqual(lines[1], 'work: 5h 100%, wk 40% · active');
        assert.strictEqual(lines[2], 'personal: 5h 10%, wk 5%');
        assert.strictEqual(lines[3], 'old: 5h 5%, wk 5% · data 2h old');
        assert.strictEqual(lines[4], 'dead: 5h 5%, wk 5% · re-login · data 13d old');
        assert.strictEqual(e.statusTooltip(sb(a, 'work'), a, true).split('\n')[0], 'Auto-switch: ON');
    });

    await check('statusTooltip says the truth about the active account\'s data (fresh, stale, none)', () => {
        const a = [acct('work', 100, 40, now - 60), acct('old', 5, 5, now - 7200)];
        assert.strictEqual(e.statusTooltip(sb(a, 'work'), a, false).split('\n')[1], 'work: 5h 100%, wk 40% · active', 'fresh active: no age claim');
        assert.ok(e.statusTooltip(sb(a, 'old'), a, false).includes('old: 5h 5%, wk 5% · data 2h old · active'));
        const ghost = e.statusTooltip(sb(a, 'ghost'), a, false);  // active, unsaved, in no list
        assert.strictEqual(ghost.split('\n').length, a.length + 2);
        assert.ok(ghost.includes('ghost: 5h –, wk – · no data · active'), ghost);
        assert.ok(!/over 30 min/.test(fs.readFileSync(file, 'utf8')), 'the old unconditional claim is gone');
    });

    await check('the vendored popup is gone', () => {
        assert.ok(!fs.existsSync(path.join(__dirname, '..', 'vscode', 'ui')));
    });

    await check('dialog texts name what the terminal runs: ccswitch add, no SAVE card', () => {
        const src = fs.readFileSync(file, 'utf8');
        assert.ok(!/\bSAVE\b/.test(src), 'no SAVE button any more');
        assert.ok(!/\bcard\b/.test(src), 'no cards any more');
        assert.match(src, /runs ccswitch add \$\{label\}/);
        assert.ok(!/type \/login/.test(src), 'enroll no longer asks for /login');
    });

    await check('switch texts agree with ccswitch: open Claude Code tabs need a restart', () => {
        const src = fs.readFileSync(file, 'utf8');
        assert.ok(!/carry on as the new seat/.test(src), 'no hot-swap claim');
        assert.match(src, /restart open Claude Code tabs/i);
    });

    await check('a failed settings write shows an error message instead of vanishing', async () => {
        const realUpdate = vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration = () => ({ get: (k) => cfg[k], update: async () => { throw new Error('settings.json is read-only'); } });
        said.length = 0;
        try { await e.changeAutoSwitch(false); } finally { vscode.workspace.getConfiguration = realUpdate; }
        assert.deepStrictEqual(said, ['ERROR Could not change auto-switch: settings.json is read-only']);
    });

    await check('reload button: the codicon refresh icon is in the panel; it spins only when busy; reduced motion stops the rotation', () => {
        const p = panel(), idle = p.render(pdFour(), ui()), busy = p.render(pdFour(), ui(), null, true);
        assert.match(idle, /<button class="rl" data-a="reload"[^>]*aria-busy="false"><span class="codicon codicon-refresh"/);
        assert.match(busy, /<button class="rl spin" data-a="reload"[^>]*aria-busy="true"/);
        const css = readWv('panel.css');
        assert.match(css, /\.rl\.spin \.codicon \{ animation: rl-spin/);
        assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.rl\.spin \.codicon \{ animation: none/);
    });

    await check('reload button: spin is set by a click and by the timed fetch, not by the 60 s poll; it clears on success and on failure; a second click runs no second fetch', async () => {
        const posted = [], timers = [], ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(HOME, 'gs') }, globalState: memento(false) };
        let provider, onMsg;
        const keep = { win: { ...vscode.window }, commands: vscode.commands, ws: vscode.workspace.onDidChangeConfiguration, st: global.setTimeout, si: global.setInterval };
        Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: (id, pr) => { provider = pr; return { dispose() {} }; } });
        vscode.StatusBarAlignment = { Right: 2 };
        vscode.commands = { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} };
        vscode.extensions = { getExtension: () => undefined };
        vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} });
        global.setTimeout = (f, ms, ...a) => (ms === 30000 || ms === 600000 ? (timers.push([ms, f]), 0) : keep.st(f, ms, ...a));  // capture the app's timers, keep the rest real
        global.setInterval = (f, ms) => { timers.push([ms, f]); return 0; };
        const fetches = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '').split('\n').filter((l) => l.startsWith('usage --json')).length;
        const busyOf = () => posted.filter((m) => m.kind === 'busy').map((m) => m.on);
        const idle = async () => { for (let i = 0; i < 200 && busyOf().length % 2; i++) await new Promise((r) => keep.st(r, 25)); };
        try {
            usageReply(usageDoc({ work: 'ok' }));
            load().activate(ctx);
            global.setTimeout = keep.st; global.setInterval = keep.si;
            const v = { visible: true, onDidChangeVisibility: () => {}, onDidDispose: () => {},
                webview: { ...fakeWebview, postMessage: async (m) => { posted.push(m); }, onDidReceiveMessage: (f) => { onMsg = f; } } };
            provider.resolveWebviewView(v);
            const poll = timers.find(([ms]) => ms === 60000)[1], timed = timers.filter(([ms]) => ms === 600000 || ms === 30000).map(([, f]) => f);
            assert.strictEqual(timed.length, 2, 'the 30 s first check and the 10 min check');
            poll(); await idle();
            assert.deepStrictEqual(busyOf(), [], 'the 60 s cache re-read never spins');
            const n0 = fetches();
            onMsg({ refresh: 1 }); onMsg({ refresh: 1 });  // a second click while the first fetch runs
            assert.deepStrictEqual(busyOf(), [true], 'a click sets the spin at once');
            await idle();
            assert.deepStrictEqual(busyOf(), [true, false], 'success clears the spin');
            assert.strictEqual(fetches() - n0, 1, 'the second click ran no second fetch');
            posted.length = 0;
            timed[1](); assert.deepStrictEqual(busyOf(), [true], 'the 10 min fetch spins');
            await idle(); assert.deepStrictEqual(busyOf(), [true, false]);
            posted.length = 0;
            timed[0](); assert.deepStrictEqual(busyOf(), [true], 'the 30 s first check spins');
            await idle();
            posted.length = 0;
            usageReply('not json', 1);  // a failed fetch
            onMsg({ refresh: 1 }); assert.deepStrictEqual(busyOf(), [true]);
            await idle(); assert.deepStrictEqual(busyOf(), [true, false], 'failure clears the spin');
            onMsg({ refresh: 1 }); await idle();
            assert.strictEqual(fetches() - n0, 5, 'after the fetch ends, a click fetches again');
        } finally {
            global.setTimeout = keep.st; global.setInterval = keep.si;
            Object.assign(vscode.window, keep.win);
            vscode.commands = keep.commands;
            vscode.workspace.onDidChangeConfiguration = keep.ws;
            usageReply('');
            for (const d of ctx.subscriptions) if (d && d.dispose) d.dispose();
        }
    });

    await check('reload: the Refresh command runs the guarded fetch with the spin; a rejecting fetch clears it; a seat switch runs no second fetch', async () => {
        const posted = [], cmds = {}, ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(HOME, 'gs') }, globalState: memento(false) };
        let provider, onMsg;
        const keep = { win: { ...vscode.window }, commands: vscode.commands, ws: vscode.workspace.onDidChangeConfiguration, exists: fs.existsSync };
        Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: (id, pr) => { provider = pr; return { dispose() {} }; } });
        vscode.StatusBarAlignment = { Right: 2 };
        vscode.commands = { registerCommand: (id, f) => { cmds[id] = f; return { dispose() {} }; }, executeCommand: async () => {} };
        vscode.extensions = { getExtension: () => undefined };
        vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} });
        const fetches = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '').split('\n').filter((l) => l.startsWith('usage --json')).length;
        const busyOf = () => posted.filter((m) => m.kind === 'busy').map((m) => m.on);
        const idle = async () => { for (let i = 0; i < 200 && busyOf().length % 2; i++) await new Promise((r) => setTimeout(r, 25)); };
        try {
            usageReply(usageDoc({ work: 'ok' }));
            const x = load();  // the instance that is activated is the one whose guard the switch must share
            x.activate(ctx);
            provider.resolveWebviewView({ visible: true, onDidChangeVisibility: () => {}, onDidDispose: () => {},
                webview: { ...fakeWebview, postMessage: async (m) => { posted.push(m); }, onDidReceiveMessage: (f) => { onMsg = f; } } });
            await idle();
            const n0 = fetches();
            cmds['claudeUsage.refresh'](); cmds['claudeUsage.refresh']();
            assert.deepStrictEqual(busyOf(), [true], 'the command spins at once, once');
            await idle();
            assert.deepStrictEqual(busyOf(), [true, false]);
            assert.strictEqual(fetches() - n0, 1, 'the command ran one real fetch');
            // #5: a seat switch to an expired seat (it syncs tokens first) while a fetch runs joins that fetch
            x.relogin.add('personal'); stub.answer = 'Open terminal'; posted.length = 0;
            const n1 = fetches();
            onMsg({ refresh: 1 });
            await x.switchSeat('personal', () => {});
            await idle();
            assert.strictEqual(fetches() - n1, 1, 'the switch ran no second `ccswitch usage --json`');
            // #2: checkLogins rejects (not just a bad reply): the spin still clears
            posted.length = 0;
            fs.existsSync = (f) => { if (f === path.join(HOME, '.claude', 'ccswitch')) throw new Error('boom'); return keep.exists(f); };
            onMsg({ refresh: 1 });
            assert.deepStrictEqual(busyOf(), [true]);
            await idle();
            assert.deepStrictEqual(busyOf(), [true, false], 'a rejecting fetch clears the spin');
            fs.existsSync = keep.exists;
            onMsg({ refresh: 1 }); await idle();
            assert.deepStrictEqual(busyOf(), [true, false, true, false], 'after a rejection, the next click fetches again');
        } finally {
            fs.existsSync = keep.exists;
            Object.assign(vscode.window, keep.win);
            vscode.commands = keep.commands;
            vscode.workspace.onDidChangeConfiguration = keep.ws;
            usageReply('');
            for (const d of ctx.subscriptions) if (d && d.dispose) d.dispose();
        }
    });

    await check('reload: a click or the Refresh command runs `usage --json --refresh` at most once per 60 s; timers and other fetches never bypass the cache (review finding)', async () => {
        const posted = [], timers = [], cmds = {}, ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(HOME, 'gs') }, globalState: memento(false) };
        let provider, onMsg;
        const keep = { win: { ...vscode.window }, commands: vscode.commands, ws: vscode.workspace.onDidChangeConfiguration, st: global.setTimeout, si: global.setInterval, now: Date.now };
        Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: (id, pr) => { provider = pr; return { dispose() {} }; } });
        vscode.StatusBarAlignment = { Right: 2 };
        vscode.commands = { registerCommand: (id, f) => { cmds[id] = f; return { dispose() {} }; }, executeCommand: async () => {} };
        vscode.extensions = { getExtension: () => undefined };
        vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} });
        global.setTimeout = (f, ms, ...a) => (ms === 30000 || ms === 600000 ? (timers.push([ms, f]), 0) : keep.st(f, ms, ...a));
        global.setInterval = (f, ms) => { timers.push([ms, f]); return 0; };
        const busyOf = () => posted.filter((m) => m.kind === 'busy').map((m) => m.on);
        const idle = async () => { for (let i = 0; i < 200 && busyOf().length % 2; i++) await new Promise((r) => keep.st(r, 25)); };
        const lastFetch = () => calls().filter((c) => c.startsWith('usage')).pop();
        try {
            usageReply(usageDoc({ work: 'ok' }));
            load().activate(ctx);
            global.setTimeout = keep.st; global.setInterval = keep.si;
            provider.resolveWebviewView({ visible: true, onDidChangeVisibility: () => {}, onDidDispose: () => {},
                webview: { ...fakeWebview, postMessage: async (m) => { posted.push(m); }, onDidReceiveMessage: (f) => { onMsg = f; } } });
            const timed = timers.filter(([ms]) => ms === 600000).map(([, f]) => f)[0];
            onMsg({ refresh: 1 }); await idle();
            assert.strictEqual(lastFetch(), 'usage --json --refresh', 'a click asks ccswitch for live numbers');
            onMsg({ refresh: 1 }); await idle();
            assert.strictEqual(lastFetch(), 'usage --json', 'a second click within 60 s reads the cache');
            cmds['claudeUsage.refresh'](); await idle();
            assert.strictEqual(lastFetch(), 'usage --json', 'the command shares the same 60 s limit');
            Date.now = () => keep.now() + 61 * 1000;
            timed(); await idle();
            assert.strictEqual(lastFetch(), 'usage --json', 'the 10-min timer never bypasses the cache');
            cmds['claudeUsage.refresh'](); await idle();
            assert.strictEqual(lastFetch(), 'usage --json --refresh', 'after 60 s a manual refresh is live again');
        } finally {
            Date.now = keep.now;
            global.setTimeout = keep.st; global.setInterval = keep.si;
            Object.assign(vscode.window, keep.win); vscode.commands = keep.commands; vscode.workspace.onDidChangeConfiguration = keep.ws;
            usageReply('');
            for (const d of ctx.subscriptions) if (d && d.dispose) d.dispose();
        }
    });

    await check('reload (webview): idle click posts {refresh:1}; busy click posts nothing; busy toggles the spin; the spin survives a repaint and keeps its phase', () => {
        let T = 5250, onMessage, onClick;
        const sent = [], icon = { style: {} };
        const root = { innerHTML: '', addEventListener: (t, f) => { if (t === 'click') onClick = f; },
            querySelector: () => (/class="rl spin"/.test(root.innerHTML) ? icon : null), querySelectorAll: () => [] };
        const ctx = { esc: e.esc, document: { getElementById: () => root, activeElement: null },
            window: { addEventListener: (t, f) => { if (t === 'message') onMessage = f; } },
            acquireVsCodeApi: () => ({ getState: () => null, setState() {}, postMessage: (m) => sent.push(m) }), Date: { now: () => T } };
        require('vm').runInNewContext(readWv('panel.js'), ctx);
        const data = pdFour(), msg = (m) => onMessage({ data: m }), spinning = () => /class="rl spin"/.test(root.innerHTML);
        const click = () => onClick({ target: { closest: () => ({ dataset: { a: 'reload' } }) } });
        msg(data);
        sent.length = 0; click();
        assert.deepStrictEqual(JSON.parse(JSON.stringify(sent)), [{ refresh: 1 }], 'an idle click asks the host to fetch');
        assert.ok(!spinning());
        msg({ kind: 'busy', on: true });
        assert.ok(spinning(), 'busy:true starts the spin');
        assert.strictEqual(icon.style.animationDelay, '-250ms');
        sent.length = 0; click();
        assert.deepStrictEqual(sent, [], 'a click while busy posts nothing');
        T = 5750; msg(data);
        assert.ok(spinning(), 'a data repaint keeps the spin');
        assert.strictEqual(icon.style.animationDelay, '-750ms', 'the repainted icon starts at the phase the old one reached');
        msg({ kind: 'busy', on: false });
        assert.ok(!spinning(), 'busy:false stops the spin');
    });

});
