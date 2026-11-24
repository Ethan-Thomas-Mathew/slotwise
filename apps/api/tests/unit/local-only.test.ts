import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guard rails for the "local only" promise. If someone later edits
 * docker-compose.yml and accidentally exposes a service to the network,
 * this test fails in CI before the change can be merged.
 */
const compose = readFileSync(resolve(__dirname, '../../../../docker-compose.yml'), 'utf8');

function publishedPorts(yaml: string): string[] {
  const ports: string[] = [];
  const lines = yaml.split('\n');
  lines.forEach((line, i) => {
    if (line.trim() !== 'ports:') return;
    for (let j = i + 1; j < lines.length && lines[j]!.trim().startsWith('- '); j++) {
      ports.push(lines[j]!.trim().slice(2).split('#')[0]!.trim().replace(/['"]/g, ''));
    }
  });
  return ports;
}

describe('docker-compose.yml stays local-only', () => {
  const ports = publishedPorts(compose);

  it('publishes some ports (sanity check of the parser)', () => {
    expect(ports.length).toBeGreaterThanOrEqual(7);
  });

  it('binds every published port to 127.0.0.1', () => {
    for (const p of ports) expect(p, p).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
  });

  it('never publishes the internal metrics ports', () => {
    for (const p of ports) expect(p).not.toMatch(/:946[45]$/);
  });

  it('has no fixed Grafana admin password', () => {
    expect(compose).not.toMatch(/GF_SECURITY_ADMIN_PASSWORD:/);
    expect(compose).toContain('GF_AUTH_DISABLE_LOGIN_FORM');
  });
});
