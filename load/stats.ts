import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export type TimedSample = { tool: string; ms: number; ok: boolean; code: string | null; at: number };

export type ToolStats = {
  count: number;
  errors: Record<string, number>;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
};

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function summarize(samples: TimedSample[]): ToolStats {
  const latencies = samples.map((sample) => sample.ms).sort((a, b) => a - b);
  const errors: Record<string, number> = {};
  for (const sample of samples) {
    if (sample.ok || !sample.code) continue;
    errors[sample.code] = (errors[sample.code] ?? 0) + 1;
  }
  return {
    count: samples.length,
    errors,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.at(-1) ?? null,
  };
}

export function perDay(before: number, after: number, durationSec: number): number {
  if (durationSec <= 0) return 0;
  return ((after - before) * 86_400) / durationSec;
}

type ServerTool = { kind: 'tool'; tool: string; ms: number; outcome: string; at: number };
type ServerHttp = { kind: 'http'; route: string; status: number; ms: number; at: number };

export function parseServerLine(line: string): ServerTool | ServerHttp | null {
  if (!line.startsWith('{')) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const at = typeof record.time === 'string' ? Date.parse(record.time) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  if (typeof record.latencyMs === 'number' && typeof record.tool === 'string' && typeof record.outcome === 'string') {
    return { kind: 'tool', tool: record.tool, ms: record.latencyMs, outcome: record.outcome, at };
  }
  if (typeof record.latency_ms === 'number' && typeof record.status === 'number' && typeof record.route === 'string') {
    return { kind: 'http', route: record.route, status: record.status, ms: record.latency_ms, at };
  }
  return null;
}

export async function readJsonLines(path: string): Promise<string[]> {
  const lines: string[] = [];
  const stream = createReadStream(path, 'utf8');
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of reader) lines.push(line);
  return lines;
}

export async function loadSamples(paths: string[]): Promise<TimedSample[]> {
  const samples: TimedSample[] = [];
  for (const path of paths) {
    for (const line of await readJsonLines(path)) {
      if (!line.startsWith('{')) continue;
      try {
        const value = JSON.parse(line) as Partial<TimedSample>;
        if (typeof value.tool === 'string' && typeof value.ms === 'number' && typeof value.ok === 'boolean' && typeof value.at === 'number') {
          samples.push({ tool: value.tool, ms: value.ms, ok: value.ok, code: value.code ?? null, at: value.at });
        }
      } catch { /* skip a torn final line */ }
    }
  }
  return samples;
}
