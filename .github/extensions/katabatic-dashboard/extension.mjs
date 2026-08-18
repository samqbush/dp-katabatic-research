import { createServer } from "node:http";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

import { loadDashboardData } from "../../../scripts/lib/dashboard-data.mjs";
import { renderDashboardHtml } from "./lib/renderer.mjs";

const servers = new Map();

function json(res, status, body) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(body));
}

function broadcast(entry) {
    const payload = `data: ${JSON.stringify(entry.data)}\n\n`;
    for (const client of entry.clients) client.write(payload);
}

async function refreshEntry(entry) {
    entry.data = await loadDashboardData({
        recentDays: entry.recentDays,
        thresholdMph: entry.thresholdMph,
    });
    broadcast(entry);
    return entry.data;
}

async function startServer(instanceId, recentDays) {
    const entry = {
        server: null,
        url: null,
        recentDays,
        thresholdMph: 15,
        data: await loadDashboardData({ recentDays, thresholdMph: 15 }),
        clients: new Set(),
    };

    const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (req.method === "GET" && url.pathname === "/") {
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                "Cache-Control": "no-store",
            });
            res.end(renderDashboardHtml(instanceId));
            return;
        }

        if (req.method === "GET" && url.pathname === "/api/data") {
            json(res, 200, entry.data);
            return;
        }

        if (req.method === "GET" && url.pathname === "/events") {
            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-store",
                Connection: "keep-alive",
            });
            res.write(`data: ${JSON.stringify(entry.data)}\n\n`);
            entry.clients.add(res);
            req.on("close", () => entry.clients.delete(res));
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/refresh") {
            try {
                json(res, 200, await refreshEntry(entry));
            } catch (error) {
                json(res, 500, { error: error.message });
            }
            return;
        }

        if (req.method === "POST" && url.pathname === "/api/threshold") {
            try {
                let body = "";
                for await (const chunk of req) body += chunk;
                const thresholdMph = Number(JSON.parse(body).thresholdMph);
                if (!Number.isFinite(thresholdMph) || thresholdMph < 5 || thresholdMph > 30) {
                    json(res, 400, { error: "Threshold must be between 5 and 30 mph." });
                    return;
                }
                entry.thresholdMph = thresholdMph;
                json(res, 200, await refreshEntry(entry));
            } catch (error) {
                json(res, 400, { error: error.message });
            }
            return;
        }

        json(res, 404, { error: "Not found" });
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    entry.server = server;
    entry.url = `http://127.0.0.1:${port}/`;
    return entry;
}

await joinSession({
    canvases: [
        createCanvas({
            id: "katabatic-dashboard",
            displayName: "Katabatic Research Dashboard",
            description:
                "Shows archive freshness, held-out coverage, and explicitly experimental night-before calls and success chances.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    recentDays: {
                        type: "integer",
                        minimum: 5,
                        maximum: 30,
                        default: 14,
                        description: "Number of recent Soda Lakes mornings to show.",
                    },
                },
            },
            actions: [
                {
                    name: "refresh",
                    description: "Reload the dashboard from the Neon archive.",
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) {
                            throw new CanvasError(
                                "canvas_instance_not_open",
                                `Canvas instance ${ctx.instanceId} is not open.`,
                            );
                        }
                        const data = await refreshEntry(entry);
                        return {
                            generatedAt: data.generatedAt,
                            latestSodaDate: data.summary.latestSodaDate,
                            matchedPairs: data.summary.matchedPairs,
                        };
                    },
                },
                {
                    name: "set_threshold",
                    description:
                        "Recompute rideable outcomes with a sustained-wind threshold from 5 to 30 mph.",
                    inputSchema: {
                        type: "object",
                        additionalProperties: false,
                        required: ["thresholdMph"],
                        properties: {
                            thresholdMph: { type: "number", minimum: 5, maximum: 30 },
                        },
                    },
                    handler: async (ctx) => {
                        const entry = servers.get(ctx.instanceId);
                        if (!entry) {
                            throw new CanvasError(
                                "canvas_instance_not_open",
                                `Canvas instance ${ctx.instanceId} is not open.`,
                            );
                        }
                        entry.thresholdMph = ctx.input.thresholdMph;
                        const data = await refreshEntry(entry);
                        return {
                            thresholdMph: data.parameters.thresholdMph,
                            rideableMornings: data.summary.rideableMornings,
                            rideableRate: data.summary.rideableRate,
                        };
                    },
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    const recentDays = ctx.input?.recentDays ?? 14;
                    entry = await startServer(ctx.instanceId, recentDays);
                    servers.set(ctx.instanceId, entry);
                }
                return {
                    title: "Katabatic Research Dashboard",
                    status: `Data through ${entry.data.summary.latestSodaDate ?? "no Soda archive"}`,
                    url: entry.url,
                };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (!entry) return;
                servers.delete(ctx.instanceId);
                for (const client of entry.clients) client.end();
                await new Promise((resolve) => entry.server.close(resolve));
            },
        }),
    ],
});
