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

    const cells = (md) => ({ full: (md.match(/█/g) || []).length, empty: (md.match(/░/g) || []).length });
    const AUTO_TOGGLE = ['claudeUsage.refresh', 'claudeUsage.toggleAutoSwitch'];

    await check('statusTooltip: label + refresh link, 5h and Weekly bars with percent and reset, auto-switch line; trusted for exactly two commands', () => {
        const a = [...sbAcc(), acct('old', 5, 5, now - 7200), acct('dead', 5, 5, now - 13 * 86400)];
        const tip = e.statusTooltip(sb(a, 'work', ['dead']), a, false);
        assert.ok(tip instanceof vscode.MarkdownString && tip.supportThemeIcons && tip.supportHtml, 'a MarkdownString with theme icons and html');
        assert.deepStrictEqual(tip.isTrusted, { enabledCommands: AUTO_TOGGLE }, 'trusted for exactly the two commands');
        const lines = tip.value.split('\n\n');
        const nb = '&nbsp;';
        assert.strictEqual(lines[0], '**work**' + nb + nb + '[$(refresh)](command:claudeUsage.refresh "Refresh usage now")');
        assert.ok(lines[1].startsWith('5h' + nb.repeat(6)) && lines[1].endsWith(nb + nb + '100%' + nb + '· resets ' + e.resetText(now + 3600)), lines[1]);
        assert.ok(lines[2].startsWith('Weekly' + nb + nb) && lines[2].endsWith(nb + nb + '40%' + nb + '· resets ' + e.resetText(now + 86400)), lines[2]);
        assert.deepStrictEqual(cells(lines[1]), { full: 10, empty: 0 });
        assert.deepStrictEqual(cells(lines[2]), { full: 4, empty: 6 });
        assert.strictEqual(lines[3], '$(circle-slash) Auto-switch off · next personal' + nb + nb + '[$(play)](command:claudeUsage.toggleAutoSwitch "Turn auto-switch on")');
        assert.ok(!tip.value.includes('dead') && !tip.value.includes('old'), 'no other account is listed');
    });

    await check('statusTooltip: bar colours (blue below 80, orange from 80), rounding to the nearest cell, 0% all empty, unknown % no bar', () => {
        const mk = (five, week) => { const a = [acct('work', five, week, now - 60)]; return e.statusTooltip(sb(a, 'work'), a, false).value.split('\n\n'); };
        const [, r5, rw] = mk(79, 80);
        assert.ok(r5.includes('<span style="color:#3794ff;">') && !r5.includes('#e8590c'), r5);
        assert.ok(rw.includes('<span style="color:#e8590c;">') && !rw.includes('#3794ff'), rw);
        assert.deepStrictEqual(cells(r5), { full: 8, empty: 2 });   // 79% -> 8 cells
        assert.deepStrictEqual(cells(mk(14, 15)[1]), { full: 1, empty: 9 });
        assert.deepStrictEqual(cells(mk(14, 15)[2]), { full: 2, empty: 8 });  // 1.5 rounds up
        const zero = mk(0, 0)[1];
        assert.deepStrictEqual(cells(zero), { full: 0, empty: 10 });
        assert.ok(!zero.includes('#3794ff') && zero.includes('0%'), zero);
        const unk = mk(null, 30);
        assert.ok(!/[█░]/.test(unk[1]) && unk[1].includes('–'), unk[1]);
        assert.ok(/[█░]/.test(unk[2]));
    });

    await check('statusTooltip: auto-switch on / off / no candidate, with the toggle link', () => {
        const a = sbAcc();
        const on = e.statusTooltip(sb(a, 'work'), a, true).value.split('\n\n').pop();
        assert.ok(on.startsWith('$(sync) Auto-switch on → personal'), on);
        assert.ok(on.includes('[$(debug-pause)](command:claudeUsage.toggleAutoSwitch "Turn auto-switch off")'), on);
        const lone = [acct('work', 100, 40, now - 60), acct('old', 5, 5, now - 7200)];
        assert.ok(e.statusTooltip(sb(lone, 'work'), lone, true).value.split('\n\n').pop().startsWith('$(sync) Auto-switch on → none'));
        const off = e.statusTooltip(sb(lone, 'work'), lone, false).value.split('\n\n').pop();
        assert.ok(off.startsWith('$(circle-slash) Auto-switch off') && !off.includes('next') && off.includes('[$(play)](command:claudeUsage.toggleAutoSwitch "Turn auto-switch on")'), off);
        assert.ok(!e.statusTooltip(sb(a, 'work'), a, true).value.includes('Next:') && !e.statusTooltip(sb(a, 'work'), a, true).value.includes('pill'));
    });

    await check('statusTooltip: hostile labels come out inert (no injected command link, html or icon)', () => {
        for (const bad of ['x](command:workbench.action.terminal.new)', '<img src=x>', '$(x)', '`a`[b](c)']) {
            const a = [acct(bad, 50, 40, now - 60), acct('personal', 10, 5, now - 30)];
            for (const tip of [e.statusTooltip(sb(a, bad), a, true), e.statusTooltip({ ...sb(a, 'personal'), best: { label: bad, five: 1, week: 2 } }, a, true)]) {
                const v = tip.value;
                assert.ok(!v.includes('<img') && !/(^|[^\\])\$\(x/.test(v) && !/(^|[^\\])\]\(/.test(v.replace(/\[\$\([a-z-]+\)\]\(command:claudeUsage\.\w+ "[^"]*"\)/g, '')) && !/(^|[^\\])`/.test(v), v);
                assert.deepStrictEqual(tip.isTrusted, { enabledCommands: AUTO_TOGGLE });
            }
        }
        const links = (v) => v.match(/\]\(command:[^)]*\)/g) || [];
        const a = [acct('x](command:workbench.action.terminal.new)', 50, 40, now - 60)];
        assert.strictEqual(links(e.statusTooltip(sb(a, a[0].label), a, true).value).length, 2, 'only the two real links');
    });

    await check('statusTooltip says the truth about the active account\'s data (fresh, stale, re-login, none) and has no active case', () => {
        const a = [acct('work', 100, 40, now - 60), acct('old', 5, 5, now - 7200)];
        assert.ok(!e.statusTooltip(sb(a, 'work'), a, false).value.includes('data '), 'fresh active: no age claim');
        assert.ok(e.statusTooltip(sb(a, 'old'), a, false).value.split('\n\n')[1].endsWith(' · data 2h old'));
        assert.ok(e.statusTooltip(sb(a, 'work', ['work']), a, false).value.split('\n\n')[1].endsWith(' · re-login'));
        const ghost = e.statusTooltip(sb(a, 'ghost'), a, false).value.split('\n\n');  // active, unsaved, in no list
        assert.ok(ghost[1].endsWith('– · no data') && ghost[2] === 'Weekly&nbsp;&nbsp;–', ghost.join('|'));
        const none = e.statusTooltip(sb(a, null), a, true).value.split('\n\n');
        assert.strictEqual(none.length, 2);
        assert.ok(none[0].startsWith('No active account&nbsp;&nbsp;[$(refresh)](command:claudeUsage.refresh') && none[1].startsWith('$(sync) Auto-switch on → none'), none.join('|'));
        const b2 = sbAcc();
        assert.ok(e.statusTooltip(sb(b2, null), b2, false).value.split('\n\n')[1].startsWith('$(circle-slash) Auto-switch off · next personal'));
        assert.ok(!/over 30 min/.test(fs.readFileSync(file, 'utf8')), 'the old unconditional claim is gone');
    });

    await check('statusText: a running fetch shows $(sync~spin) with auto-switch on or off; the rest is unchanged; the pill code is gone', () => {
        const a = sbAcc();
        assert.strictEqual(e.statusText(sb(a, 'work'), a, false, true), '$(sync~spin) ● work 100%/40% · ⇄ personal');
        assert.strictEqual(e.statusText(sb(a, 'work'), a, true, true), '$(sync~spin) ● work 100%/40% · ⇄ personal');
        assert.strictEqual(e.statusText(sb(a, null), a, false, true), '$(sync~spin) ● none');
        assert.strictEqual(e.statusText(sb(a, 'work'), a, true), '$(sync) ● work 100%/40% · ⇄ personal');
        assert.ok(!/PILL|Auto-switch ON/.test(fs.readFileSync(file, 'utf8')), 'no pill');
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

    await check('switch texts agree with ccswitch: open Claude Code tabs follow on their next message', () => {
        const src = fs.readFileSync(file, 'utf8');
        assert.match(src, /from their next message/i);
    });

    await check('no shipped string says a restart is needed', () => {
        const root = require('path').join(__dirname, '..', '..');
        for (const f of ['README.md', 'ccswitch', 'vscode/extension.js', 'vscode/webview/panel.js', 'vscode/package.json']) {
            const t = fs.readFileSync(require('path').join(root, f), 'utf8');
            assert.ok(!/restart open Claude Code/i.test(t), f + ' still says "restart open Claude Code"');
            assert.ok(!/requires restarting Claude Code|restart Claude Code to apply/i.test(t), f + ' still claims a restart is needed');
        }
    });

    await check('a failed settings write shows an error message instead of vanishing', async () => {
        const realUpdate = vscode.workspace.getConfiguration;
        vscode.workspace.getConfiguration = () => ({ get: (k) => cfg[k], update: async () => { throw new Error('settings.json is read-only'); } });
        said.length = 0;
        try { await e.changeAutoSwitch(false); } finally { vscode.workspace.getConfiguration = realUpdate; }
        assert.deepStrictEqual(said, ['ERROR Could not change auto-switch: settings.json is read-only']);
    });
});
