// VS Code sidebar tests: the read-only Codex row.
'use strict';
const {
    assert, fs, path, HOME, now, check, run, cfg, e, acct, capOf, opts, pdFour, panel, ui, rowOf,
} = require('./harness');

run(async () => {
    // --- the read-only Codex row ----------------------------------------------------------------------
    const CODEX = process.env.CODEX_HOME;
    const codexCache = (c) => { fs.mkdirSync(CODEX, { recursive: true }); fs.writeFileSync(path.join(CODEX, '.usage-cache'), JSON.stringify(c)); };
    const withCodex = (fn) => { try { return fn(); } finally { fs.rmSync(CODEX, { recursive: true, force: true }); } };
    const cx = (five, week, fetched, extra = {}) => acct('codex', five, week, fetched, { provider: 'codex', email: null, ...extra });

    await check('codex: the sidebar reads ${CODEX_HOME}/.usage-cache; no cache and no login -> no row', () => withCodex(() => {
        assert.ok(!e.readAccounts().accounts.some((a) => a.provider === 'codex'));
        codexCache({ fetched_at: now - 60, five_hour_pct: 0, seven_day_pct: 1, five_hour_reset_epoch: now + 600, seven_day_reset_epoch: now + 86400, plan_type: 'plus', rate_limited_until: null });
        const { accounts, cap } = e.readAccounts();
        const row = accounts.filter((a) => a.provider === 'codex');
        assert.deepStrictEqual(row, [{ label: 'codex', provider: 'codex', state: 'ok', fetched_at: now - 60, five_pct: 0, week_pct: 1,
            five_reset_epoch: now + 600, week_reset_epoch: now + 86400, email: null }]);
        assert.strictEqual(accounts[accounts.length - 1].provider, 'codex', 'after the Claude accounts');
        assert.notStrictEqual(cap.best && cap.best.label, 'codex', 'the emptiest seat, but never a target');
        assert.ok(!('codex' in cap.loads) && !cap.saved.includes('codex'));
    }));

    await check('codex: a login with no cache yet, or a never-fetched cache, shows "No recent data"', () => withCodex(() => {
        fs.mkdirSync(CODEX, { recursive: true });
        fs.writeFileSync(path.join(CODEX, 'auth.json'), 'not read by the sidebar');
        const only = e.readAccounts().accounts.find((a) => a.provider === 'codex');
        assert.strictEqual(only.state, 'no data yet');
        assert.strictEqual(only.fetched_at, null);
        codexCache({ fetched_at: 0, rate_limited_until: now + 600 });
        const { accounts, cap } = e.readAccounts();
        const r = e.panelData(accounts, cap, opts).rows.find((x) => x.provider === 'codex');
        assert.strictEqual(r.summary, 'No recent data');
        assert.strictEqual(r.age, 'no data');
    }));

    await check('codex: stale numbers say "No recent data" and their age, so a stuck number is visible', () => {
        const a = [acct('002', 23, 64, now - 60), cx(5, 6, now - 5 * 3600)];
        const r = e.panelData(a, capOf(a, '002'), opts).rows[1];
        assert.strictEqual(r.summary, 'No recent data');
        assert.strictEqual(r.age, '5h old');
        const html = panel().render(e.panelData(a, capOf(a, '002'), opts), ui({ openRow: 'codex' }));
        assert.ok(html.includes('Last data') && html.includes('5h old'));
    });

    await check('codex: read-only row: lock icon, Codex tooltip, own resets, no actions, never ⇄ or next, not saved', () => {
        // codex is the emptiest seat; 004 is the only Claude target.
        const a = [acct('002', 23, 64, now - 60), acct('004', 46, 13, now - 60), cx(0, 0, now - 60)];
        const d = e.panelData(a, capOf(a, '002', [], ['002', '004', 'codex']), opts);
        const r = d.rows.find((x) => x.provider === 'codex');
        assert.deepStrictEqual([r.icon, r.tip, r.actions, r.email], ['readonly', 'Codex (read-only)', [], null]);
        assert.strictEqual(r.summary, '0% · 0%');
        assert.ok(r.fiveReset && r.weekReset, 'its own reset times');
        assert.strictEqual(d.next.label, '004');
        assert.strictEqual(d.counts.saved, 2, 'not counted as a saved account');
        const html = panel().render(d, ui({ openRow: 'codex' }));
        const row = rowOf(html, 'codex');
        assert.ok(row.includes('codicon-lock') && row.includes('title="Codex (read-only)"'));
        const det = html.slice(html.indexOf(row) + row.length).split('<div class="sec">')[0];
        assert.ok(det.includes('Resets') || det.includes('resets'), 'details show its resets');
        assert.ok(det.includes('Read-only'), 'the open row says it is read-only (no hover needed)');
        assert.ok(!det.includes('<button'), 'no Switch, Save login or Delete');
    });

    await check('codex: a full Codex row is marked full but stays read-only and Codex-labelled', () => {
        const a = [acct('002', 23, 64, now - 60), cx(5, 100, now - 60)];
        const r = e.panelData(a, capOf(a, '002'), opts).rows[1];
        assert.strictEqual(r.icon, 'full');
        assert.match(r.tip, /^Codex \(read-only\)/);
        assert.match(r.summary, /^Weekly full · resets /);
        assert.deepStrictEqual(r.actions, []);
    });

    await check('codex: a saved Claude account named "codex" keeps its own row; the Codex row never borrows it', () => {
        const a = [acct('codex', 23, 64, now - 60), acct('004', 46, 13, now - 60), cx(1, 1, now - 60)];
        const d = e.panelData(a, capOf(a, 'codex', ['codex']), opts);
        const [claudeRow, codexRow] = [d.rows[0], d.rows[2]];
        assert.strictEqual(claudeRow.icon, 'active');
        assert.deepStrictEqual(claudeRow.actions, ['relogin', 'delete']);
        assert.deepStrictEqual([codexRow.provider, codexRow.icon, codexRow.actions], ['codex', 'readonly', []]);
        assert.strictEqual(d.counts.saved, 2);
        assert.strictEqual(d.counts.relogin, 0, 'the active Claude "codex" is not re-login-marked twice, the Codex row never');
        assert.strictEqual(d.active.five, 23, 'the hero is the Claude account');
        const tip = e.statusTooltip({ ...capOf(a, 'codex', ['codex']) }, a, false).split('\n');
        assert.ok(tip.includes('codex: 5h 1%, wk 1% · Codex (read-only)'), tip.join(' | '));
    });

    await check('codex: never the status-bar headroom, even when every Claude account is full', () => {
        const a = [acct('002', 100, 64, now - 60), acct('003', 100, 100, now - 60), cx(0, 0, now - 60)];
        const cap = capOf(a, '002');
        assert.strictEqual(cap.best, null);
        assert.strictEqual(e.autoTarget(cap), null);
        assert.ok(e.statusText(cap, a, false).endsWith('⇄ none'));
    });

    await check('codex: team-file provider "codex" rows behave the same', () => withCodex(() => {
        const tf = path.join(HOME, 'team.json');
        fs.writeFileSync(tf, JSON.stringify({ generated_at: now - 60, accounts: [
            { label: 't1', provider: 'claude', state: 'ok', five_pct: 50, week_pct: 50 },
            { label: 'codex', provider: 'codex', state: 'ok', five_pct: 0, week_pct: 0, five_reset_epoch: now + 600 }] }));
        codexCache({ fetched_at: now - 60, five_hour_pct: 77, seven_day_pct: 77 });
        cfg.usageFile = tf;
        try {
            const { accounts, cap } = e.readAccounts();
            assert.deepStrictEqual(accounts.map((x) => [x.label, x.provider, x.five_pct]), [['t1', 'claude', 50], ['codex', 'codex', 0]], 'the team file only, not the local cache');
            assert.ok(!('codex' in cap.loads) && !e.qualifies(accounts[1], { you: 't1', isSaved: () => true, relogin: new Set(), now }));
            const r = e.panelData(accounts, cap, opts).rows[1];
            assert.deepStrictEqual([r.icon, r.actions], ['readonly', []]);
        } finally { delete cfg.usageFile; }
    }));

    await check('codex: render escapes a Codex row too', () => {
        const bad = '<img src=x onerror="a()">';
        const d = { ...pdFour(), rows: [{ label: bad, provider: 'codex', icon: 'readonly', tip: 'Codex (read-only)', summary: '<q>', five: 1, week: 1,
            fiveReset: '<s>', weekReset: null, age: null, email: null, actions: [] }] };
        const html = panel().render(d, ui({ openRow: bad }));
        assert.ok(html.includes('&lt;img') && !html.includes('<img src=x') && !html.includes('onerror="'));
        assert.ok(!html.includes('<q>') && !html.includes('<s>') && html.includes('&lt;q&gt;') && html.includes('&lt;s&gt;'));
    });
});
