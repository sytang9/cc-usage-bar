// VS Code sidebar tests: the status bar text and tooltip, and the dialog and switch texts.
'use strict';
const {
    assert, fs, path, now, check, run, cfg, said, vscode, file, e, acct, capOf,
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

    await check('statusTooltip: a short markdown tip: the active account, 5h and weekly with resets, Next only when one qualifies', () => {
        const a = [...sbAcc(), acct('old', 5, 5, now - 7200), acct('dead', 5, 5, now - 13 * 86400)];
        const tip = e.statusTooltip(sb(a, 'work', ['dead']), a, false);
        assert.ok(tip instanceof vscode.MarkdownString && tip.supportThemeIcons && tip.supportHtml, 'a MarkdownString with theme icons and html');
        const lines = tip.value.split('\n\n');
        assert.deepStrictEqual(lines, ['**work** · active', '5h 100% · resets ' + e.resetText(now + 3600), 'Weekly 40% · resets ' + e.resetText(now + 86400),
            'Next: personal (5h 10%, weekly 5%)']);
        assert.ok(!tip.value.includes('dead') && !tip.value.includes('old'), 'no other account is listed');
        assert.ok(!tip.value.includes('Auto-switch'), 'no pill while auto-switch is off');
    });

    await check('statusTooltip: the Auto-switch ON pill only when on; no Next when nothing qualifies', () => {
        const a = [acct('work', 100, 40, now - 60), acct('old', 5, 5, now - 7200)];
        const on = e.statusTooltip(sb(a, 'work'), a, true).value.split('\n\n');
        assert.strictEqual(on[0], '**work** · active <span style="color:#fff;background-color:#0e639c;">&nbsp;$(sync) Auto-switch ON&nbsp;</span>');
        assert.ok(!on.some((l) => l.startsWith('Next')), 'the only other account is stale');
        assert.ok(!e.statusTooltip(sb(a, 'work'), a, false).value.includes('<span'));
    });

    await check('statusTooltip says the truth about the active account\'s data (fresh, stale, re-login, none) and has no active case', () => {
        const a = [acct('work', 100, 40, now - 60), acct('old', 5, 5, now - 7200)];
        assert.ok(!e.statusTooltip(sb(a, 'work'), a, false).value.includes('data '), 'fresh active: no age claim');
        assert.ok(e.statusTooltip(sb(a, 'old'), a, false).value.split('\n\n')[1].endsWith(' · data 2h old'));
        assert.ok(e.statusTooltip(sb(a, 'work', ['work']), a, false).value.split('\n\n')[1].endsWith(' · re-login'));
        const ghost = e.statusTooltip(sb(a, 'ghost'), a, false).value.split('\n\n');  // active, unsaved, in no list
        assert.deepStrictEqual(ghost.slice(0, 3), ['**ghost** · active', '5h – · no data', 'Weekly –']);
        const pill = '<span style="color:#fff;background-color:#0e639c;">&nbsp;$(sync) Auto-switch ON&nbsp;</span>';
        assert.deepStrictEqual(e.statusTooltip(sb(a, null), a, true).value.split('\n\n'), ['No active account ' + pill], 'no active, nothing qualifies');
        const b2 = sbAcc();
        assert.deepStrictEqual(e.statusTooltip(sb(b2, null), b2, false).value.split('\n\n'), ['No active account', 'Next: personal (5h 10%, weekly 5%)']);
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
