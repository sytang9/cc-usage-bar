// VS Code sidebar tests: the auto-switch consent dialog, setting, and the path that moves the live login.
'use strict';
const {
    assert, fs, path, HOME, ACC, LOG, check, run, usageReply, usageDoc, cfg, said, saidOpts, updates, stub, file,
    load, e, memento, calls, capNow,
} = require('./harness');

run(async () => {
    // --- G7: turning auto-switch on asks once ----------------------------------------------------------
    await check('G7 turning auto-switch on asks once, in a modal', async () => {
        said.length = saidOpts.length = updates.length = 0;
        stub.answer = undefined;
        const st = memento(false);
        assert.strictEqual(await e.setAutoSwitch(true, st), false);
        assert.strictEqual(st.get(e.CONSENT), undefined, 'no consent recorded on No');
        assert.deepStrictEqual(updates, []);
        assert.strictEqual(said.length, 1);
        assert.strictEqual(saidOpts[0].modal, true);
        assert.strictEqual(said[0], 'Turn on auto-switch?');
        stub.answer = 'Turn on';
        assert.strictEqual(await e.setAutoSwitch(true, st), true);
        assert.deepStrictEqual(updates, [['autoSwitch', true, 1]]);
        assert.strictEqual(st.get(e.CONSENT), true, 'the confirmation is recorded on this machine');
        stub.answer = undefined;
    });

    await check('G7 turning auto-switch off needs no dialog', async () => {
        said.length = saidOpts.length = updates.length = 0;
        assert.strictEqual(await e.setAutoSwitch(false), true);
        assert.strictEqual(said.length, 0);
        assert.deepStrictEqual(updates, [['autoSwitch', false, 1]]);
    });

    await check('G7 the dialog states the effect', () => {
        for (const re of [/every new Claude Code session/, /without asking/, /100%/, /restart/i, /this machine/]) assert.match(e.AUTO_DETAIL, re);
    });

    await check('autoSwitch setting is machine-scoped and its description says what it does', () => {
        const p = require('../../vscode/package.json').contributes.configuration.properties['claudeUsage.autoSwitch'];
        assert.strictEqual(p.scope, 'machine');
        assert.ok(!('description' in p), 'markdownDescription replaces description');
        assert.match(p.markdownDescription, /without asking/);
        assert.match(p.markdownDescription, /100%/);
        assert.ok(!/skips/.test(p.markdownDescription), 'no door skips the dialog any more');
    });

    await check('the toggle command and the panel both go through setAutoSwitch', () => {
        const src = fs.readFileSync(file, 'utf8');
        assert.ok(!/update\('autoSwitch'/.test(src.replace(/async function setAutoSwitch[\s\S]*?\n}\n/, '')), 'one writer of the setting');
    });

    // --- auto-switch: the path that moves the live login (work is active, fresh, 5h at 100%) ---------------
    const STAMP = path.join(ACC, '.autoswitch.json'), LOCK = path.join(ACC, '.autoswitch.lock');
    const SWITCH_RC = path.join(HOME, 'switch.rc');
    const autoReset = () => { for (const f of [STAMP, LOCK, LOG, SWITCH_RC]) fs.rmSync(f, { recursive: true, force: true }); said.length = updates.length = 0; stub.answer = undefined; };
    // One VS Code window whose login check has run: a fresh instance plus one `usage --json` with this health.
    const win = async (health = 'known') => {
        const w = load();
        usageReply(usageDoc({ work: 'ok', personal: 'ok', half: 'ok' }, health));
        await w.checkLogins();
        fs.rmSync(LOG, { force: true });
        return w;
    };
    const tryAuto = async (w, st = memento(true)) => w.autoSwitch(w.readAccounts().cap, st, () => {});
    const minsAgo = (m) => Math.floor(Date.now() / 1000) - m * 60;

    await check('auto-switch: off by default (package.json) and off does nothing', async () => {
        autoReset();
        assert.strictEqual(require('../../vscode/package.json').contributes.configuration.properties['claudeUsage.autoSwitch'].default, false);
        const res = await tryAuto(await win());
        assert.strictEqual(res.skip, 'off');
        assert.deepStrictEqual(calls(), []);
    });

    cfg.autoSwitch = true;
    try {
        await check('auto-switch: active full and fresh, login check known, consent given -> one `ccswitch <best>`', async () => {
            autoReset();
            const res = await tryAuto(await win());
            assert.deepStrictEqual(calls(), ['personal']);
            assert.strictEqual(res.to, 'personal');
            assert.ok(said.some((t) => t.startsWith('Auto-switched Claude Code: work is full, now on personal')), said.join('|'));
            assert.ok(Math.abs(JSON.parse(fs.readFileSync(STAMP, 'utf8')).last_switch - Date.now() / 1000) < 5, 'the stamp holds the switch time');
            assert.ok(!fs.existsSync(LOCK), 'the lock is released');
        });

        await check('auto-switch: the 10-min cooldown holds across windows (stamp file)', async () => {
            autoReset();
            const a = await win(), b = await win();
            await tryAuto(a);
            const res = await tryAuto(b);
            assert.deepStrictEqual(calls(), ['personal'], 'the second window does not switch again');
            assert.strictEqual(res.skip, 'cooldown');
            autoReset(); fs.writeFileSync(STAMP, JSON.stringify({ last_switch: minsAgo(9) }));
            assert.strictEqual((await tryAuto(await win())).skip, 'cooldown', 'a reload does not reset it');
            autoReset(); fs.writeFileSync(STAMP, JSON.stringify({ last_switch: minsAgo(11) }));
            await tryAuto(await win());
            assert.deepStrictEqual(calls(), ['personal']);
        });

        await check('auto-switch: two windows at once -> one switch (mkdir lock); a stale lock is taken over', async () => {
            autoReset();
            const [a, b] = [await win(), await win()];
            await Promise.all([tryAuto(a), tryAuto(b)]);
            assert.deepStrictEqual(calls(), ['personal']);
            autoReset(); fs.mkdirSync(LOCK);
            assert.strictEqual((await tryAuto(await win())).skip, 'busy');
            assert.deepStrictEqual(calls(), []);
            assert.ok(fs.existsSync(LOCK), 'another window\'s lock is left alone');
            fs.utimesSync(LOCK, minsAgo(11), minsAgo(11));
            await tryAuto(await win());
            assert.deepStrictEqual(calls(), ['personal'], 'a lock left by a crashed window does not block forever');
        });

        await check('auto-switch: re-reads the live account; stops if it moved or is no longer full', async () => {
            autoReset();
            const w = await win(), cap = w.readAccounts().cap;
            const live = path.join(HOME, '.claude.json'), was = fs.readFileSync(live, 'utf8');
            const cache = path.join(ACC, 'work', '.usage-cache'), wasCache = fs.readFileSync(cache, 'utf8');
            try {
                fs.writeFileSync(live, JSON.stringify({ oauthAccount: { emailAddress: 'me@home.example' } }));  // ccswitch personal in a terminal
                assert.strictEqual((await w.autoSwitch(cap, memento(true), () => {})).skip, 'moved');
                fs.writeFileSync(live, was);
                fs.writeFileSync(cache, JSON.stringify({ ...JSON.parse(wasCache), five_hour_pct: 50 }));  // the window reset
                assert.strictEqual((await w.autoSwitch(cap, memento(true), () => {})).skip, 'moved');
                assert.deepStrictEqual(calls(), []);
                assert.ok(!fs.existsSync(STAMP), 'no switch, no cooldown');
            } finally { fs.writeFileSync(live, was); fs.writeFileSync(cache, wasCache); }
        });

        await check('auto-switch: a stamp in the future (a wrong clock) does not block switching', async () => {
            autoReset(); fs.writeFileSync(STAMP, JSON.stringify({ last_switch: minsAgo(-24 * 60) }));
            const res = await tryAuto(await win());
            assert.notStrictEqual(res.skip, 'cooldown');
        });

        await check('auto-switch: during the cooldown no lock is taken, so the watched folder stays still', async () => {
            // Every window watches the accounts folder; a lock made and removed on each poll would wake them all.
            autoReset(); fs.writeFileSync(STAMP, JSON.stringify({ last_switch: minsAgo(2) }));
            const w = await win(), before = fs.statSync(ACC).mtimeMs;
            await new Promise((ok) => setTimeout(ok, 20));
            assert.strictEqual((await tryAuto(w)).skip, 'cooldown');
            assert.strictEqual(fs.statSync(ACC).mtimeMs, before, 'no mkdir/rmdir in the accounts folder');
        });

        await check('auto-switch: a failed switch shows the error and still starts the cooldown', async () => {
            autoReset(); fs.writeFileSync(SWITCH_RC, '1');
            const res = await tryAuto(await win());
            assert.deepStrictEqual(calls(), ['personal']);
            assert.strictEqual(res.r.ok, false);
            assert.ok(said.some((t) => t.startsWith('ERROR Auto-switch to personal failed')), said.join('|'));
            assert.ok(!said.some((t) => t.startsWith('Auto-switched')));
            assert.ok(fs.existsSync(STAMP), 'no retry on every poll');
            assert.ok(!fs.existsSync(LOCK));
        });

        await check('auto-switch: an error (stamp not writable) is shown, not dropped, and the lock is released', async () => {
            autoReset(); fs.mkdirSync(STAMP);  // a directory where the stamp file goes
            try {
                const res = await tryAuto(await win());
                assert.strictEqual(res.skip, 'error');
                assert.deepStrictEqual(calls(), [], 'no stamp, no switch');
                assert.ok(said.some((t) => t.startsWith('ERROR Auto-switch failed: ')), said.join('|'));
                assert.ok(!fs.existsSync(LOCK));
            } finally { for (const f of fs.readdirSync(ACC)) if (f.startsWith('.autoswitch.json.')) fs.rmSync(path.join(ACC, f)); }
        });

        await check('auto-switch: nothing before the first login check, or after a failed one', async () => {
            autoReset();
            const fresh = load();
            assert.strictEqual((await tryAuto(fresh)).skip, 'no login check yet');
            const w = await win();
            usageReply('timeout', 1);
            await w.checkLogins();
            assert.strictEqual((await tryAuto(w)).skip, 'login health unknown');
            assert.deepStrictEqual(calls().filter((c) => c !== 'usage --json'), []);
        });

        await check('auto-switch: nothing while login health is unknown', async () => {
            autoReset();
            assert.strictEqual((await tryAuto(await win('unknown'))).skip, 'login health unknown');
            assert.deepStrictEqual(calls(), []);
        });

        await check('auto-switch: on without consent (settings.json, older version) asks once; No turns it off', async () => {
            autoReset();
            const w = await win(), st = memento(false);
            const [r1, r2] = await Promise.all([tryAuto(w, st), tryAuto(w, st)]);
            assert.strictEqual(said.filter((t) => t === 'Turn on auto-switch?').length, 1, 'one dialog, however many polls');
            assert.deepStrictEqual(updates, [['autoSwitch', false, 1]]);
            assert.strictEqual(r1.skip, 'no consent'); assert.strictEqual(r2.skip, 'no consent');
            assert.deepStrictEqual(calls(), []);
            autoReset(); stub.answer = 'Turn on';
            await tryAuto(w, st);
            assert.strictEqual(st.get(e.CONSENT), true);
            assert.deepStrictEqual(calls(), ['personal'], 'confirmed: it switches');
        });

        await check('autoBlock: every gate, in order', () => {
            const cap = capNow(), g = { on: true, consented: true, installed: true, checked: true, health: 'known', cap };
            assert.strictEqual(e.autoBlock(g), null);
            assert.strictEqual(e.autoBlock({ ...g, on: false }), 'off');
            assert.strictEqual(e.autoBlock({ ...g, consented: false }), 'no consent');
            assert.strictEqual(e.autoBlock({ ...g, installed: false }), 'no ccswitch');
            assert.strictEqual(e.autoBlock({ ...g, checked: false }), 'no login check yet');
            assert.strictEqual(e.autoBlock({ ...g, health: 'unknown' }), 'login health unknown');
            assert.strictEqual(e.autoBlock({ ...g, cap: { ...cap, best: null } }), 'no target');
            assert.strictEqual(e.autoBlock({ ...g, cap: { ...cap, best: { label: '-h' } } }), 'no target', 'a target must pass the label rule');
        });
    } finally { delete cfg.autoSwitch; autoReset(); }
});
