// Unit tests for vscode/extension.js, moving section by section into tests/vscode/ (see tests/vscode/harness.js).
'use strict';
const {
    assert, fs, path, HOME, ACC, LOG, now, check, run, seat, ccswitch, usageReply, usageDoc, cfg, said, saidOpts,
    updates, stub, vscode, fakeWebview, file, load, e, memento, calls, capNow, acct, capOf, pdFour, readWv, panel,
    ui, withHist, rising,
} = require('./vscode/harness');

run(async () => {
    // --- Stats view (stats.js output, drawn by the panel) ---------------------------------------------
    const rangeOf = (over = {}) => ({ label: 'x', fromDate: '2026-10-01', favoriteModel: 'claude-opus-5-5', totalTokens: 23245249596, sessions: 57, totalMessages: 900,
        longestSession: { ms: (41 * 24 + 21) * 3600000, date: '2026-08-26' }, currentStreak: 3, longestStreak: 6, activeDays: 35, totalDays: 56, peakHour: 9,
        dailyActivity: [{ date: '2026-10-20', messageCount: 40 }, { date: '2026-10-21', messageCount: 10 }, { date: '2026-10-19', messageCount: 5 }, { date: '2026-10-18', messageCount: 80 }],
        models: [{ model: 'claude-opus-5-5', inputTokens: 1500, outputTokens: 2500000 }],
        tokensPerDay: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], days: [{ date: '2026-10-20', tokensByModel: { 'claude-opus-5-5': 10, 'claude-sonnet-5-5': 4 } }, { date: '2026-10-21', tokensByModel: { 'claude-opus-5-5': 20 } }] },
        funFact: 'Your input and output are ~3x the tokens in The Hobbit', ...over });
    const statsMsg = (over = {}) => ({ kind: 'stats', stats: { '7d': rangeOf({ sessions: 7, funFact: 'seven' }), '30d': rangeOf({ sessions: 30 }), all: rangeOf(), meta: { today: '2026-10-21' } }, ...over });

    await check('statsFeed: builds once, then reuses for 10 min; one build at a time; an error keeps the last stats', async () => {
        const sent = [], builds = [];
        let fail = false;
        const build = async (o) => { builds.push(o.cachePath); if (fail) throw new Error('boom'); return { n: builds.length }; };
        const feed = e.statsFeed('/tmp/c.json', (m) => sent.push(m), build);
        const first = feed();
        assert.strictEqual(feed(), undefined, 'a second request while building does nothing');
        await first;
        assert.deepStrictEqual(sent.map((m) => [m.building || false, m.stats ? m.stats.n : null]), [[true, null], [false, 1]]);
        feed();
        assert.strictEqual(builds.length, 1, 'within 10 min: the last result is sent again, no rebuild');
        assert.deepStrictEqual(sent[2].stats, { n: 1 });
        const real = Date.now;
        try {
            Date.now = () => real() + e.STATS_EVERY_MS + 1000;
            fail = true;
            await feed();
            assert.strictEqual(builds.length, 2);
            const last = sent[sent.length - 1];
            assert.strictEqual(last.error, 'boom');
            assert.deepStrictEqual(last.stats, { n: 1 }, 'the last good stats stay on screen');
        } finally { Date.now = real; }
        assert.deepStrictEqual(builds, ['/tmp/c.json', '/tmp/c.json']);
        const src = fs.readFileSync(file, 'utf8');
        assert.match(src, /statsFeed\(path\.join\(context\.globalStorageUri\.fsPath, 'stats-cache\.json'\)/, 'the cache lives in global storage');
        assert.match(src, /m\.wantStats\) \{ if \(v\.visible\) wantStats\(\); \}/, 'a hidden, retained Stats tab never rebuilds (review finding)');
        assert.match(src, /v\.onDidChangeVisibility\(\(\) => \{ if \(v\.visible\) push\(\); \}\)/, 'shown again: the panel gets data and can ask');
    });

    await check('statsFeed: a failed build is retried after about a minute, not kept for 10 min (review finding)', async () => {
        const sent = [];
        let fail = true, builds = 0;
        const feed = e.statsFeed('/tmp/c.json', (m) => sent.push(m), async () => { builds++; if (fail) throw new Error('boom'); return { n: builds }; });
        const real = Date.now, t0 = real();
        try {
            Date.now = () => t0;
            await feed();
            assert.strictEqual(sent[sent.length - 1].error, 'boom');
            feed();
            assert.strictEqual(builds, 1, 'right after a failure: the error is sent again, no rebuild loop');
            assert.ok(e.STATS_RETRY_MS <= 2 * 60 * 1000 && e.STATS_RETRY_MS < e.STATS_EVERY_MS);
            Date.now = () => t0 + e.STATS_RETRY_MS + 1000;
            fail = false;
            await feed();
            assert.strictEqual(builds, 2, 'a minute later: built again');
            assert.deepStrictEqual(sent[sent.length - 1].stats, { n: 2 });
            fail = true;
            Date.now = () => t0 + e.STATS_RETRY_MS + 1000 + e.STATS_EVERY_MS + 1000;
            await feed();
            Date.now = () => t0 + 2 * e.STATS_RETRY_MS + 3000 + e.STATS_EVERY_MS;
            await feed();
            assert.strictEqual(builds, 4, 'a failure after a good build is retried a minute later too');
            assert.deepStrictEqual(sent[sent.length - 1].stats, { n: 2 }, 'the last good stats stay on screen');
        } finally { Date.now = real; }
    });

    await check('render: Stats tab; building, error, and the overview like the CLI /stats', () => {
        const p = panel();
        assert.ok(p.render(pdFour(), ui({ view: 'stats' }), null).includes('Building stats'));
        assert.ok(p.render(pdFour(), ui({ view: 'stats' }), { kind: 'stats', error: '<x>' }).includes('Stats failed: &lt;x&gt;'));
        const html = p.render(pdFour(), ui({ view: 'stats' }), statsMsg());
        assert.ok(html.includes('aria-selected="true" data-a="view" data-l="stats"'));
        assert.ok(html.includes('This machine · all accounts') && !html.includes('updating'));
        let at = 0;
        for (const t of ['data-l="all">All time', 'Activity', 'Overview', 'Favorite model', 'claude-opus-5-5', 'Total tokens', '23.2B', 'Sessions', '>57<',
            'Longest session', '41d 21h', '2026-08-26', 'Current streak', '3 days', 'Longest streak', '6 days', 'Active days', '35/56', 'Peak hour', '09:00-10:00',
            'The Hobbit', 'Tokens per day', 'Models', 'In 1.5k · Out 2.5M']) { const k = html.indexOf(t, at); assert.ok(k >= 0, 'in order: ' + t); at = k; }
        assert.strictEqual(html.split('<rect ').length - 1, 25 * 7 + 4, '26 weeks of days: 25 full weeks, then Sunday to today (a Wednesday)');
        assert.match(html, /class="lv4"[^>]*><title>2026-10-18: 80 messages/);
        assert.match(html, /class="lv0"[^>]*><title>2026-10-17: 0 messages/);
        assert.strictEqual(html.split('<polyline class="ln m').length - 1, 2, 'one line per top model');
        assert.ok(p.render(pdFour(), ui({ view: 'stats' }), statsMsg({ building: true })).includes('updating…'), 'a rebuild keeps the old stats on screen');
    });

    await check('render: Stats ranges switch the numbers; the current streak is always all-time; text is escaped', () => {
        const p = panel();
        const week = p.render(pdFour(), ui({ view: 'stats', statsRange: '7d' }), statsMsg());
        assert.ok(week.includes('aria-selected="true" data-a="srange" data-l="7d"') && week.includes('>7<') && week.includes('seven'));
        const bad = statsMsg();
        bad.stats.all = rangeOf({ favoriteModel: '<img src=x>', funFact: '<b>f</b>', models: [{ model: '<m>', inputTokens: 1, outputTokens: 1 }],
            tokensPerDay: { models: ['<q>'], days: [{ date: '<d>', tokensByModel: {} }] } });
        const html = p.render(pdFour(), ui({ view: 'stats' }), bad);
        assert.ok(!/<img src=x|<b>f|<m>|<q>|<d>/.test(html), 'escaped');
        const src = readWv('panel.js');
        assert.match(src, /ev\.data\.kind === 'stats'\) stats = ev\.data/, 'stats messages do not replace the account data');
        assert.match(src, /l === 'stats'\) vsc\.postMessage\(\{ wantStats: 1 \}\)/, 'opening the tab asks for stats');
    });

    await check('render: a non-number where Stats or History expects a number never reaches the HTML (review finding)', () => {
        const p = panel(), x = '<img src=x onerror=a()>';
        const st = statsMsg();
        st.stats.all = rangeOf({ totalTokens: x, sessions: x, activeDays: x, totalDays: x, longestStreak: x, peakHour: x, currentStreak: x,
            longestSession: { ms: x, date: '2026-08-26' }, dailyActivity: [{ date: '2026-10-20', messageCount: x }, { date: '2026-10-21', messageCount: 3 }],
            models: [{ model: 'm', inputTokens: x, outputTokens: { toString: () => x } }],
            tokensPerDay: { models: ['m'], days: [{ date: '2026-10-20', tokensByModel: { m: x } }, { date: '2026-10-21', tokensByModel: { m: 5 } }] } });
        st.stats.all.currentStreak = x;
        const html = p.render(pdFour(), ui({ view: 'stats' }), st);
        assert.ok(!html.includes('<img'), 'stats: ' + html.slice(html.indexOf('<img') - 80, html.indexOf('<img') + 20));
        assert.ok(html.includes('Sessions</span><span class="v">–<'), 'a bad number shows a dash');
        const h = { ...withHist(rising), history: [{ label: 'a', icon: 'switch', tip: 't', five: x, week: '9" onmouseover="a()',
            fiveSeries: [[x, x, x], [now, 5, null]], weekSeries: [[now, { toString: () => x }, null]], fivePace: null, weekPace: null }] };
        const hist = p.render(h, ui({ view: 'history' }));
        assert.ok(!hist.includes('<img') && !hist.includes('onmouseover'), 'history: ' + hist.slice(0, 400));
        assert.ok(!p.render({ ...pdFour(), active: { ...pdFour().active, five: x } }, ui()).includes('<img'), 'the Usage bars too');
    });

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
        const p = require('../vscode/package.json').contributes.configuration.properties['claudeUsage.autoSwitch'];
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
        assert.strictEqual(require('../vscode/package.json').contributes.configuration.properties['claudeUsage.autoSwitch'].default, false);
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
