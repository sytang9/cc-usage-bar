// VS Code sidebar tests: the Automation toggle "Keep history when VS Code is closed" (ccswitch schedule).
'use strict';
const { assert, fs, path, HOME, LOG, check, run, said, stub, cfg, e, calls, four, capOf, opts, panel, ui } = require('./harness');

const ccswitch = path.join(HOME, '.claude', 'ccswitch');
const STATE = path.join(HOME, 'sched.state');
// A stub ccswitch with a working `schedule`: state in a file; $HOME/sched.rc makes `schedule on|off` fail,
// $HOME/sched.nocron makes `schedule status` fail like a machine without crontab.
fs.writeFileSync(ccswitch, `#!/usr/bin/env bash
echo "$*" >> "${LOG}"
[[ "$1" == version ]] && { cat "$HOME/version.out" 2>/dev/null || echo "ccswitch 1.3.0"; exit 0; }
if [[ "$1" == schedule ]]; then
  if [[ -e "$HOME/sched.nocron" ]]; then echo "Error: no 'crontab' command found" >&2; exit 2; fi
  case "$2" in
    status) if [[ -s "${STATE}" ]]; then echo '{"on":true,"every":'"$(cat "${STATE}")"'}'; else echo '{"on":false,"every":null}'; fi ;;
    on) [[ -e "$HOME/sched.rc" ]] && { echo "crontab refused" >&2; exit 2; }; echo 10 > "${STATE}" ;;
    off) [[ -e "$HOME/sched.rc" ]] && { echo "crontab refused" >&2; exit 2; }; : > "${STATE}" ;;
  esac
  exit 0
fi
exit 0
`);
fs.chmodSync(ccswitch, 0o755);
const reset = () => { for (const f of ['sched.rc', 'sched.nocron', 'version.out']) fs.rmSync(path.join(HOME, f), { force: true }); fs.writeFileSync(STATE, ''); fs.rmSync(LOG, { force: true }); said.length = 0; delete cfg.usageFile; };
const html = (schedule) => panel().render({ ...e.panelData(four(), capOf(four(), '002'), opts), schedule }, ui({ automationOpen: true }));

run(async () => {
    await check('scheduleRead: off, then on with the interval', async () => {
        reset();
        assert.deepStrictEqual(await e.scheduleRead(), { on: false, every: null });
        fs.writeFileSync(STATE, '15');
        assert.deepStrictEqual(await e.scheduleRead(), { on: true, every: 15 });
    });

    await check('scheduleRead: no crontab on this machine -> null (toggle hidden)', async () => {
        reset();
        fs.writeFileSync(path.join(HOME, 'sched.nocron'), '');
        assert.strictEqual(await e.scheduleRead(), null);
    });

    await check('scheduleRead: a team usage file hides the toggle and does not call ccswitch', async () => {
        reset();
        cfg.usageFile = '/some/team.json';
        assert.strictEqual(await e.scheduleRead(), null);
        assert.deepStrictEqual(calls(), []);
        delete cfg.usageFile;
    });

    await check('scheduleRead: ccswitch older than 1.3.0 -> { old }, and `schedule` is never run on it', async () => {
        reset();
        fs.writeFileSync(path.join(HOME, 'version.out'), 'ccswitch 1.2.0\n');
        assert.deepStrictEqual(await e.scheduleRead(), { old: true, on: false, every: null });
        assert.deepStrictEqual(calls(), ['version']);
    });

    await check('scheduleChange: on and off run `schedule on|off`, no shell', async () => {
        reset();
        await e.scheduleChange(true);
        assert.strictEqual(fs.readFileSync(STATE, 'utf8').trim(), '10');
        await e.scheduleChange(false);
        assert.strictEqual(fs.readFileSync(STATE, 'utf8').trim(), '');
        assert.deepStrictEqual(calls().filter((c) => c.startsWith('schedule')), ['schedule on', 'schedule off']);
        assert.deepStrictEqual(said, []);
    });

    await check('scheduleChange: a failure shows an error message with the reason', async () => {
        reset();
        fs.writeFileSync(path.join(HOME, 'sched.rc'), '');
        await e.scheduleChange(true);
        assert.strictEqual(said.length, 1);
        assert.match(said[0], /^ERROR Could not turn background history on: crontab refused/);
    });

    await check('scheduleChange: an old ccswitch gets the install/update offer, not a failed command', async () => {
        reset();
        fs.writeFileSync(path.join(HOME, 'version.out'), 'ccswitch 1.2.0\n');
        stub.answer = undefined;
        await e.scheduleChange(true);
        assert.strictEqual(said[0], 'Install ccswitch (cc-usage-bar)?');
        assert.ok(!calls().some((c) => c.startsWith('schedule')));
    });

    await check('the Automation section shows the toggle only when the host sends a schedule state', () => {
        const none = html(null), off = html({ on: false, every: null }), on = html({ on: true, every: 10 });
        assert.ok(!/data-a="sched"/.test(none), 'hidden when null');
        assert.match(off, /Keep history when VS Code is closed/);
        assert.match(off, /data-a="sched" role="switch" aria-checked="false"/);
        assert.match(on, /data-a="sched" role="switch" aria-checked="true"/);
        assert.match(on, /every 10 min/);
        assert.ok(/data-a="auto"/.test(on), 'the auto-switch toggle is still there');
    });

    await check('the toggle is inside the open Automation section only', () => {
        const closed = panel().render({ ...e.panelData(four(), capOf(four(), '002'), opts), schedule: { on: true, every: 10 } }, ui({ automationOpen: false }));
        assert.ok(!/data-a="sched"/.test(closed));
    });

    await check('the panel click posts toggleSchedule, and the host handler routes it', () => {
        const wv = fs.readFileSync(path.join(__dirname, '..', '..', 'vscode', 'webview', 'panel.js'), 'utf8');
        assert.match(wv, /a === 'sched'\) return vsc\.postMessage\(\{ toggleSchedule: 1 \}\)/);
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'vscode', 'extension.js'), 'utf8');
        assert.match(src, /else if \(m\.toggleSchedule\) toggleSchedule\(\)/);
        assert.match(src, /execFile\(cmd, args,/, 'ccswitch runs through execFile, never a shell');
    });
});
