export function renderDashboardHtml(instanceId) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Katabatic Research Dashboard</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--background-color-default, #0d1117);
      color: var(--text-color-default, #f0f6fc);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }
    main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { display: flex; justify-content: space-between; gap: 16px; align-items: start; margin-bottom: 22px; }
    .controls { display: flex; align-items: end; gap: 10px; }
    .control { display: grid; gap: 4px; }
    .control label { color: var(--text-color-muted, #8b949e); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
    .threshold-wrap { display: flex; align-items: center; gap: 8px; }
    input[type="range"] { width: 150px; accent-color: var(--color-focus-outline, #58a6ff); }
    output { min-width: 50px; font-weight: 600; font-variant-numeric: tabular-nums; }
    h1 { margin: 0 0 4px; font-size: var(--text-title-large, 26px); line-height: 1.2; }
    h2 { margin: 0 0 12px; font-size: var(--text-title-medium, 18px); }
    .muted { color: var(--text-color-muted, #8b949e); }
    .eyebrow { text-transform: uppercase; letter-spacing: .08em; font-size: 11px; font-weight: 600; }
    button {
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 7px;
      background: var(--background-color-muted, #21262d);
      color: inherit;
      padding: 7px 12px;
      font: inherit;
      cursor: pointer;
    }
    button:hover { border-color: var(--text-color-muted, #8b949e); }
    button:focus { outline: 2px solid var(--color-focus-outline, #58a6ff); outline-offset: 2px; }
    .notice {
      margin-bottom: 18px;
      padding: 14px 16px;
      border: 1px solid #d29922;
      border-radius: 10px;
      background: color-mix(in srgb, #d29922 10%, transparent);
    }
    .notice strong { color: #d29922; }
    .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card, .panel {
      border: 1px solid var(--border-color-default, #30363d);
      border-radius: 10px;
      background: var(--background-color-subtle, #161b22);
    }
    .card { padding: 16px; }
    .metric { font-size: 25px; font-weight: var(--font-weight-semibold, 600); line-height: 1.2; margin: 4px 0; }
    .grid { display: grid; gap: 16px; }
    .panel { padding: 18px; min-width: 0; }
    .station-grid { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 0 16px; }
    .station { display: grid; grid-template-columns: 12px 1fr auto; gap: 10px; align-items: center; padding: 10px 0; border-top: 1px solid var(--border-color-default, #30363d); }
    .station-grid .station { border-top: 0; }
    .dot { width: 9px; height: 9px; border-radius: 50%; }
    .healthy { background: #3fb950; }
    .warning { background: #d29922; }
    .critical { background: #f85149; }
    .station-meta { font-size: 12px; }
    .station-count { text-align: right; font-variant-numeric: tabular-nums; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th { color: var(--text-color-muted, #8b949e); text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
    th, td { padding: 9px 8px; border-bottom: 1px solid var(--border-color-default, #30363d); white-space: nowrap; }
    th:first-child, td:first-child { padding-left: 0; }
    th:last-child, td:last-child { padding-right: 0; }
    tbody tr:last-child td { border-bottom: 0; }
    .pill { display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 12px; font-weight: 600; }
    .yes { background: color-mix(in srgb, #3fb950 18%, transparent); color: #3fb950; }
    .no { background: color-mix(in srgb, #8b949e 18%, transparent); color: var(--text-color-muted, #8b949e); }
    .unknown { background: color-mix(in srgb, #d29922 18%, transparent); color: #d29922; }
    .pack { background: color-mix(in srgb, #58a6ff 18%, transparent); color: #58a6ff; }
    .sleep { background: color-mix(in srgb, #d29922 18%, transparent); color: #d29922; }
    .pill.danger { background: color-mix(in srgb, #f85149 18%, transparent); color: #f85149; }
    .pill.success { background: color-mix(in srgb, #3fb950 18%, transparent); color: #3fb950; }
    .pill.warning { background: color-mix(in srgb, #d29922 18%, transparent); color: #d29922; }
    .pill.neutral { background: color-mix(in srgb, #8b949e 18%, transparent); color: var(--text-color-muted, #8b949e); }
    .error { color: #f85149; padding: 20px; border: 1px solid #f85149; border-radius: 8px; }
    @media (max-width: 800px) {
      main { padding: 16px; }
      header { display: grid; }
      .controls { justify-content: space-between; }
      .metrics { grid-template-columns: repeat(2, 1fr); }
      .station-grid { grid-template-columns: 1fr; }
      .station-grid .station { border-top: 1px solid var(--border-color-default, #30363d); }
      .station-grid .station:first-child { border-top: 0; }
    }
  </style>
</head>
<body>
<main>
  <header>
    <div>
      <div class="eyebrow muted">Evidence accrual, not a go/no-go product</div>
      <h1>Katabatic Research Dashboard</h1>
      <div id="updated" class="muted">Loading Neon archive…</div>
    </div>
    <div class="controls">
      <div class="control">
        <label for="threshold">Wind threshold</label>
        <div class="threshold-wrap">
          <input id="threshold" type="range" min="5" max="30" step="1" value="15">
          <output id="threshold-value" for="threshold">15 mph</output>
        </div>
      </div>
      <button id="refresh" type="button">Refresh</button>
    </div>
  </header>
  <div id="content"></div>
</main>
<script>
  const instanceId = ${JSON.stringify(instanceId)};
  const content = document.getElementById("content");
  const updated = document.getElementById("updated");
  const refresh = document.getElementById("refresh");
  const threshold = document.getElementById("threshold");
  const thresholdValue = document.getElementById("threshold-value");
  const fmt = new Intl.NumberFormat();
  const esc = (text) => String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
  const value = (v, suffix = "") => v === null || v === undefined ? "—" : v + suffix;
  const call = (v) => v === "PACK"
    ? '<span class="pill pack">PACK</span>'
    : v === "SLEEP IN"
      ? '<span class="pill sleep">SLEEP IN</span>'
      : v === "MAYBE"
        ? '<span class="pill unknown">MAYBE</span>'
        : '<span class="pill neutral">No call</span>';
  const phase = (v, predictionMode) => v === "held-out"
    ? '<span class="pill yes">Held-out</span>' +
        (predictionMode
          ? '<div class="muted">' +
              (predictionMode === "forward" ? "issued live" : "probability backfilled") +
            '</div>'
          : "")
    : v === "backfill"
      ? '<span class="pill neutral">Backfill</span>' +
          (predictionMode ? '<div class="muted">probability ' + esc(predictionMode) + '</div>' : "")
      : "—";
  const chance = (percent, raw) => percent === null || percent === undefined
    ? "—"
    : '<strong title="Unrounded exploratory estimate: ' + (raw * 100).toFixed(1) + '%">' +
        esc(percent) + '%</strong>';

  function render(data) {
    updated.textContent = "Generated " + new Date(data.generatedAt).toLocaleString();
    threshold.value = data.parameters.thresholdMph;
    thresholdValue.value = data.parameters.thresholdMph + " mph";
    const s = data.summary;
    const stations = data.stationHealth.map((station) => \`
      <div class="station">
        <span class="dot \${station.health}" title="\${station.health}"></span>
        <div>
          <strong>\${esc(station.name)}</strong>
          <div class="station-meta muted">\${esc(station.source)} · latest \${esc(station.latestDate ?? "none")} · \${value(station.lagDays, "d lag")}</div>
        </div>
        <div class="station-count">
          <strong>\${fmt.format(station.archivedDays)}</strong>
          <div class="station-meta muted">\${fmt.format(station.observations)} points</div>
        </div>
      </div>\`).join("");
    const rows = data.recent.map((day) => \`
      <tr>
        <td><strong>\${day.date}</strong><div class="muted">\${day.cycleType ?? day.status}</div></td>
        <td>\${phase(day.forecastPhase, day.predictionMode)}</td>
        <td title="\${esc(day.forecastCallReason ?? "No complete forecast")}">\${call(day.forecastCall)}</td>
        <td>\${chance(day.successChancePercent, day.successChanceRaw)}</td>
        <td>\${esc(day.sessionOutcome ?? "—")}</td>
        <td title="\${esc(day.flowReasons?.join("; ") ?? "")}">\${esc(day.flowClass ?? "—")}</td>
        <td>\${value(day.sustainedMinutes, " min")}</td>
        <td>\${value(day.canoeSustainedMinutes, " min")}</td>
        <td>\${day.canoeSustainedMinutes < 30 ||
          day.canoeMeanGustMph === null || day.canoeMeanGustMph === undefined
          ? "—"
          : value(day.canoeMeanGustMph, " mph avg") + " / " +
            value(day.canoePeakGustMph, " mph peak") + " / " +
            value(day.canoePctGustAtLeast18, "% ≥18")}</td>
        <td>\${value(day.avgForecastWindMph, " mph")}</td>
        <td>\${value(day.avgLidM, " m")}</td>
      </tr>\`).join("");

    content.innerHTML = \`
      <section class="notice">
        <strong>Research display only — not a go/no-go recommendation.</strong>
        GitHub Actions captures raw HRRR inputs around 7:30 p.m. and Soda observations the next
        afternoon. It does not run <code>/dp-katabatic-check</code> at 5:00/5:30 a.m. and does not
        send an alarm. The call shown below is recomputed from the frozen rule that failed its
        historical safety test. Calls and chances are read from immutable, versioned prediction
        rows in Neon—not calculated by this canvas. The chance model was trained on
        \${fmt.format(data.research.probabilityModel?.trainingPairs ?? 0)} backfill mornings and
        rounds to the nearest 5%.
      </section>
      <section class="metrics">
        <div class="card"><div class="eyebrow muted">Held-out pairs</div><div class="metric">\${fmt.format(s.heldOutPairs)}</div><div class="muted">new since \${data.research.forwardHoldoutStart}</div></div>
        <div class="card"><div class="eyebrow muted">Historical backfill</div><div class="metric">\${fmt.format(s.historicalBackfillPairs)}</div><div class="muted">already used to develop/test the rule</div></div>
        <div class="card"><div class="eyebrow muted">Held-out missed sessions</div><div class="metric">\${fmt.format(s.heldOutMisses)} / \${fmt.format(s.heldOutRideable)}</div><div class="muted">SLEEP IN on a rideable morning</div></div>
        <div class="card"><div class="eyebrow muted">Usable mornings</div><div class="metric">\${fmt.format(s.usableMornings)}</div><div class="muted">\${fmt.format(s.rideableMornings)} sustained · \${fmt.format(s.gustDrivenMornings)} gust-driven/canoe</div></div>
        <div class="card"><div class="eyebrow muted">Latest Soda day</div><div class="metric">\${s.latestSodaDate ?? "—"}</div><div class="muted">\${fmt.format(s.forecastDays)} archived forecast days</div></div>
      </section>
      <div class="grid">
        <section class="panel">
          <h2>Archive health</h2>
          <div class="station-grid">\${stations}</div>
          <div class="muted" style="margin-top:12px">Critical means &gt;2 days stale for Ecowitt or &gt;5 days for Holfuy. Coarse and absent days remain excluded from the outcome label.</div>
        </section>
        <section class="panel">
          <h2>Recent Soda mornings</h2>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Date</th><th>Sample</th><th>Experimental call</th><th>Chance</th><th>Session outcome</th><th>Flow mechanism</th><th>Minutes ≥\${esc(data.parameters.thresholdMph)}</th><th>Minutes ≥12</th><th>Gust support</th><th>Avg HRRR wind</th><th>Avg lid</th></tr></thead>
              <tbody>\${rows || '<tr><td colspan="11">No archived mornings.</td></tr>'}</tbody>
            </table>
          </div>
          <div class="muted" style="margin-top:12px">
            Rule inputs are the 05:00–08:00 average HRRR wind and average boundary-layer lid from
            the exact 00Z run available the evening before. “Chance” means
            \${esc(data.research.probabilityModel?.target ?? "the current rideable outcome")};
            it is not yet a calibrated product probability.
            Session outcome and both minutes columns are gate-conditioned through sunrise +3 hours.
            “Sustained” retains the strict selected-threshold target; “gust-driven/canoe” is the
            additive 12 mph tier. Flow mechanism is a separate exploratory full-morning outcome.
            Data gaps break a run. An em dash means unavailable or too coarse, not calm.
            \${fmt.format(s.storedPredictionDays)} forecast days have stored predictions;
            \${fmt.format(s.forecastsWithoutPrediction)} do not. \${fmt.format(s.matchedPairs)}
            total matched pairs; \${fmt.format(s.outcomesWithoutForecast)} usable outcomes lack
            forecasts; \${fmt.format(s.forecastsWithoutOutcome)} forecasts do not yet have
            labelable outcomes.
          </div>
        </section>
      </div>\`;
  }

  async function load() {
    const response = await fetch("/api/data", { cache: "no-store" });
    if (!response.ok) throw new Error("Dashboard request failed (" + response.status + ")");
    render(await response.json());
  }

  refresh.addEventListener("click", async () => {
    refresh.disabled = true;
    refresh.textContent = "Refreshing…";
    try {
      const response = await fetch("/api/refresh", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Refresh failed");
      render(data);
    } catch (error) {
      content.innerHTML = '<div class="error">' + esc(error.message) + '</div>';
    } finally {
      refresh.disabled = false;
      refresh.textContent = "Refresh";
    }
  });

  let thresholdTimer;
  threshold.addEventListener("input", () => {
    thresholdValue.value = threshold.value + " mph";
    clearTimeout(thresholdTimer);
    thresholdTimer = setTimeout(async () => {
      threshold.disabled = true;
      try {
        const response = await fetch("/api/threshold", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ thresholdMph: Number(threshold.value) }),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Threshold update failed");
        render(data);
      } catch (error) {
        content.innerHTML = '<div class="error">' + esc(error.message) + '</div>';
      } finally {
        threshold.disabled = false;
      }
    }, 180);
  });

  load().catch((error) => {
    content.innerHTML = '<div class="error">' + esc(error.message) + '</div>';
  });
  const events = new EventSource("/events");
  events.onmessage = (event) => render(JSON.parse(event.data));
</script>
</body>
</html>`;
}
