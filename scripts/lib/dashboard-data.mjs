import { query } from "./db.mjs";
import { readDays, isoDay } from "./archive-store.mjs";
import { labelDay, parseArchiveDate, summarizeMorningWind } from "./label.mjs";
import {
    experimentalCallResult,
    FORWARD_HOLDOUT_START,
} from "./night-before-call.mjs";
import { zonedTimeFrom } from "./zone.mjs";

const SODA = "dp-soda-lakes";

function round(value, digits = 1) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
    return Number(Number(value).toFixed(digits));
}

function maxOf(points, field) {
    const values = points
        .map((point) => point[field])
        .filter((value) => value !== null && value !== undefined && value !== "")
        .map(Number)
        .filter(Number.isFinite);
    return values.length ? Math.max(...values) : null;
}

function healthFor(station) {
    const limit = station.source === "holfuy" ? 5 : 2;
    if (station.latestDate === null) return "critical";
    if (station.lagDays > limit) return "critical";
    if (station.lagDays > 1) return "warning";
    return "healthy";
}

async function loadStationHealth() {
    const { rows } = await query(`
        SELECT
            s.slug,
            s.name,
            s.source,
            max(sd.local_date) AS latest_date,
            max(sd.fetched_at) AS latest_fetched_at,
            ((CURRENT_TIMESTAMP AT TIME ZONE 'America/Denver')::date - max(sd.local_date))::int AS lag_days,
            count(sd.local_date)::int AS archived_days,
            count(*) FILTER (WHERE sd.status = 'ok')::int AS ok_days,
            count(*) FILTER (WHERE sd.status <> 'ok')::int AS absent_days,
            count(*) FILTER (
                WHERE CASE
                    WHEN sd.cycle_type ~ '^[0-9]+min$'
                    THEN regexp_replace(sd.cycle_type, '[^0-9]', '', 'g')::int > 30
                    ELSE false
                END
            )::int AS coarse_days,
            coalesce(sum(sd.point_count), 0)::int AS observations
        FROM stations s
        LEFT JOIN station_days sd ON sd.station_slug = s.slug
        GROUP BY s.slug, s.name, s.source
        ORDER BY CASE WHEN s.slug = 'dp-soda-lakes' THEN 0 ELSE 1 END, s.name
    `);

    return rows.map((row) => {
        const station = {
            slug: row.slug,
            name: row.name,
            source: row.source,
            latestDate: row.latest_date ? isoDay(row.latest_date) : null,
            latestFetchedAt: row.latest_fetched_at
                ? new Date(row.latest_fetched_at).toISOString()
                : null,
            lagDays: row.lag_days,
            archivedDays: row.archived_days,
            okDays: row.ok_days,
            absentDays: row.absent_days,
            coarseDays: row.coarse_days,
            observations: row.observations,
        };
        return { ...station, health: healthFor(station) };
    });
}

async function loadPredictionModel() {
    const { rows } = await query(`
        SELECT
            model_version,
            created_at,
            trained_through,
            training_size,
            training_positives,
            target_threshold_mph,
            target_sustained_minutes,
            target_description,
            status
        FROM night_before_models
        ORDER BY created_at DESC, model_version DESC
        LIMIT 1
    `);
    if (!rows.length) return null;
    const row = rows[0];
    return {
        modelVersion: row.model_version,
        createdAt: new Date(row.created_at).toISOString(),
        trainedThrough: isoDay(row.trained_through),
        trainingPairs: row.training_size,
        trainingRideable: row.training_positives,
        targetThresholdMph: Number(row.target_threshold_mph),
        targetSustainedMinutes: row.target_sustained_minutes,
        target: row.target_description,
        status: row.status,
    };
}

async function loadForecasts(modelVersion, { from, to } = {}) {
    const { rows } = await query(`
        WITH latest_runs AS (
            SELECT local_date, max(run_init) AS run_init
            FROM hrrr_forecasts
            WHERE station_slug = $1
              AND ($3::date IS NULL OR local_date >= $3)
              AND ($4::date IS NULL OR local_date <= $4)
            GROUP BY local_date
        ),
        forecast_summary AS (
            SELECT
                h.station_slug,
                h.local_date,
                h.run_init,
                min(h.lid_m) AS min_lid_m,
                avg(h.lid_m) AS avg_lid_m,
                avg(h.wind_mph) AS avg_wind_mph,
                max(h.wind_mph) AS max_wind_mph,
                count(*) FILTER (
                    WHERE h.lid_m IS NOT NULL AND h.wind_mph IS NOT NULL
                )::int AS forecast_hours
            FROM hrrr_forecasts h
            JOIN latest_runs r
              ON r.local_date = h.local_date
             AND r.run_init = h.run_init
            WHERE h.station_slug = $1
            GROUP BY h.station_slug, h.local_date, h.run_init
        )
        SELECT
            f.*,
            p.call,
            p.call_reason,
            p.success_probability,
            p.success_chance_percent,
            p.avg_wind_mph AS prediction_avg_wind_mph,
            p.avg_lid_m AS prediction_avg_lid_m,
            p.generation_mode,
            p.generated_at AS prediction_generated_at,
            p.model_version
        FROM forecast_summary f
        LEFT JOIN night_before_predictions p
          ON p.station_slug = f.station_slug
         AND p.local_date = f.local_date
         AND p.run_init = f.run_init
         AND p.model_version = $2
        ORDER BY f.local_date
    `, [SODA, modelVersion, from ?? null, to ?? null]);

    return rows.map((row) => ({
        date: isoDay(row.local_date),
        runInit: new Date(row.run_init).toISOString(),
        minLidM: round(row.min_lid_m),
        avgLidM: round(row.prediction_avg_lid_m ?? row.avg_lid_m),
        avgWindMph: round(row.prediction_avg_wind_mph ?? row.avg_wind_mph),
        maxWindMph: round(row.max_wind_mph),
        forecastHours: row.forecast_hours,
        call: row.call ?? null,
        reason: row.call_reason ?? null,
        successChance: row.success_probability === null
            ? null
            : {
                probability: Number(row.success_probability),
                roundedPercent: row.success_chance_percent,
            },
        predictionMode: row.generation_mode ?? null,
        predictionGeneratedAt: row.prediction_generated_at
            ? new Date(row.prediction_generated_at).toISOString()
            : null,
        modelVersion: row.model_version ?? null,
    }));
}

function summarizeMorning(record, label, forecast) {
    const date = parseArchiveDate(record.date);
    const start = Math.floor(zonedTimeFrom(date, label.gateOpenHour, 0, 0).getTime() / 1000);
    const end = label.sessionWindowEndTs ?? null;
    const morningPoints =
        start === null || end === null
            ? []
            : record.points.filter((point) => point.ts >= start && point.ts <= end);
    const observedMorning = summarizeMorningWind(record, { threshold: label.threshold });

    return {
        date: record.date,
        status: record.status,
        cycleType: record.cycle_type,
        pointCount: record.point_count,
        label: label.label,
        labelReason: label.reason ?? null,
        sustainedMinutes: label.sustainedMinutes ?? null,
        gateOpenHour: label.gateOpenHour,
        maxSpeedMph: round(maxOf(morningPoints, "speed")),
        maxGustMph: round(maxOf(morningPoints, "gust")),
        observedMorningMaxSpeedMph: round(observedMorning.maxSpeedMph),
        observedMorningMaxGustMph: round(observedMorning.maxGustMph),
        observedMorningSustainedMinutes: observedMorning.sustainedMinutes,
        minLidM: forecast?.minLidM ?? null,
        avgLidM: forecast?.avgLidM ?? null,
        avgForecastWindMph: forecast?.avgWindMph ?? null,
        maxForecastWindMph: forecast?.maxWindMph ?? null,
        forecastCall: forecast?.call ?? null,
        forecastCallReason: forecast?.reason ?? null,
        successChancePercent: forecast?.successChance?.roundedPercent ?? null,
        successChanceRaw: forecast?.successChance?.probability ?? null,
        predictionMode: forecast?.predictionMode ?? null,
        predictionGeneratedAt: forecast?.predictionGeneratedAt ?? null,
        modelVersion: forecast?.modelVersion ?? null,
        forecastResult: experimentalCallResult(forecast?.call, label.label),
        forecastPhase: forecast
            ? record.date >= FORWARD_HOLDOUT_START ? "held-out" : "backfill"
            : null,
        hasForecast: Boolean(forecast),
    };
}

function summarizeForecastOnly(forecast) {
    return {
        date: forecast.date,
        status: "forecast-only",
        cycleType: null,
        pointCount: null,
        label: null,
        labelReason: "awaiting-outcome",
        sustainedMinutes: null,
        gateOpenHour: null,
        maxSpeedMph: null,
        maxGustMph: null,
        observedMorningMaxSpeedMph: null,
        observedMorningMaxGustMph: null,
        observedMorningSustainedMinutes: null,
        minLidM: forecast.minLidM,
        avgLidM: forecast.avgLidM,
        avgForecastWindMph: forecast.avgWindMph,
        maxForecastWindMph: forecast.maxWindMph,
        forecastCall: forecast.call,
        forecastCallReason: forecast.reason,
        successChancePercent: forecast.successChance?.roundedPercent ?? null,
        successChanceRaw: forecast.successChance?.probability ?? null,
        predictionMode: forecast.predictionMode,
        predictionGeneratedAt: forecast.predictionGeneratedAt,
        modelVersion: forecast.modelVersion,
        forecastResult: null,
        forecastPhase: forecast.date >= FORWARD_HOLDOUT_START ? "held-out" : "backfill",
        hasForecast: true,
    };
}

export async function loadDashboardData({
    recentDays = 14,
    thresholdMph = 15,
    archiveFrom,
    archiveTo,
} = {}) {
    const [stationHealth, sodaDays, probabilityModel] = await Promise.all([
        loadStationHealth(),
        readDays(SODA, { from: archiveFrom, to: archiveTo }),
        loadPredictionModel(),
    ]);
    const forecasts = await loadForecasts(
        probabilityModel?.modelVersion ?? null,
        { from: archiveFrom, to: archiveTo },
    );

    const labels = sodaDays.map((record) => ({
        record,
        label: labelDay(record, { threshold: thresholdMph }),
    }));
    const usable = labels.filter(({ label }) => label.label !== null);
    const rideable = usable.filter(({ label }) => label.label).length;
    const forecastByDate = new Map(forecasts.map((forecast) => [forecast.date, forecast]));
    const outcomeDates = new Set(usable.map(({ record }) => record.date));
    const forecastDates = new Set(forecasts.map((forecast) => forecast.date));
    const matchedPairs = [...outcomeDates].filter((date) => forecastDates.has(date)).length;
    const matched = usable
        .map(({ record, label }) => ({
            date: record.date,
            label: label.label,
            forecast: forecastByDate.get(record.date),
        }))
        .filter(({ forecast }) => forecast?.call);
    const heldOut = matched.filter(({ date }) => date >= FORWARD_HOLDOUT_START);
    const heldOutRideable = heldOut.filter(({ label }) => label).length;
    const heldOutMisses = heldOut.filter(
        ({ label, forecast }) => label && forecast.call === "SLEEP IN",
    ).length;
    const labelByDate = new Map(labels.map((entry) => [entry.record.date, entry]));
    const recent = [...new Set([...outcomeDates, ...forecastDates])]
        .sort()
        .slice(-recentDays)
        .reverse()
        .map((date) => {
            const outcome = labelByDate.get(date);
            const forecast = forecastByDate.get(date);
            return outcome
                ? summarizeMorning(outcome.record, outcome.label, forecast)
                : summarizeForecastOnly(forecast);
        });
    const sodaHealth = stationHealth.find((station) => station.slug === SODA);

    return {
        generatedAt: new Date().toISOString(),
        parameters: {
            thresholdMph,
            sustainedMinutes: 30,
        },
        summary: {
            latestSodaDate: sodaHealth?.latestDate ?? null,
            usableMornings: usable.length,
            rideableMornings: rideable,
            rideableRate: usable.length ? round((rideable / usable.length) * 100) : null,
            forecastDays: forecastDates.size,
            matchedPairs,
            historicalBackfillPairs: matched.filter(
                ({ date }) => date < FORWARD_HOLDOUT_START,
            ).length,
            heldOutPairs: heldOut.length,
            heldOutRideable,
            heldOutMisses,
            storedPredictionDays: forecasts.filter((forecast) => forecast.call).length,
            forecastsWithoutPrediction: forecasts.filter((forecast) => !forecast.call).length,
            outcomesWithoutForecast: [...outcomeDates].filter((date) => !forecastDates.has(date)).length,
            forecastsWithoutOutcome: [...forecastDates].filter((date) => !outcomeDates.has(date)).length,
        },
        research: {
            forwardHoldoutStart: FORWARD_HOLDOUT_START,
            experimentalRuleStatus:
                "UNSAFE: historical pilot lost 17.9% of rideable sessions; research display only.",
            probabilityModel,
            morningAutomation:
                "None. No GitHub Action runs /dp-katabatic-check or sends a wake-up alarm.",
        },
        stationHealth,
        recent,
    };
}
