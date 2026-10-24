// VS Code sidebar tests: reading accounts, panelData rows and counts, capacity, freshness and the team file.
'use strict';
const {
    assert, fs, path, HOME, now, check, run, cfg, e, ctxFor, capNow, acct, capOf, four, opts, pdFour,
} = require('./harness');

run(async () => {
    await check('activeLabel maps the live email to its saved label (not the email local part)', () =>
        assert.strictEqual(e.activeLabel(), 'work'));

    await check('readAccounts reads ccswitch usage caches and emails, no team file needed', () => {
        const { accounts, cap } = e.readAccounts();
        const by = (l) => accounts.find((a) => a.label === l);
        assert.deepStrictEqual(accounts.map((a) => a.label), ['dead', 'half', 'personal', 'spare', 'work']);
        assert.strictEqual(by('work').email, 'me@work.example');
        assert.strictEqual(by('work').five_pct, 100);
        assert.strictEqual(by('spare').five_pct, null);
        assert.strictEqual(cap.best.label, 'personal');
        assert.ok(!('free' in cap) && !('total' in cap), 'the free count is gone: it counted stale and dead accounts');
        assert.strictEqual(cap.activeFresh, true);
        assert.strictEqual(e.ageText(by('dead').fetched_at, now), '13d old');
        const pd = e.panelData(accounts, cap, { now, installed: true, auto: false });
        assert.strictEqual(pd.active.label, 'work');
        assert.strictEqual(pd.next.label, 'personal');
    });

    await check('panelData: active hero, next-best, counts', () => {
        const d = pdFour();
        assert.strictEqual(d.active.label, '002');
        assert.strictEqual(d.active.five, 23);
        assert.strictEqual(d.active.age, null);
        assert.strictEqual(d.next.label, '004');
        assert.deepStrictEqual(d.counts, { total: 4, saved: 4, relogin: 1, full: 1 });
        assert.deepStrictEqual(Object.fromEntries(d.rows.map((r) => [r.label, r.icon])), { '001': 'full', '002': 'active', '003': 'relogin', '004': 'switch' });
        assert.strictEqual(d.active.email, '002@x.example');
        assert.strictEqual(d.rows[2].age, '13d old');
        assert.strictEqual(d.rows[3].age, null);
        assert.strictEqual(d.rows[0].tip, 'A limit is at 100%');
        assert.deepStrictEqual(d.rows[2].actions, ['relogin', 'delete']);
        assert.deepStrictEqual(d.rows[3].actions, ['switch', 'delete']);
        assert.strictEqual(d.loginHealth, 'known');
    });

    await check('panelData: counts follow the row icons, not the free count (stale and dead are not free)', () => {
        const a = [acct('001', 5, 5, now - 7200), acct('002', 23, 64, now - 60), acct('003', 100, 5, now - 60), acct('004', 5, 5, now - 60)];
        const d = e.panelData(a, capOf(a, '002', ['004']), opts);
        assert.deepStrictEqual(d.counts, { total: 4, saved: 4, relogin: 1, full: 1 });
        assert.strictEqual(d.rows[0].icon, '', 'a stale account is not a switch target');
        assert.strictEqual(d.rows[0].summary, 'No recent data');
        assert.strictEqual(d.rows[0].age, '2h old');
    });

    await check('panelData: a reset that is already past is not shown as "now"', () => {
        const a = [acct('002', 23, 64, now - 60), acct('003', 5, 5, now - 13 * 86400, { five_reset_epoch: now - 12 * 86400, week_reset_epoch: now - 600 })];
        const r = e.panelData(a, capOf(a, '002', ['003']), opts).rows[1];
        assert.strictEqual(r.fiveReset, null);
        assert.strictEqual(r.weekReset, null);
    });

    await check('panelData: nothing qualifies -> next is null', () => {
        const a = [acct('001', 5, 5, now - 7200), acct('002', 23, 64, now - 60), acct('003', 5, 5, now - 60)];
        const d = e.panelData(a, capOf(a, '002', ['003']), opts);
        assert.strictEqual(d.next, null);
        assert.ok(!d.rows.some((r) => r.icon === 'switch'));
    });

    await check('panelData: missing window is null, not 0', () => {
        const a = [acct('002', 23, 64, now - 60), acct('half', null, 30, now - 60, { five_reset_epoch: null })];
        const d = e.panelData(a, capOf(a, '002'), opts);
        const half = d.rows.find((r) => r.label === 'half');
        assert.strictEqual(half.five, null);
        assert.strictEqual(half.week, 30);
        assert.strictEqual(half.fiveReset, null);
        assert.strictEqual(half.icon, 'switch');
    });

    await check('panelData: unsaved active account gets SAVE, never switch', () => {
        const a = four();
        const cap = capOf(a, 'newbie', ['003']);
        const d = e.panelData(a, cap, opts);
        assert.strictEqual(d.active.label, 'newbie');
        assert.strictEqual(d.active.five, null);
        const row = d.rows.find((r) => r.label === 'newbie');
        assert.deepStrictEqual(row.actions, ['save']);
        assert.strictEqual(row.icon, 'active');
        assert.strictEqual(e.autoTarget({ ...cap, you: 'newbie' }), null);
    });

    await check('panelData: codex row has no actions and never ⇄', () => {
        const a = [acct('002', 23, 64, now - 60), acct('codex', 1, 1, now - 60, { provider: 'codex' })];
        const d = e.panelData(a, capOf(a, '002'), opts);
        const cx = d.rows.find((r) => r.label === 'codex');
        assert.deepStrictEqual(cx.actions, []);
        assert.strictEqual(cx.icon, 'readonly', 'a lock, never the ⇄ switch icon');
    });

    await check('ageText: null when fresh, else minutes, hours or days; no data', () => {
        assert.strictEqual(e.ageText(now - 60, now), null);
        assert.strictEqual(e.ageText(now - 2700, now), '45m old');
        assert.strictEqual(e.ageText(now - 5 * 3600, now), '5h old');
        assert.strictEqual(e.ageText(now - 13 * 86400, now), '13d old');
        assert.strictEqual(e.ageText(null, now), 'no data');
    });

    await check('B1 capacity never recommends a re-login account, even with the lowest load', () => {
        const cap = capNow(new Set(['personal']));
        assert.notStrictEqual(cap.best.label, 'personal');
        assert.strictEqual(cap.best.label, 'half');
    });

    await check('B1 capacity never recommends an account whose own data is stale', () => {
        const cap = capNow();
        assert.notStrictEqual(cap.best.label, 'dead');
        assert.strictEqual(cap.loads.dead, 5);
    });

    await check('B2 one dead account does not mark the others stale', () => {
        const cap = capNow();
        assert.strictEqual(cap.fresh.dead, false);
        assert.strictEqual(cap.fresh.personal, true);
        assert.strictEqual(cap.activeFresh, true);
        assert.ok(!('stale' in cap) && !('updated' in cap));
        assert.ok(!('generated_at' in e.readSnapshot()));
    });

    await check('B3 auto-switch fires while a dead account exists', () => {
        assert.strictEqual(e.autoTarget(capNow()), 'personal');
    });

    await check('autoTarget: never when the active account\'s data is stale or below 100%', () => {
        const cap = capNow();
        assert.strictEqual(e.autoTarget({ ...cap, activeFresh: false, activeSwitchFresh: false }), null);
        assert.strictEqual(e.autoTarget({ ...cap, loads: { ...cap.loads, work: 99 } }), null);
        assert.strictEqual(e.autoTarget({ ...cap, best: null }), null);
        assert.strictEqual(e.autoTarget({ ...cap, you: null }), null);
    });

    await check('switching needs data under 15 min; display keeps 30 min', () => {
        const a = [acct('work', 100, 40, now - 1000), acct('p16', 10, 5, now - 1000), acct('p13', 20, 5, now - 800)];
        const cap = capOf(a, 'work');
        assert.strictEqual(cap.best.label, 'p13', 'a 16-min-old account is not a switch target');
        assert.strictEqual(e.autoTarget(cap), null, 'a 16-min-old full reading does not auto-switch');
        assert.strictEqual(cap.activeFresh, true, 'the status bar still shows it as current');
        const d = e.panelData(a, cap, opts);
        assert.strictEqual(d.rows[1].icon, '');
        assert.strictEqual(d.rows[1].summary, '10% · 5%', 'display: not stale yet');
        assert.strictEqual(e.autoTarget(capOf([acct('work', 100, 40, now - 800), a[2]], 'work')), 'p13');
    });

    await check('a fetched_at in the future is not fresh (beyond 60 s of clock slack)', () => {
        const ahead = acct('x', 1, 1, now + 3600);
        assert.strictEqual(e.isFresh(ahead, now), false);
        assert.strictEqual(e.qualifies(ahead, ctxFor(new Set(), 'work')), false);
        assert.strictEqual(e.ageText(ahead.fetched_at, now), 'in the future');
        assert.strictEqual(e.isFresh(acct('x', 1, 1, now + 30), now), true, 'a few seconds of skew is fine');
    });

    await check('qualifies: a missing 5h window does not count as full', () => {
        const snap = e.readSnapshot(), half = snap.accounts.find((a) => a.label === 'half');
        assert.strictEqual(e.qualifies(half, ctxFor()), true);
        assert.strictEqual(capNow().loads.half, 30);
        assert.strictEqual(e.qualifies(snap.accounts.find((a) => a.label === 'work'), ctxFor(new Set(), 'other')), false, 'full');
        assert.strictEqual(e.qualifies(half, ctxFor(new Set(), 'half')), false, 'the active account never qualifies');
    });

    await check('team file: data age is the file\'s generated_at; state must be ok', () => {
        const tf = path.join(HOME, 'team.json');
        const write = (gen, state) => fs.writeFileSync(tf, JSON.stringify({ generated_at: gen, accounts: [{ label: 't1', provider: 'claude', state, five_pct: 1, week_pct: 1 }] }));
        cfg.usageFile = tf;
        try {
            write(now - 3600, 'ok');
            assert.strictEqual(e.isFresh(e.readSnapshot().accounts[0], now), false);
            write(now - 60, 'ok');
            assert.strictEqual(e.isFresh(e.readSnapshot().accounts[0], now), true);
            write(now - 60, 'stale');
            assert.strictEqual(e.isFresh(e.readSnapshot().accounts[0], now), false);
        } finally { delete cfg.usageFile; }
    });

    await check('team file: rows whose label breaks the label rule are dropped; usageFile is machine-scoped', () => {
        const tf = path.join(HOME, 'team.json');
        fs.writeFileSync(tf, JSON.stringify({ generated_at: now, accounts: ['../../etc', '-h', 'a.b', 42, null, {}, 't1'].map((label) =>
            ({ label, provider: 'claude', state: 'ok', five_pct: 1, week_pct: 1 })) }));
        cfg.usageFile = tf;
        try { assert.deepStrictEqual(e.readAccounts().accounts.map((a) => a.label), ['t1']); } finally { delete cfg.usageFile; }
        const p = require('../../vscode/package.json').contributes.configuration.properties['claudeUsage.usageFile'];
        assert.strictEqual(p.scope, 'machine', 'a workspace .vscode/settings.json cannot point it at a crafted file');
    });
});
