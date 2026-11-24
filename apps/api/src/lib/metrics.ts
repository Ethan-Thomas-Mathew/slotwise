import { createServer, type Server } from 'node:http';
import client from 'prom-client';

/**
 * Prometheus metrics: numbers about the running app that a monitoring system
 * scrapes every few seconds (request rates, errors, latency, bookings, jobs).
 *
 * Safety: metrics are served on their OWN port (METRICS_PORT), never on the
 * public API port and never through the web proxy. In Docker only Prometheus,
 * inside the private Docker network, can reach it.
 */
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry }); // CPU, memory, event-loop lag…

export const httpDuration = new client.Histogram({
  name: 'slotwise_http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by route template (not raw URL, to keep label count small)',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const bookingsHeld = new client.Counter({
  name: 'slotwise_bookings_held_total',
  help: 'Slots successfully held',
  registers: [registry],
});

export const appErrors = new client.Counter({
  name: 'slotwise_app_errors_total',
  help: 'Expected errors returned to clients, by error code (SLOT_TAKEN, BAD_SIGNATURE, RATE_LIMITED…)',
  labelNames: ['code'] as const,
  registers: [registry],
});

export const webhooks = new client.Counter({
  name: 'slotwise_payment_webhooks_total',
  help: 'Payment webhooks received, by outcome',
  labelNames: ['outcome'] as const, // processed | duplicate | ignored | bad_signature
  registers: [registry],
});

export const refunds = new client.Counter({
  name: 'slotwise_refunds_total',
  help: 'Refunds completed with the payment provider',
  registers: [registry],
});

export const jobs = new client.Counter({
  name: 'slotwise_jobs_total',
  help: 'Background jobs finished, by queue and result',
  labelNames: ['queue', 'result'] as const, // completed | failed
  registers: [registry],
});

interface CountableQueue {
  name: string;
  getJobCounts(...states: string[]): Promise<Record<string, number>>;
}

/**
 * Queue depth, read from Redis each time Prometheus scrapes. Call once per process
 * (the worker). A growing "waiting" count means jobs arrive faster than they finish.
 */
export function trackQueueDepth(queues: CountableQueue[]) {
  if (registry.getSingleMetric('slotwise_queue_jobs')) return;
  new client.Gauge({
    name: 'slotwise_queue_jobs',
    help: 'Jobs currently in each queue, by state',
    labelNames: ['queue', 'state'] as const,
    registers: [registry],
    async collect() {
      for (const q of queues) {
        const counts = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const [state, n] of Object.entries(counts)) this.set({ queue: q.name, state }, n);
      }
    },
  });
}

/** A tiny HTTP server that answers GET /metrics and nothing else. */
export function startMetricsServer(port: number, host: string): Promise<Server> {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .metrics()
      .then((body) => res.writeHead(200, { 'content-type': registry.contentType }).end(body))
      .catch(() => res.writeHead(500).end());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject); // e.g. the port is already in use
    server.listen(port, host, () => resolve(server));
  });
}
