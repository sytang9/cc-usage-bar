# cc-usage-bar

A multi-line Claude Code statusLine usage bar, plus `ccswitch` — a small CLI
for saving, switching between, and monitoring rate-limit headroom across
multiple Claude accounts.

```
Ctrl CV · jane@acme.com                 Opus 4.8 (1M context) · high
5H ▕▰▰▱▱▱▱▱▱▏  24% ↻ 3h 2m   ·   WK ▕▰▰▱▱▱▱▱▱▏  24% ↻ 3d 23h   ·   CTX ▕▰▰▱▱▱▱▱▱▏  19%
```

Two rows: identity + model on top, then three slim capsule meters — 5-hour,
weekly, and context window — on one line. Rendered in your terminal with
256-color ANSI. The capsule fill is a danger signal: sage under 60%, amber
60–85%, red above 85% — so a near-limit meter always reads red regardless of
which one it is. The `5H` / `WK` / `CTX` labels carry distinct calm tints so
they stay easy to tell apart; caps and the empty track are dim grey. The
block above is the plain-text equivalent.

## What it does

- **`statusline-usage.sh`** — a Claude Code `statusLine` script. Every render
  it reads the JSON Claude Code feeds it on stdin and prints two rows:
  account and model on top, then the 5-hour, weekly, and context-window
  meters (with reset countdowns) on one line underneath.
- **`ccswitch`** — save the currently logged-in Claude account under a
  label, list saved accounts, switch between them, or delete one.
- **`ccswitch usage`** — an all-account monitor: polls the 5h/weekly usage
  for every saved account so you can see at a glance which one has the most
  headroom, then optionally switch straight to it.

## Requirements

- `bash`, `jq` — required by both scripts.
- `date` — required by the bar and by `ccswitch usage` (the usage monitor);
  `ccswitch save/list/<label>/delete` don't call it.
- `curl` — required only by `ccswitch usage` (the usage monitor); the bar
  and `ccswitch save/list/<label>/delete` don't need it.
- Targets Claude Code on Linux and macOS.

## Install

```
git clone <this-repo-url>
cd cc-usage-bar
./install.sh
```

`install.sh`:

- Copies `statusline-usage.sh` and `ccswitch` into `~/.claude/` and makes
  them executable.
- Symlinks `ccswitch` into `~/.local/bin` so you can run it as a bare
  `ccswitch` command. If `~/.local/bin` isn't on your `PATH`, it prints the
  exact `export PATH=...` line to add (and meanwhile you can run it by full
  path, `~/.claude/ccswitch`).
- Checks `jq` is on `PATH` (hard requirement; exits with an install hint if
  missing) and warns, non-fatally, if `curl` is missing.
- Merges the `statusLine` entry into `~/.claude/settings.json` — creating
  the file if it doesn't exist, or backing it up to `settings.json.bak` and
  merging in place (via `jq`) if it does, so no other keys are touched.
- Offers to append a `ccw` shell function (switch-and-relaunch shorthand) to
  `~/.bashrc` (or `~/.zshrc` if your shell is zsh); only appends once.
- Is safe to run more than once. Run `./install.sh --print-only` to see
  exactly what it would write without touching anything.

To wire up the statusLine by hand instead, merge this into
`~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline-usage.sh",
    "refreshInterval": 5
  }
}
```

## Usage — the bar

Once the statusLine is configured, Claude Code renders two rows above the
prompt:

- **Row 1** — account identity (`org · email`, from `~/.claude.json`, when
  available) and the active model and effort level.
- **Row 2** — three capsule meters side by side: `5H` (rolling 5-hour rate
  limit) and `WK` (weekly rate limit), each with a reset countdown (`↻`),
  plus `CTX` (how full the current session's context window is).

Before Claude Code has received a first API response in the session, the `5H`
and `WK` meters show `—` instead of a bar. `settings.json`
sets `refreshInterval: 5`, so the bar redraws every 5 seconds; percentages
update in discrete steps as new usage data arrives from Claude Code — this
is not a smooth, mid-generation animation.

## Usage — ccswitch

**Enrollment model:** `ccswitch save <label>` snapshots whichever account is
*currently logged in* to Claude Code. To manage multiple accounts, log into
each one in turn and run `ccswitch save <label>` right after — there's no
way to save an account you aren't currently logged into.

```
ccswitch                     list saved accounts (same as `list`)
ccswitch list                list saved accounts; '*' marks the active one
ccswitch save <label>        snapshot the currently active account
ccswitch <label>             switch to a saved account
ccswitch <label> --relaunch  switch, then exec the `claude` CLI (override
                              the command with CCSWITCH_CLAUDE_CMD)
ccswitch delete <label>      remove a saved account (prompts to confirm)
ccswitch help                show the full command guide (also -h, --help)
```

Switching **requires restarting Claude Code** — see Caveats below. If you
accepted the `ccw` shell function during install, `ccw <label>` is shorthand
for `ccswitch <label> --relaunch`.

## Usage — the monitor

```
ccswitch usage [--no-switch] [--refresh] [--relaunch]
```

Shows 5-hour and weekly usage for every saved account in one table, with each
window's reset countdown, so you can decide where to switch before you do it:

```
  ACCOUNT     5H                  WEEK                RESET(5h)   RESET(wk)
* claude001   █▍··········  11%   ████········  33%   4h 11m      3d 21h
  claude003   ············   0%   ████████████ 100%   —           10h 0m
  shanyuan    █▌··········  12%   ▎···········   2%   1h 41m      5d 7h      <- most headroom
```

- The active account is starred; the one with the **most headroom** is flagged.
  Headroom accounts for *both* limits (the higher of 5h/weekly), so an account
  that is idle on 5h but maxed for the week is never flagged as free.
- `RESET(5h)` shows `—` when 5-hour usage is 0% (the API reports no active
  window to reset yet) — the row still shows real weekly numbers.
- After the table it prompts for a label to switch to (Enter cancels).

Flags:

- `--no-switch` — print the table and exit; skip the switch prompt.
- `--refresh` — bypass the 10-minute usage cache and poll live.
- `--relaunch` — if you do switch from the prompt, exec `claude` afterward
  (same behavior as `ccswitch <label> --relaunch`).

## Caveats / honest limitations

- **Switching requires restarting Claude Code.** A running session caches
  its auth in memory, so there's no hot-swap — `ccswitch <label>` swaps the
  credential files on disk, but the change only takes effect the next time
  Claude Code starts (which is what `--relaunch` / `ccw` automate).
- **The usage monitor uses an undocumented Anthropic OAuth endpoint.**
  `ccswitch usage` was built by reverse-engineering third-party projects,
  not from published API docs. It may break on a future Claude Code/Claude.ai
  update; when it does, affected rows simply show `—` rather than erroring.
- **The token-refresh host is best-effort, not confirmed.** If Anthropic
  moves it again, refreshes for that account will fail and its row shows
  `re-login` — re-run `ccswitch <label>` (or log in again) to fix it.
- **No per-model split.** Claude Code doesn't expose separate usage for
  Opus vs. Fable/Sonnet/Haiku — only aggregate 5-hour and weekly totals.
- **Claude.ai subscription (OAuth) accounts only.** The bar's rate-limit
  rows populate after Claude Code's first API response in the session; until
  then they show the waiting message described above.

## Security / privacy

OAuth tokens never leave your machine — they are never printed, logged, or
committed by anything here. Saved accounts live under `~/.claude/accounts/`
with the directory at mode `700` and every credential file inside it at mode
`600`.

## License

MIT — see [LICENSE](LICENSE).
