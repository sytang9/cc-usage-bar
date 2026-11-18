// VS Code sidebar tests: the update check (a newer version on GitHub main -> offer the installer with --vscode).
'use strict';
const { assert, check, run, said, stub, e, memento } = require('./harness');

run(async () => {
    const current = require('../../vscode/package.json').version;
    const bump = current.replace(/\d+$/, (n) => String(Number(n) + 1));
    const DAY = 24 * 3600 * 1000, t0 = Date.now();
    const ask = async (latest, answer, state = memento(false), now = t0) => {
        said.length = 0; stub.answer = answer;
        await e.checkUpdate(state, async () => latest, now);
        return said.slice();
    };

    await check('update: newer() compares numerically, equal is not newer', () => {
        assert.ok(e.newer('1.10.0', '1.9.9') && e.newer('2.0.0', '1.99.99') && !e.newer('1.8.3', '1.8.3') && !e.newer('1.8.2', '1.8.3'));
    });
    await check('update: same, older, missing or malformed versions never prompt', async () => {
        for (const v of [current, '0.0.1', null, '1.2', `${bump}; rm -rf ~`, 42]) assert.deepStrictEqual(await ask(v, 'Update now'), [], String(v));
    });
    await check('update: a newer version prompts; Update now runs the installer with --vscode in a terminal', async () => {
        const out = await ask(bump, 'Update now');
        assert.strictEqual(out[0], `Claude Usage ${bump} is available (you have ${current}).`);
        assert.match(out[1], /^TERMINAL .*cc-usage-bar\.git .*&& bash "\$HOME\/\.local\/share\/cc-usage-bar\/install\.sh" --vscode$/);
    });
    await check('update: Later stays quiet for a day, then asks again', async () => {
        const state = memento(false);
        assert.strictEqual((await ask(bump, 'Later', state)).length, 1);
        assert.strictEqual(state.get(e.SNOOZE_KEY), t0);
        assert.deepStrictEqual(await ask(bump, 'Update now', state, t0 + DAY - 1), [], 'within the day');
        assert.strictEqual((await ask(bump, undefined, state, t0 + DAY)).length, 1, 'a day on');
    });
});
