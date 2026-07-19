# cc-usage-bar

A multi-line Claude Code statusLine usage bar, plus `ccswitch` — a small CLI
for saving, switching between, and monitoring rate-limit headroom across
multiple Claude accounts.

```
Acme Corp · jane@acme.com    Fable · high    ctx ██████▌········· 41%
5H     ████████████▌··· 78%   ↻ 2h 14m
WEEK   ███▉············ 24%   ↻ 3d 9h
```

(Rendered in your terminal with 256-color ANSI: sage when a meter is under
60%, amber from 60–85%, red above 85%. The block above is the plain-text
equivalent.)

## What it does

- **`statusline-usage.sh`** — a Claude Code `statusLine` script. Every render
  it reads the JSON Claude Code feeds it on stdin and prints three rows:
  account/model/context on top, then 5-hour and weekly rate-limit meters
  with reset countdowns underneath.
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

Once the statusLine is configured, Claude Code renders three rows above the
prompt:

- **Row 1** — account identity (`org · email`, from `~/.claude.json`, when
  available), the active model and effort level, and a context-window meter
  (`ctx`).
- **Row 2** — `5H`: percentage of your rolling 5-hour rate limit used, with
  a countdown (`↻`) to when it resets.
- **Row 3** — `WEEK`: percentage of your weekly rate limit used, with the
  same kind of countdown.

Before Claude Code has received a first API response in the session, rows 2
and 3 show `— waiting for first API call` instead of a meter. `settings.json`
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
```

Switching **requires restarting Claude Code** — see Caveats below. If you
accepted the `ccw` shell function during install, `ccw <label>` is shorthand
for `ccswitch <label> --relaunch`.

## Usage — the monitor

```
ccswitch usage [--no-switch] [--refresh] [--relaunch]
```

Shows 5h/weekly usage for every saved account in one table — active account
starred, the account with the most headroom flagged — so you can decide
where to switch before you do it. After the table, it prompts for a label to
switch to (Enter cancels).

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
