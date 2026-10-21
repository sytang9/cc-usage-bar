// stats.js -- the data engine for the Stats view. Mirrors Claude Code CLI 2.1.305 `/stats` definitions
// (see the functions Bo, Gn, im, Lr, bo and Ci in the CLI bundle). Node built-ins only.
//
// buildStats() scans ~/.claude/projects, keeps a per-file aggregate in a JSON cache (reused while a
// file's size and mtimeMs are unchanged), and returns one plain object per range: '7d', '30d', 'all'.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const CACHE_VERSION = 1;
// Bump DEFS_VERSION whenever a counting rule changes (what counts as a message, a token kind, a session): a cache from
// other definitions is dropped, so every transcript is counted again under one rule.
const DEFS_VERSION = 1;
const MAX_READ = 104857600; // the CLI reads only the last 100 MB of a bigger transcript
const MESSAGE_TYPES = new Set(['user', 'assistant', 'attachment', 'system']);
const SYNTHETIC_MODEL = '<synthetic>';
const DAY_MS = 86400000;
const YIELD_MS = 8; // give the event loop a turn at least this often while parsing
const PARALLEL = 4;
const RANGE_LABELS = { '7d': 'Last 7 days', '30d': 'Last 30 days', all: 'All time' };

// The CLI's day key is the UTC date (toISOString), not the local date.
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day, n) => { const d = new Date(day); d.setUTCDate(d.getUTCDate() + n); return utcDay(d.getTime()); };
const localDay = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const tsMs = (t) => new Date(t).getTime(); // NaN for a missing or bad timestamp, as in the CLI

// --- file list: <projects>/<project>/*.jsonl and <projects>/<project>/<dir>/subagents/agent-*.jsonl ---
async function listFiles(projectsDir) {
    let projects;
    try { projects = await fs.promises.readdir(projectsDir, { withFileTypes: true }); } catch { return []; }
    const files = [];
    for (const p of projects) {
        if (!p.isDirectory()) continue;
        const dir = path.join(projectsDir, p.name);
        let entries;
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            if (e.isFile() && e.name.endsWith('.jsonl')) files.push(path.join(dir, e.name));
            else if (e.isDirectory()) {
                const sub = path.join(dir, e.name, 'subagents');
                let subs;
                try { subs = await fs.promises.readdir(sub, { withFileTypes: true }); } catch { continue; }
                for (const s of subs) {
                    if (s.isFile() && s.name.startsWith('agent-') && s.name.endsWith('.jsonl')) files.push(path.join(sub, s.name));
                }
            }
        }
    }
    return files;
}

// --- one file -> its aggregate ----------------------------------------------------------------
// { sub, session: {start, end} | null, msgs: {day: count}, tok: {day: {model: [in, out, cacheRead, cacheWrite]}} }
// A main transcript drops isSidechain lines; a subagent transcript adds tokens only (no messages, no session).
const EMPTY = (sub) => ({ sub, session: null, msgs: {}, tok: {} });

async function parseFile(file, size) {
    const sub = file.includes(`${path.sep}subagents${path.sep}`);
    const start = size > MAX_READ ? size - MAX_READ : 0;
    const rl = readline.createInterface({ input: fs.createReadStream(file, { start }), crlfDelay: Infinity });
    let first = null, last = null, skipLine = start > 0, firstLine = true;
    const msgs = {}, tok = {};
    let lastYield = Date.now();
    for await (let line of rl) {
        if (Date.now() - lastYield >= YIELD_MS) { await new Promise((r) => setImmediate(r)); lastYield = Date.now(); }
        if (skipLine) { skipLine = false; continue; } // a partial first line after a tail seek
        if (firstLine) { firstLine = false; if (line.charCodeAt(0) === 0xfeff) line = line.slice(1); }
        line = line.trim();
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        if (!isObject(e) || typeof e.type !== 'string' || !MESSAGE_TYPES.has(e.type)) continue;
        if (!sub && e.isSidechain) continue;
        if (first === null) first = e.timestamp;
        last = e.timestamp;
        const t = tsMs(e.timestamp);
        if (Number.isNaN(t)) continue;
        const day = utcDay(t);
        if (!sub) msgs[day] = (msgs[day] || 0) + 1;
        const m = e.message;
        if (e.type !== 'assistant' || !isObject(m) || !m.usage) continue;
        const model = m.model || 'unknown';
        if (model === SYNTHETIC_MODEL || model in Object.prototype) continue;
        const u = m.usage;
        const byModel = tok[day] || (tok[day] = {});
        const v = byModel[model] || (byModel[model] = [0, 0, 0, 0]);
        v[0] += num(u.input_tokens); v[1] += num(u.output_tokens);
        v[2] += num(u.cache_read_input_tokens); v[3] += num(u.cache_creation_input_tokens);
    }
    if (first === null) return EMPTY(sub);
    const s = tsMs(first), end = tsMs(last);
    if (Number.isNaN(s) || Number.isNaN(end)) return EMPTY(sub); // the CLI skips the whole file
    return { sub, session: { start: s, end }, msgs, tok };
}

// --- cache --------------------------------------------------------------------------------------
function readCache(cachePath) {
    try {
        const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (c && c.version === CACHE_VERSION && c.defs === DEFS_VERSION && isObject(c.files)) return c.files;
    } catch { /* missing or corrupt: start empty */ }
    return {};
}

// The cache names transcript paths (project folder names), so it is private: file 600, a new directory 700.
function writeCache(cachePath, files) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });  // a tmp left by a crash keeps its old mode
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, defs: DEFS_VERSION, files }), { mode: 0o600 });
    fs.renameSync(tmp, cachePath);
}

// A cache entry is reused only when every value is what parseFile writes: numbers (finite, valid as a date where
// they are one), day keys, model names parseFile would keep, and four-number token arrays. Anything else (a hand
// edit, schema drift) is parsed again, so it can neither break a build nor reach the panel.
const fin = Number.isFinite;
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d);
const isMs = (v) => fin(v) && !Number.isNaN(new Date(v).getTime());
const isModel = (m) => !(m in Object.prototype) && m !== SYNTHETIC_MODEL;
function isEntry(e) {
    if (!isObject(e) || !fin(e.size) || !fin(e.mtimeMs)) return false;
    const a = e.agg;
    if (!isObject(a) || typeof a.sub !== 'boolean' || !isObject(a.msgs) || !isObject(a.tok)) return false;
    if (a.session !== null && !(isObject(a.session) && isMs(a.session.start) && isMs(a.session.end))) return false;
    return Object.entries(a.msgs).every(([d, n]) => isDay(d) && fin(n))
        && Object.entries(a.tok).every(([d, byModel]) => isDay(d) && isObject(byModel)
            && Object.entries(byModel).every(([m, v]) => isModel(m) && Array.isArray(v) && v.length === 4 && v.every(fin)));
}

// --- aggregates -> one range ------------------------------------------------------------------------
const sumTokens = (m) => m.inputTokens + m.outputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens;

// Lr: current streak counts back from today (UTC day); a today without activity gives 0.
function streaks(days, today) {
    const set = new Set(days);
    let current = 0;
    for (let d = today; set.has(d); d = addDays(d, -1)) current++;
    const sorted = [...set].sort();
    let longest = 0, run = 0, prev = null;
    for (const d of sorted) {
        run = prev !== null && Math.round((new Date(d) - new Date(prev)) / DAY_MS) === 1 ? run + 1 : 1;
        if (run > longest) longest = run;
        prev = d;
    }
    return { currentStreak: current, longestStreak: longest };
}

function rangeStats(aggs, range, fromDay, toDay, today) {
    const inRange = (d) => (!fromDay || d >= fromDay) && (!toDay || d <= toDay);
    const daily = Object.create(null), usage = Object.create(null), perDay = Object.create(null), hours = {};  // keys are input: no prototype
    let totalMessages = 0, sessions = 0, longest = null, first = null, last = null;
    for (const a of aggs) {
        if (a.session && toDay && utcDay(a.session.start) > toDay) continue; // Bo: file starts after toDate
        if (!a.sub && a.session && inRange(utcDay(a.session.start))) {
            const s = a.session, duration = s.end - s.start;
            sessions++;
            if (!longest || duration > longest.ms) longest = { ms: duration, start: s.start };
            if (first === null || s.start < first) first = s.start;
            if (last === null || s.start > last) last = s.start;
            const h = new Date(s.start).getHours();
            hours[h] = (hours[h] || 0) + 1;
        }
        for (const [d, n] of Object.entries(a.msgs)) {
            if (!inRange(d)) continue;
            daily[d] = (daily[d] || 0) + n;
            totalMessages += n;
        }
        for (const [d, byModel] of Object.entries(a.tok)) {
            if (!inRange(d)) continue;
            for (const [model, v] of Object.entries(byModel)) {
                const m = usage[model] || (usage[model] = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
                m.inputTokens += v[0]; m.outputTokens += v[1]; m.cacheReadInputTokens += v[2]; m.cacheCreationInputTokens += v[3];
                const t = v[0] + v[1] + v[2] + v[3];
                if (t > 0) { const pd = perDay[d] || (perDay[d] = Object.create(null)); pd[model] = (pd[model] || 0) + t; }
            }
        }
    }
    const models = Object.entries(usage).map(([model, m]) => ({ model, ...m, totalTokens: sumTokens(m) }))
        .sort((x, y) => y.totalTokens - x.totalTokens);
    const days = Object.keys(daily).sort();
    const top3 = models.slice(0, 3).map((m) => m.model).filter((m) => Object.values(perDay).some((pd) => pd[m] > 0));
    const tokenDays = Object.keys(perDay).sort().map((date) => {
        const tokensByModel = {};
        for (const m of top3) tokensByModel[m] = perDay[date][m] || 0;
        return { date, tokensByModel };
    });
    let peakHour = null, peak = 0;
    for (let h = 0; h < 24; h++) if ((hours[h] || 0) > peak) { peak = hours[h]; peakHour = h; }
    const s = streaks(days, today);
    return {
        label: RANGE_LABELS[range],
        fromDate: fromDay,
        favoriteModel: models.length ? models[0].model : null,
        totalTokens: models.reduce((t, m) => t + m.totalTokens, 0),
        sessions,
        totalMessages,
        longestSession: longest && { ms: longest.ms, date: utcDay(longest.start), startedAt: new Date(longest.start).toISOString() },
        currentStreak: s.currentStreak,
        longestStreak: s.longestStreak,
        activeDays: days.length,
        // The dialog's "Active days: N/D": 7, 30, or the days from the first to the last session start.
        totalDays: range === '7d' ? 7 : range === '30d' ? 30
            : first !== null ? Math.ceil((last - first) / DAY_MS) + 1 : 0,
        peakHour,
        dailyActivity: days.map((date) => ({ date, messageCount: daily[date] })),
        models,
        tokensPerDay: { models: top3, days: tokenDays },
    };
}

// --- fun fact (Ci), with a per-day pick instead of Math.random ----------------------------------------
const BOOKS = [
    ['The Little Prince', 22000], ['The Old Man and the Sea', 35000], ['A Christmas Carol', 37000], ['Animal Farm', 39000],
    ['Fahrenheit 451', 60000], ['The Great Gatsby', 62000], ['Slaughterhouse-Five', 64000], ['Brave New World', 83000],
    ['The Catcher in the Rye', 95000], ["Harry Potter and the Philosopher's Stone", 103000], ['The Hobbit', 123000],
    ['1984', 123000], ['To Kill a Mockingbird', 130000], ['Pride and Prejudice', 156000], ['Dune', 244000],
    ['Moby-Dick', 268000], ['Crime and Punishment', 274000], ['A Game of Thrones', 381000], ['Anna Karenina', 468000],
    ['Don Quixote', 520000], ['The Lord of the Rings', 576000], ['The Count of Monte Cristo', 603000],
    ['Les Misérables', 689000], ['War and Peace', 730000],
];
const DURATIONS = [
    ['a TED talk', 18], ['an episode of The Office', 22], ['listening to Abbey Road', 47], ['a yoga class', 60],
    ['a World Cup soccer match', 90], ['a half marathon (average time)', 120], ['the movie Inception', 148],
    ['watching Titanic', 195], ['a transatlantic flight', 420], ['a full night of sleep', 480],
];

function funFacts(r) {
    const out = [];
    const io = (r.models || []).reduce((t, m) => t + (m.inputTokens || 0) + (m.outputTokens || 0), 0);
    if (io > 0) {
        for (const [name, tokens] of BOOKS) {
            if (io < tokens) continue;
            const x = io / tokens;
            out.push(x >= 2 ? `Your input and output are ~${Math.floor(x)}x the tokens in ${name}`
                : `Your input and output are about as many tokens as ${name}`);
        }
    }
    if (r.longestSession) {
        const min = r.longestSession.ms / 60000;
        for (const [name, minutes] of DURATIONS) {
            const x = min / minutes;
            if (x >= 2) out.push(`Your longest session is ~${Math.floor(x)}x longer than ${name}`);
        }
    }
    return out;
}

function funFact(rangeStats, dayKey) {
    const facts = funFacts(rangeStats);
    if (facts.length === 0) return '';
    let h = 0x811c9dc5; // FNV-1a over the day key: the same fact all day, a new one tomorrow
    for (const c of String(dayKey)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    return facts[h % facts.length];
}

// --- heatmap levels (Wd/$d): 0 = none, 1-4 by the 25th/50th/75th percentile of the non-zero days -------
function heatmapThresholds(dailyActivity) {
    const v = dailyActivity.map((d) => d.messageCount).filter((n) => n > 0).sort((a, b) => a - b);
    if (v.length === 0) return null;
    return { p25: v[Math.floor(v.length * 0.25)], p50: v[Math.floor(v.length * 0.5)], p75: v[Math.floor(v.length * 0.75)] };
}
function heatmapLevel(count, t) {
    if (count === 0 || !t) return 0;
    return count >= t.p75 ? 4 : count >= t.p50 ? 3 : count >= t.p25 ? 2 : 1;
}

// --- entry point ----------------------------------------------------------------------------------
async function buildStats({ projectsDir, cachePath, now, log } = {}) {
    projectsDir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
    const nowMs = now === undefined ? Date.now() : new Date(now).getTime();
    const say = typeof log === 'function' ? log : () => {};
    const t0 = Date.now();
    const old = cachePath ? readCache(cachePath) : {};
    const files = await listFiles(projectsDir);
    const fresh = {};
    let parsed = 0, reused = 0, failed = 0;
    let next = 0;
    const worker = async () => {
        while (next < files.length) {
            const f = files[next++];
            let st;
            try { st = await fs.promises.stat(f); } catch { failed++; continue; }
            const hit = old[f];
            // Reuse only a well-formed entry: a bad one (hand edit, schema drift) is parsed again, not kept for good.
            if (isEntry(hit) && hit.size === st.size && hit.mtimeMs === st.mtimeMs) { fresh[f] = hit; reused++; continue; }
            try {
                fresh[f] = { size: st.size, mtimeMs: st.mtimeMs, agg: await parseFile(f, st.size) };
                parsed++;
            } catch (e) { failed++; say(`stats: cannot read ${f}: ${e.message}`); }
        }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    const dropped = Object.keys(old).filter((f) => !(f in fresh)).length;
    if (cachePath && (parsed > 0 || dropped > 0 || Object.keys(old).length !== Object.keys(fresh).length)) {
        try { writeCache(cachePath, fresh); } catch (e) { say(`stats: cannot write cache: ${e.message}`); }
    }
    const aggs = Object.values(fresh).map((e) => e.agg);
    const today = utcDay(nowMs);
    const from = (n) => { const d = new Date(nowMs); d.setDate(d.getDate() - n + 1); return utcDay(d.getTime()); };
    const out = {
        '7d': rangeStats(aggs, '7d', from(7), null, today),
        '30d': rangeStats(aggs, '30d', from(30), null, today),
        all: rangeStats(aggs, 'all', null, today, today),
    };
    const dayKey = localDay(nowMs);
    for (const r of Object.keys(out)) {
        out[r].currentStreak = out.all.currentStreak; // the dialog always shows the all-time current streak
        out[r].funFact = funFact(out[r], dayKey);
    }
    out.meta = { files: files.length, parsed, reused, dropped, failed, ms: Date.now() - t0, today, dayKey };
    say(`stats: ${files.length} files, ${parsed} parsed, ${reused} reused, ${dropped} dropped in ${out.meta.ms} ms`);
    return out;
}

module.exports = { buildStats, funFact, funFacts, heatmapThresholds, heatmapLevel, listFiles, parseFile };
