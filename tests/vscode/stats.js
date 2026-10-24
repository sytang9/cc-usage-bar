// VS Code sidebar tests: the Stats view (statsFeed and the Stats tab render).
'use strict';
const {
    assert, fs, path, now, check, run, file, e, pdFour, readWv, panel, ui, withHist, rising,
} = require('./harness');

run(async () => {
    // --- Stats view (stats.js output, drawn by the panel) ---------------------------------------------
    const rangeOf = (over = {}) => ({ label: 'x', fromDate: '2026-10-01', favoriteModel: 'claude-opus-5-5', totalTokens: 23245249596, sessions: 57, totalMessages: 900,
        longestSession: { ms: (41 * 24 + 21) * 3600000, date: '2026-08-26' }, currentStreak: 3, longestStreak: 6, activeDays: 35, totalDays: 56, peakHour: 9,
        dailyActivity: [{ date: '2026-10-20', messageCount: 40 }, { date: '2026-10-21', messageCount: 10 }, { date: '2026-10-19', messageCount: 5 }, { date: '2026-10-18', messageCount: 80 }],
        models: [{ model: 'claude-opus-5-5', inputTokens: 1500, outputTokens: 2500000 }],
        tokensPerDay: { models: ['claude-opus-5-5', 'claude-sonnet-5-5'], days: [{ date: '2026-10-20', tokensByModel: { 'claude-opus-5-5': 10, 'claude-sonnet-5-5': 4 } }, { date: '2026-10-21', tokensByModel: { 'claude-opus-5-5': 20 } }] },
        funFact: 'Your input and output are ~3x the tokens in The Hobbit', ...over });
    const statsMsg = (over = {}) => ({ kind: 'stats', stats: { '7d': rangeOf({ sessions: 7, funFact: 'seven' }), '30d': rangeOf({ sessions: 30 }), all: rangeOf(), meta: { today: '2026-10-21' } }, ...over });

    await check('statsFeed: builds once, then reuses for 10 min; one build at a time; an error keeps the last stats', async () => {
        const sent = [], builds = [];
        let fail = false;
        const build = async (o) => { builds.push(o.cachePath); if (fail) throw new Error('boom'); return { n: builds.length }; };
        const feed = e.statsFeed('/tmp/c.json', (m) => sent.push(m), build);
        const first = feed();
        assert.strictEqual(feed(), undefined, 'a second request while building does nothing');
        await first;
        assert.deepStrictEqual(sent.map((m) => [m.building || false, m.stats ? m.stats.n : null]), [[true, null], [false, 1]]);
        feed();
        assert.strictEqual(builds.length, 1, 'within 10 min: the last result is sent again, no rebuild');
        assert.deepStrictEqual(sent[2].stats, { n: 1 });
        const real = Date.now;
        try {
            Date.now = () => real() + e.STATS_EVERY_MS + 1000;
            fail = true;
            await feed();
            assert.strictEqual(builds.length, 2);
            const last = sent[sent.length - 1];
            assert.strictEqual(last.error, 'boom');
            assert.deepStrictEqual(last.stats, { n: 1 }, 'the last good stats stay on screen');
        } finally { Date.now = real; }
        assert.deepStrictEqual(builds, ['/tmp/c.json', '/tmp/c.json']);
        const src = fs.readFileSync(file, 'utf8');
        assert.match(src, /statsFeed\(path\.join\(context\.globalStorageUri\.fsPath, 'stats-cache\.json'\)/, 'the cache lives in global storage');
        assert.match(src, /m\.wantStats\) \{ if \(v\.visible\) wantStats\(\); \}/, 'a hidden, retained Stats tab never rebuilds (review finding)');
        assert.match(src, /v\.onDidChangeVisibility\(\(\) => \{ if \(v\.visible\) push\(\); \}\)/, 'shown again: the panel gets data and can ask');
    });

    await check('statsFeed: a failed build is retried after about a minute, not kept for 10 min (review finding)', async () => {
        const sent = [];
        let fail = true, builds = 0;
        const feed = e.statsFeed('/tmp/c.json', (m) => sent.push(m), async () => { builds++; if (fail) throw new Error('boom'); return { n: builds }; });
        const real = Date.now, t0 = real();
        try {
            Date.now = () => t0;
            await feed();
            assert.strictEqual(sent[sent.length - 1].error, 'boom');
            feed();
            assert.strictEqual(builds, 1, 'right after a failure: the error is sent again, no rebuild loop');
            assert.ok(e.STATS_RETRY_MS <= 2 * 60 * 1000 && e.STATS_RETRY_MS < e.STATS_EVERY_MS);
            Date.now = () => t0 + e.STATS_RETRY_MS + 1000;
            fail = false;
            await feed();
            assert.strictEqual(builds, 2, 'a minute later: built again');
            assert.deepStrictEqual(sent[sent.length - 1].stats, { n: 2 });
            fail = true;
            Date.now = () => t0 + e.STATS_RETRY_MS + 1000 + e.STATS_EVERY_MS + 1000;
            await feed();
            Date.now = () => t0 + 2 * e.STATS_RETRY_MS + 3000 + e.STATS_EVERY_MS;
            await feed();
            assert.strictEqual(builds, 4, 'a failure after a good build is retried a minute later too');
            assert.deepStrictEqual(sent[sent.length - 1].stats, { n: 2 }, 'the last good stats stay on screen');
        } finally { Date.now = real; }
    });

    await check('render: Stats tab; building, error, and the overview like the CLI /stats', () => {
        const p = panel();
        assert.ok(p.render(pdFour(), ui({ view: 'stats' }), null).includes('Building stats'));
        assert.ok(p.render(pdFour(), ui({ view: 'stats' }), { kind: 'stats', error: '<x>' }).includes('Stats failed: &lt;x&gt;'));
        const html = p.render(pdFour(), ui({ view: 'stats' }), statsMsg());
        assert.ok(html.includes('aria-selected="true" data-a="view" data-l="stats"'));
        assert.ok(html.includes('This machine · all accounts') && !html.includes('updating'));
        let at = 0;
        for (const t of ['data-l="all">All time', 'Activity', 'Overview', 'Favorite model', 'claude-opus-5-5', 'Total tokens', '23.2B', 'Sessions', '>57<',
            'Longest session', '41d 21h', '2026-08-26', 'Current streak', '3 days', 'Longest streak', '6 days', 'Active days', '35/56', 'Peak hour', '09:00-10:00',
            'The Hobbit', 'Tokens per day', 'Models', 'In 1.5k · Out 2.5M']) { const k = html.indexOf(t, at); assert.ok(k >= 0, 'in order: ' + t); at = k; }
        assert.strictEqual(html.split('<rect ').length - 1, 25 * 7 + 4, '26 weeks of days: 25 full weeks, then Sunday to today (a Wednesday)');
        assert.match(html, /class="lv4"[^>]*><title>2026-10-18: 80 messages/);
        assert.match(html, /class="lv0"[^>]*><title>2026-10-17: 0 messages/);
        assert.strictEqual(html.split('<polyline class="ln m').length - 1, 2, 'one line per top model');
        assert.ok(p.render(pdFour(), ui({ view: 'stats' }), statsMsg({ building: true })).includes('updating…'), 'a rebuild keeps the old stats on screen');
    });

    await check('render: Stats ranges switch the numbers; the current streak is always all-time; text is escaped', () => {
        const p = panel();
        const week = p.render(pdFour(), ui({ view: 'stats', statsRange: '7d' }), statsMsg());
        assert.ok(week.includes('aria-selected="true" data-a="srange" data-l="7d"') && week.includes('>7<') && week.includes('seven'));
        const bad = statsMsg();
        bad.stats.all = rangeOf({ favoriteModel: '<img src=x>', funFact: '<b>f</b>', models: [{ model: '<m>', inputTokens: 1, outputTokens: 1 }],
            tokensPerDay: { models: ['<q>'], days: [{ date: '<d>', tokensByModel: {} }] } });
        const html = p.render(pdFour(), ui({ view: 'stats' }), bad);
        assert.ok(!/<img src=x|<b>f|<m>|<q>|<d>/.test(html), 'escaped');
        const src = readWv('panel.js');
        assert.match(src, /ev\.data\.kind === 'stats'\) stats = ev\.data/, 'stats messages do not replace the account data');
        assert.match(src, /l === 'stats'\) vsc\.postMessage\(\{ wantStats: 1 \}\)/, 'opening the tab asks for stats');
    });

    await check('render: a non-number where Stats or History expects a number never reaches the HTML (review finding)', () => {
        const p = panel(), x = '<img src=x onerror=a()>';
        const st = statsMsg();
        st.stats.all = rangeOf({ totalTokens: x, sessions: x, activeDays: x, totalDays: x, longestStreak: x, peakHour: x, currentStreak: x,
            longestSession: { ms: x, date: '2026-08-26' }, dailyActivity: [{ date: '2026-10-20', messageCount: x }, { date: '2026-10-21', messageCount: 3 }],
            models: [{ model: 'm', inputTokens: x, outputTokens: { toString: () => x } }],
            tokensPerDay: { models: ['m'], days: [{ date: '2026-10-20', tokensByModel: { m: x } }, { date: '2026-10-21', tokensByModel: { m: 5 } }] } });
        st.stats.all.currentStreak = x;
        const html = p.render(pdFour(), ui({ view: 'stats' }), st);
        assert.ok(!html.includes('<img'), 'stats: ' + html.slice(html.indexOf('<img') - 80, html.indexOf('<img') + 20));
        assert.ok(html.includes('Sessions</span><span class="v">–<'), 'a bad number shows a dash');
        const h = { ...withHist(rising), history: [{ label: 'a', icon: 'switch', tip: 't', five: x, week: '9" onmouseover="a()',
            fiveSeries: [[x, x, x], [now, 5, null]], weekSeries: [[now, { toString: () => x }, null]], fivePace: null, weekPace: null }] };
        const hist = p.render(h, ui({ view: 'history' }));
        assert.ok(!hist.includes('<img') && !hist.includes('onmouseover'), 'history: ' + hist.slice(0, 400));
        assert.ok(!p.render({ ...pdFour(), active: { ...pdFour().active, five: x } }, ui()).includes('<img'), 'the Usage bars too');
    });
});
