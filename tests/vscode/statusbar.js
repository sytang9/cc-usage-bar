// VS Code sidebar tests: the status bar text and tooltip, and the dialog and switch texts.
'use strict';
const {
    assert, fs, path, now, check, run, seat, ccswitch, cfg, said, vscode, file, e, acct, capOf,
} = require('./harness');

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
        assert.ok(!fs.existsSync(path.join(__dirname, '..', '..', 'vscode', 'ui')));
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
});
