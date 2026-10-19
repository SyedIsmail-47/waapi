import http from "node:http";
import client from "prom-client";
import type { SessionStatus } from "@waapi/shared";
import { SESSION_STATUSES } from "@waapi/shared";

export class SessionMetrics {
  private readonly register = new client.Registry();
  private readonly sessionsGauge: client.Gauge<string>;
  private readonly liveGauge: client.Gauge;
  private readonly memoryGauge: client.Gauge;

  constructor() {
    client.collectDefaultMetrics({ register: this.register });
    this.sessionsGauge = new client.Gauge({
      name: "waapi_sessions_by_status",
      help: "Observed session status transitions",
      labelNames: ["status"],
      registers: [this.register],
    });
    for (const s of SESSION_STATUSES) {
      this.sessionsGauge.set({ status: s }, 0);
    }
    this.liveGauge = new client.Gauge({
      name: "waapi_live_sessions",
      help: "Open WA sockets on this node",
      registers: [this.register],
    });
    this.memoryGauge = new client.Gauge({
      name: "waapi_estimated_rss_bytes_per_session",
      help: "process RSS / live session count heuristic",
      registers: [this.register],
    });
  }

  observeStatus(status: SessionStatus): void {
    this.sessionsGauge.inc({ status });
  }

  setLiveSessions(n: number): void {
    this.liveGauge.set(n);
    const rss = process.memoryUsage().rss;
    this.memoryGauge.set(n > 0 ? rss / n : 0);
  }

  async metricsText(): Promise<string> {
    return this.register.metrics();
  }

  startServer(port: number): http.Server {
    const server = http.createServer(async (req, res) => {
      if (req.url === "/metrics") {
        const body = await this.metricsText();
        res.writeHead(200, { "Content-Type": this.register.contentType });
        res.end(body);
        return;
      }
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(port);
    return server;
  }
}
