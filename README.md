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
- **`subagent-statusline.sh`** — a Claude Code `subagentStatusLine` script.
  It replaces each subagent's row in the agent panel with its type, label,
  model, session size (`ctx`), tokens read with the cached share (`tok`),
  cache misses, running time or done, and worktree.
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
- `node` — required only by `ccswitch usage` to refresh expired account tokens
  (the refresh endpoint is behind Cloudflare, which blocks headless `curl`;
  Node's client passes, same as Claude Code). Claude Code ships Node, so you
  already have it.
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

### Uninstall

```
./uninstall.sh
```

Removes the two scripts from `~/.claude`, the `~/.local/bin/ccswitch` symlink,
and the `statusLine` entry from `settings.json` — each only if it is still
ours, so a `statusLine` you have since repointed at your own script survives.
Your saved accounts under `~/.claude/accounts/` are **kept**: they are live
OAuth credentials that exist nowhere else. Add `--purge-accounts` to delete
them too (it asks first). `--print-only` shows what it would do.

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

## Usage — the subagent rows

While subagents run, Claude Code shows one row per agent below the prompt.
With `subagentStatusLine` configured, each row reads:

```
engineer · T4 roles · sonnet 5.5 · ctx 368k (36%) · tok 33.6M (99% cached) · 2 cache misses · running 18m · infrasel-sh-t4
```

- **`ctx 368k (36%)`** — the agent's session size now: the tokens in its
  context (its prompt plus everything it has read, written and said so far),
  and that as a share of its model's window. Amber from 60%, red above 85%. A
  role agent past 40% usually carries old work it no longer needs: finish it
  and start a fresh one. This is Claude Code's own per-agent `tokenCount`.
- **`tok 33.6M (99% cached)`** — every input token the agent's calls have read
  so far (each call re-reads the whole context), counted once per API call, and
  the share of it served from the prompt cache. A high cached share is good:
  cache reads cost about a tenth of fresh input.
- **`2 cache misses`** — calls that rewrote more than 100k tokens of cache after
  the first call: the cache expired while the agent sat idle (for example
  during a long foreground test run). Shown only when above zero.
- **`running 18m`** or **`done`** — still working, and for how long; or finished.
- The worktree name appears when the agent runs outside the lead's directory.

`tok` and the cache misses come from the agent's own transcript
(`~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`). The
script reads only new bytes each tick and keeps its offset under
`${XDG_CACHE_HOME:-~/.cache}/cc-usage-bar/subagents/`, so a tick costs about
30 ms after the first read. The rows show agents of the current session only;
the `5H` and `WK` meters of the main bar show what they cost the account.

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
ccswitch refresh-pause       stop refreshing tokens (usage stays readable)
ccswitch refresh-resume      re-enable token refresh
ccswitch version             print the version (also --version, -V)
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
- If an account's stored access token is rejected (expired, or revoked/rotated
  by a real Claude Code session), the monitor refreshes it automatically and
  retries. The token-refresh endpoint rate-limits bursts, so if too many
  accounts refresh at once a row may briefly show `rate-limited` — that is
  transient (the tool backs off and recovers), not a dead account. Only a
  genuine refresh failure shows `re-login`; then run `ccswitch <label>` (or log
  in again) to re-enroll that account.
- After the table it prompts for a label to switch to (Enter cancels).

Flags:

- `--no-switch` — print the table and exit; skip the switch prompt.
- `--refresh` — bypass the 10-minute usage cache and poll live.
- `--relaunch` — if you do switch from the prompt, exec `claude` afterward
  (same behavior as `ccswitch <label> --relaunch`).

### The Codex row

If Codex CLI is logged in with a ChatGPT plan (`auth_mode` `chatgpt` in
`${CODEX_HOME:-~/.codex}/auth.json`), the table gets one extra row, `codex`,
after the Claude accounts:

```
  codex       —                 ············   0%   —           6d 23h
```

- **Read-only.** ccswitch reads Codex's access token and calls the same usage
  endpoint Codex CLI uses. It never refreshes the token and never writes
  `auth.json`: a refresh would rotate the token under a running Codex CLI and
  log it out. When the token has expired or is rejected, the row shows
  `expired` until Codex itself refreshes it (run `codex` once).
- **Single account.** There is one Codex login per `CODEX_HOME`, and it is
  never offered as a switch target or flagged as most headroom.
- Windows the plan does not report show `—` (some plans report only the
  weekly window). Results are cached in `${CODEX_HOME:-~/.codex}/.usage-cache`
  (mode `600`, no token or account id) under the same 10-minute cache and
  429 backoff as the Claude rows.
- No Codex login, or an API-key login, means no row and no other change.

### Pausing token refresh

The token-refresh endpoint rate-limits per machine. If a burst of expired
accounts has you seeing `rate-limited` rows, stop adding pressure without
losing the usage view:

```
ccswitch refresh-pause       # usage still polls; no token refreshes at all
ccswitch refresh-resume      # back to normal
```

While paused, an account whose stored token has expired shows `rate-limited`
rather than being refreshed. The pause is a flag file under
`~/.claude/accounts/`, so it survives across runs until you resume.

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

## Development

Run every test suite:

```
bash tests/run_all.sh
```

Six self-contained bash suites (statusline, subagent rows, ccswitch,
ccswitch usage, the Codex row, installer). No test framework, no network:
each suite sandboxes `HOME` under `mktemp -d` and the usage suites answer
HTTP from a stub `curl` on `PATH`, so nothing ever touches your real
`~/.claude`, `~/.codex`, or either vendor's API. CI runs the same command on
every push and pull request.

Lint every script (CI runs the same command):

```
shellcheck --severity=warning --shell=bash ccswitch statusline-usage.sh install.sh uninstall.sh tests/*.sh
```

## License

MIT — see [LICENSE](LICENSE).
