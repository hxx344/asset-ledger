import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { variationalRequestHeaders } from './variational.ts';
import type { VariationalCredential } from './variational.ts';
import type { VariationalDiagnosticOutcome, VariationalDiagnosticReport, VariationalDiagnosticResult } from './variational-diagnostic-types.ts';

const MAX_OUTPUT_BYTES = 8192;
const DEADLINE_MS = 23_000;
const resultSchema = z.object({
  endpoint: z.literal('session'), path: z.literal('/api/me'),
  status: z.number().int().min(100).max(599).nullable(),
  contentType: z.enum(['json', 'html', 'other', 'missing']).nullable(),
  challenge: z.boolean(), elapsedMs: z.number().int().min(0).max(DEADLINE_MS + 1000),
  structureOk: z.boolean().nullable(),
  outcome: z.enum(['ok', 'challenge', 'unauthorized', 'forbidden', 'rate_limited', 'redirect', 'html', 'invalid_data', 'timeout', 'network_error', 'cancelled']),
}).strict();

export async function diagnoseVariationalPython(c: VariationalCredential, signal?: AbortSignal, launch: typeof spawn = spawn): Promise<VariationalDiagnosticReport> {
  variationalRequestHeaders(c);
  const checkedAt = new Date().toISOString();
  const started = performance.now();
  const fallback = (outcome: VariationalDiagnosticOutcome): VariationalDiagnosticResult => ({
    endpoint: 'session', path: '/api/me', status: null, contentType: null, challenge: false,
    elapsedMs: Math.max(0, Math.round(performance.now() - started)), structureOk: null, outcome,
  });
  const result = await new Promise<VariationalDiagnosticResult>(done => {
    if (signal?.aborted) { done(fallback('cancelled')); return; }
    // Avoid passing application secrets, proxy credentials or Python startup hooks.
    const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? 'production' };
    for (const key of ['PATH', 'SystemRoot', 'WINDIR']) if (process.env[key]) env[key] = process.env[key];
    let child: ReturnType<typeof spawn>;
    try {
      child = launch(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', resolve('scripts/variational-diagnostic.py')], {
        shell: false, windowsHide: true, env, stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch (error) {
      done(fallback(error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'client_unavailable' : 'client_error'));
      return;
    }
    let failure: VariationalDiagnosticOutcome | undefined;
    let bytes = 0;
    const chunks: Buffer[] = [];
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const stop = (outcome: VariationalDiagnosticOutcome) => {
      if (failure || closed) return;
      failure = outcome;
      child.stdin?.destroy();
      hardKill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 250);
      child.kill('SIGTERM');
    };
    const cancel = () => stop('cancelled');
    const deadline = setTimeout(() => stop('timeout'), DEADLINE_MS);
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', (error: NodeJS.ErrnoException) => {
      failure ??= error.code === 'ENOENT' ? 'client_unavailable' : 'client_error';
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { stop('client_error'); return; }
      chunks.push(chunk);
    });
    child.stdin?.on('error', () => stop('client_error'));
    child.once('close', code => {
      closed = true;
      clearTimeout(deadline); clearTimeout(hardKill);
      signal?.removeEventListener('abort', cancel);
      if (failure || code !== 0) { done(fallback(failure ?? 'client_error')); return; }
      try {
        const data = resultSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        // Build a fresh allowlisted DTO. Never propagate helper stdout or exceptions.
        done({ endpoint: 'session', path: '/api/me', status: data.status, contentType: data.contentType,
          challenge: data.challenge, elapsedMs: data.elapsedMs, structureOk: data.structureOk, outcome: data.outcome });
      } catch { done(fallback('client_error')); }
    });
    if (signal?.aborted) cancel();
    else child.stdin?.end(JSON.stringify({ vrToken: c.vrToken }));
  });
  return { checkedAt, client: 'grid-python', results: [result] };
}
