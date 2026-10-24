// VS Code sidebar tests: the login check, the label rule, and switching, adding and saving a seat.
'use strict';
const {
    assert, fs, path, HOME, ACC, LOG, now, check, run, seat, ccswitch, usageReply, usageDoc, said, saidOpts, stub,
    terminals, inputOpts, vscode, fakeWebview, load, e, memento, calls,
} = require('./harness');

run(async () => {
    await check('B5 checkLogins reads usage --json: re-login marks, ok clears, unknown keeps', async () => {
        e.relogin.clear(); e.relogin.add('personal'); e.relogin.add('spare'); fs.rmSync(LOG, { force: true });
        usageReply(usageDoc({ personal: 're-login', spare: 'unknown', work: 'ok' }));
        await e.checkLogins();
        assert.deepStrictEqual([...e.relogin].sort(), ['personal', 'spare']);
        assert.deepStrictEqual(calls(), ['usage --json']);
        assert.strictEqual(e.readAccounts().cap.loginHealth, 'known');
        usageReply(usageDoc({ personal: 'ok' }));
        await e.checkLogins();
        assert.deepStrictEqual([...e.relogin], ['spare']);
    });

    await check('B5 wording does not matter: the login field decides', async () => {
        e.relogin.clear();
        usageReply({ ...usageDoc({ personal: 're-login' }), note: 'all accounts healthy, nothing needs attention' });
        await e.checkLogins();
        assert.deepStrictEqual([...e.relogin], ['personal']);
    });

    await check('mergeLogins keeps only saved labels', () => {
        const out = e.mergeLogins(new Set(['gone']), usageDoc({ personal: 're-login', ghost: 're-login' }), (l) => l !== 'gone' && l !== 'ghost');
        assert.deepStrictEqual([...out], ['personal']);
    });

    await check('old ccswitch without --json: forgets nothing, health unknown', async () => {
        e.relogin.clear(); e.relogin.add('personal');
        usageReply("Error: unknown option '--json' for 'usage'.", 1);
        await e.checkLogins();
        assert.deepStrictEqual([...e.relogin], ['personal'], 'a failed check keeps the known re-login verdicts');
        assert.strictEqual(e.readAccounts().cap.loginHealth, 'unknown');
    });

    await check('garbage on stdout is not trusted, and forgets nothing', async () => {
        e.relogin.clear(); e.relogin.add('personal');
        usageReply('warning\n{"schema":1');
        await e.checkLogins();
        assert.deepStrictEqual([...e.relogin], ['personal']);
        assert.strictEqual(e.readAccounts().cap.loginHealth, 'unknown');
        assert.deepStrictEqual([...e.mergeLogins(new Set(['personal']), null, () => true)], ['personal'], 'no document keeps the previous set');
        assert.strictEqual(e.parseUsageJson('{"schema":2,"accounts":[]}'), null);
        assert.strictEqual(e.parseUsageJson('{"schema":1,"accounts":{}}'), null);
    });

    await check('isLabel: ccswitch\'s label rule, never a leading dash', () => {
        for (const ok of ['work', 'work-2', '_x', '002']) assert.strictEqual(e.isLabel(ok), true, ok);
        for (const bad of ['-h', '--help', '../x', 'a.b', 'a b', '', 42, null, ['work']]) assert.strictEqual(e.isLabel(bad), false, String(bad));
    });

    await check('a saved folder that breaks the label rule is not an account', () => {
        seat('-h', 'h@x.example', { fetched_at: now - 60, five_hour_pct: 1, seven_day_pct: 1 });
        try { assert.ok(!e.readAccounts().accounts.some((a) => a.label === '-h')); } finally { fs.rmSync(path.join(ACC, '-h'), { recursive: true }); }
    });

    await check('switchSeat refuses anything that is not a ccswitch label', async () => {
        fs.rmSync(LOG, { force: true });
        await e.switchSeat('x; rm -rf ~', () => {});
        await e.switchSeat('../work', () => {});
        await e.switchSeat('-h', () => {});
        await e.saveSeat('-h', () => {});
        await e.deleteSeat('x; rm -rf ~', () => {});
        await e.deleteSeat('-h', () => {});
        assert.deepStrictEqual(calls(), []);
    });

    await check('switchSeat on a saved, healthy seat runs `ccswitch <label>` after confirmation', async () => {
        e.relogin.clear(); fs.rmSync(LOG, { force: true }); stub.answer = 'Switch';
        let refreshed = false;
        await e.switchSeat('personal', () => { refreshed = true; });
        assert.deepStrictEqual(calls(), ['personal']);
        assert.ok(refreshed);
    });

    await check('switchSeat on an expired seat never switches: no fetch, no claude; runs `ccswitch add <label>` in an "Add account" terminal', async () => {
        e.relogin.add('personal'); fs.rmSync(LOG, { force: true }); stub.answer = 'Open terminal'; said.length = 0; terminals.length = 0;
        await e.switchSeat('personal', () => {});
        assert.ok(!calls().includes('usage --json'), 'enroll no longer syncs tokens: ccswitch add leaves the live login alone');
        assert.ok(!calls().includes('personal'), 'never switches');
        assert.ok(!said.includes('TERMINAL claude'), 'no claude /login any more');
        assert.deepStrictEqual(said.filter((m) => m.startsWith('TERMINAL')), [`TERMINAL "${ccswitch}" add personal && exit`]);
        assert.strictEqual(terminals[0].name, 'Add account: personal');
    });

    await check('label prompt: a bad label and a reserved word are rejected; a saved one warns about overwrite; a fresh one passes', () => {
        for (const bad of ['', '-x', 'a b', 'a/b', '../x', 'a;rm']) assert.strictEqual(typeof e.labelProblem(bad), 'string', JSON.stringify(bad));
        for (const w of ['save', 'delete', 'list', 'usage', 'help', 'version', 'refresh-pause', 'refresh-resume', 'add']) {
            assert.ok(/ccswitch command/.test(e.labelProblem(w)), w);
        }
        const w = e.labelProblem('personal');
        assert.strictEqual(w.severity, 2); assert.ok(/will ask before it overwrites/.test(w.message));
        assert.strictEqual(e.labelProblem('brand-new_1'), null);
    });

    await check('+ Add account: the box validates with labelProblem; a valid label opens the terminal and sends `<ccswitch> add <label>`', async () => {
        fs.rmSync(LOG, { force: true }); said.length = 0; terminals.length = 0; inputOpts.length = 0; stub.inputAnswer = 'newone';
        await e.addAccount(() => {});
        assert.strictEqual(inputOpts[0].validateInput, e.labelProblem);
        assert.deepStrictEqual(said.filter((m) => m.startsWith('TERMINAL')), [`TERMINAL "${ccswitch}" add newone && exit`]);
        assert.strictEqual(terminals[0].name, 'Add account: newone');
        stub.inputAnswer = undefined; said.length = 0; terminals.length = 0;
        await e.addAccount(() => {});
        assert.deepStrictEqual([said, terminals], [[], []], 'cancelling the box opens nothing');
    });

    await check('an unsafe label never reaches the terminal: validateInput stops it in the box, and runAdd checks again', async () => {
        said.length = 0; terminals.length = 0;
        stub.inputAnswer = 'a;rm -rf x';
        await e.addAccount(() => {});
        assert.deepStrictEqual([said, terminals], [[], []], 'the box rejects it (the stub runs validateInput like VS Code)');
        await e.runAdd('a;rm -rf x', () => {});
        await e.runAdd('--help', () => {});
        assert.deepStrictEqual([said, terminals], [[], []], 'runAdd refuses it even if the box did not');
    });

    await check('the sidebar "+ Add account" click ({add:1}) reaches addAccount through the host route', async () => {
        const cmds = {}, ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(HOME, 'gs') }, globalState: memento(false) };
        let provider, onMsg;
        const keep = { win: { ...vscode.window }, commands: vscode.commands, ws: vscode.workspace.onDidChangeConfiguration };
        Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: (id, p) => { provider = p; return { dispose() {} }; } });
        vscode.StatusBarAlignment = { Right: 2 };
        vscode.commands = { registerCommand: (id, f) => { cmds[id] = f; return { dispose() {} }; }, executeCommand: async () => {} };
        vscode.extensions = { getExtension: () => undefined };
        vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} });
        try {
            load().activate(ctx);
            provider.resolveWebviewView({ visible: true, onDidChangeVisibility: () => {}, onDidDispose: () => {},
                webview: { ...fakeWebview, postMessage: async () => {}, onDidReceiveMessage: (f) => { onMsg = f; } } });
            stub.inputAnswer = 'viaclick'; terminals.length = 0; inputOpts.length = 0;
            onMsg({ add: 1 });
            for (let i = 0; i < 40 && !terminals.length; i++) await new Promise((r) => setTimeout(r, 50));
            assert.strictEqual(inputOpts.length, 1, 'the click asks for a label');
            assert.strictEqual(terminals[0].name, 'Add account: viaclick');
        } finally {
            Object.assign(vscode.window, keep.win); vscode.commands = keep.commands; vscode.workspace.onDidChangeConfiguration = keep.ws;
            for (const d of ctx.subscriptions) if (d && d.dispose) d.dispose();
        }
    });

    await check('the enroll dialog says to paste the code if prompted, and for an expired seat warns that ccswitch asks before overwriting', async () => {
        const detail = async (expired) => { saidOpts.length = 0; stub.answer = undefined;
            const info = vscode.window.showInformationMessage;
            vscode.window.showInformationMessage = async (m, o) => { saidOpts.push(o); };
            try { await e.switchSeat(expired ? 'personal' : 'spare2', () => {}); } finally { vscode.window.showInformationMessage = info; }
            return saidOpts[0].detail; };
        e.relogin.add('personal');
        const d1 = await detail(true), d2 = await detail(false);
        assert.ok(/paste the code if it asks/.test(d1) && /ccswitch asks before it overwrites/.test(d1), d1);
        assert.ok(/paste the code if it asks/.test(d2) && !/overwrites/.test(d2), d2);
        e.relogin.delete('personal');
    });

    await check('an old ccswitch without `add` gets the install/update offer, not a failing command', async () => {
        fs.writeFileSync(path.join(HOME, 'version.out'), 'ccswitch 1.1.0\n');
        try {
            assert.strictEqual(await e.ccswitchHasAdd(), false);
            stub.answer = 'Open terminal'; terminals.length = 0; said.length = 0; saidOpts.length = 0;
            const install = vscode.window.showWarningMessage;
            vscode.window.showWarningMessage = async (m, o, ...b) => { said.push(m); saidOpts.push(o); return 'Install'; };
            await e.switchSeat('spare2', () => {});
            vscode.window.showWarningMessage = install;
            assert.ok(said.includes('Install ccswitch (cc-usage-bar)?'), 'offers the installer');
            assert.ok(/1\.2\.0/.test(saidOpts.find((o) => o && o.detail && /installer/.test(o.detail)).detail), 'says why');
            assert.deepStrictEqual(terminals.map((t) => t.name), ['Install ccswitch'], 'only the installer terminal opens');
            assert.ok(!said.some((m) => /add spare2/.test(m)), 'no `add` is sent');
            fs.writeFileSync(path.join(HOME, 'version.out'), 'garbage');
            assert.strictEqual(await e.ccswitchHasAdd(), false, 'no readable version: treated as old');
            fs.writeFileSync(path.join(HOME, 'version.out'), 'ccswitch 2.0.0\n');
            assert.strictEqual(await e.ccswitchHasAdd(), true);
        } finally { fs.rmSync(path.join(HOME, 'version.out'), { force: true }); }
    });

    await check('Add account terminal: success says so and shows the row at once (a fetch chained after one in flight); a cancel or a manual close stays quiet (review finding)', async () => {
        const cmds = {}, ctx = { subscriptions: [], globalStorageUri: { fsPath: path.join(HOME, 'gs') }, globalState: memento(false) };
        const keep = { win: { ...vscode.window }, commands: vscode.commands, ws: vscode.workspace.onDidChangeConfiguration };
        Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, dispose() {} }), registerWebviewViewProvider: () => ({ dispose() {} }) });
        vscode.StatusBarAlignment = { Right: 2 };
        vscode.commands = { registerCommand: (id, f) => { cmds[id] = f; return { dispose() {} }; }, executeCommand: async () => {} };
        vscode.extensions = { getExtension: () => undefined };
        vscode.workspace.onDidChangeConfiguration = () => ({ dispose() {} });
        const fetches = () => calls().filter((c) => c.startsWith('usage --json')).length;
        const settle = async (n) => { for (let i = 0; i < 60 && fetches() < n; i++) await new Promise((r) => setTimeout(r, 50)); await new Promise((r) => setTimeout(r, 100)); };
        const saidSaved = () => said.filter((m) => /^Saved account fresh\./.test(m));
        try {
            usageReply(usageDoc({ work: 'ok' }));
            const x = load(); x.activate(ctx);
            stub.inputAnswer = 'fresh'; terminals.length = 0; fs.rmSync(LOG, { force: true }); said.length = 0;
            await x.addAccount(() => {});
            stub.closeTerminal({ name: 'something else' });
            await new Promise((r) => setTimeout(r, 100));
            assert.deepStrictEqual(calls().filter((c) => c.startsWith('usage')), [], 'an unrelated terminal closing refreshes nothing');
            seat('fresh', 'fresh@x.example', null);  // what `ccswitch add fresh` wrote
            terminals[0].exitStatus = { code: 0 };
            stub.closeTerminal(terminals[0]);
            await settle(1);
            assert.strictEqual(fetches(), 1, 'closing the Add account terminal runs the guarded fetch, then repaints');
            assert.strictEqual(saidSaved().length, 1, 'success is shown: ' + said.join(' | '));
            // Again for the same label, but ccswitch saved nothing (the user answered no): exit 0, no toast.
            terminals.length = 0; said.length = 0;
            await x.addAccount(() => {});
            terminals[0].exitStatus = { code: 0 };
            stub.closeTerminal(terminals[0]);
            await settle(2);
            assert.deepStrictEqual(saidSaved(), [], 'nothing new was saved: no "Saved" toast');
            terminals.length = 0;
            await x.addAccount(() => {});
            terminals[0].exitStatus = undefined;  // the user closed it mid-login
            stub.closeTerminal(terminals[0]);
            await settle(3);
            assert.deepStrictEqual(saidSaved(), [], 'a manual close is not a success');
            // A fetch already in flight when the terminal closes: the close runs its own fetch after it, not merged.
            terminals.length = 0; fs.rmSync(LOG, { force: true });
            await x.addAccount(() => {});
            cmds['claudeUsage.refresh']();
            terminals[0].exitStatus = { code: 0 };
            stub.closeTerminal(terminals[0]);
            await settle(2);
            assert.strictEqual(fetches(), 2, 'the close fetch runs after the one in flight');
        } finally {
            Object.assign(vscode.window, keep.win); vscode.commands = keep.commands; vscode.workspace.onDidChangeConfiguration = keep.ws;
            usageReply('');
            fs.rmSync(path.join(ACC, 'fresh'), { recursive: true, force: true });
            for (const d of ctx.subscriptions) if (d && d.dispose) d.dispose();
        }
    });

    await check('saveSeat only saves the seat you are on, answering ccswitch\'s own prompt', async () => {
        fs.rmSync(LOG, { force: true }); said.length = 0; stub.answer = 'Overwrite';
        await e.saveSeat('personal', () => {});
        assert.deepStrictEqual(calls(), []);
        await e.saveSeat('work', () => {});
        assert.deepStrictEqual(calls(), ['save work']);
    });
});
