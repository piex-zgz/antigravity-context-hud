import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildHandoffMarkdown,
  exportHandoffToScratch,
  inspectConversationHud,
  inspectTranscriptIncremental,
  redactSecrets,
  resolveAppDataDir,
  scanTraceMri,
} from '../sidecars/context_hud/scanner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_MJS = join(__dirname, '..', 'sidecars', 'context_hud', 'main.mjs');

test('resolveAppDataDir walks up from Antigravity sidecar_data directory', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ctx-hud-appdata-'));
  const prev = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  try {
    mkdirSync(join(tmp, 'brain'), { recursive: true });
    const sidecarData = join(tmp, 'sidecar_data', 'context-hud', 'context_hud', 'data');
    mkdirSync(sidecarData, { recursive: true });
    process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = sidecarData;
    assert.equal(resolveAppDataDir(), tmp);
  } finally {
    if (prev === undefined) delete process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
    else process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR = prev;
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('incremental scan matches full scan, resets on CHECKPOINT, and ignores exit-0 quoted errors', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ctx-hud-unit-'));
  try {
    const p = join(tmp, 'transcript.jsonl');
    const lines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nHelp me debug this parser\n</USER_REQUEST>', created_at: '2026-11-24T01:00:00Z' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', model: 'gemini-4', input_tokens: 10000, cache_read_tokens: 190000, tool_calls: [{ name: 'edit_file', args: { Path: '"/repo/src/parser.py"' } }] }),
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', content: 'Created At: 2026-11-24\nCompleted At: 2026-11-24\nCommand exited with code 1.\nSyntaxError' }),
      JSON.stringify({ step_index: 3, source: 'MODEL', type: 'GENERIC', content: 'Created At: 2026-11-24\nCompleted At: 2026-11-24\nCommand exited with code 0.\nCommand output:\nCommand exited with code 1\n' }),
      JSON.stringify({ step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'Task id "abc/task-9" finished with result:\nCommand exited with code 2\nFailed' }),
    ];
    writeFileSync(p, lines.slice(0, 2).join('\n') + '\n');
    const cache = new Map();
    const r1 = inspectTranscriptIncremental(p, { cache }).report;
    assert.equal(r1.is_main, true);
    assert.equal(r1.latest_effective_tokens, 200000);
    assert.equal(r1.total_cmd_failures, 0);
    assert.equal(r1.hot_files[0].name, 'parser.py');

    appendFileSync(p, lines.slice(2).join('\n') + '\n{"step_index":5,"partial":true');
    const r2 = inspectTranscriptIncremental(p, { cache }).report;
    assert.equal(r2.total_cmd_failures, 2);
    assert.equal(r2.recent_cmd_failures, 2);

    const cpLine = JSON.stringify({ step_index: 5, source: 'SYSTEM', type: 'CHECKPOINT', content: 'compact' });
    writeFileSync(p, [...lines, cpLine].join('\n') + '\n');
    const r3 = inspectTranscriptIncremental(p, { cache: new Map() }).report;
    assert.equal(r3.compaction_generation, 1);
    assert.equal(r3.latest_effective_tokens, 0);
    assert.equal(r3.recent_cmd_failures, 0);
    assert.equal(r3.total_cmd_failures, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('redactSecrets scrubs query tokens, JWTs, Bearer headers, and inline credentials', () => {
  const sample = 'api_key=my_secret_99 https://docs.example.org/page?token=leak&x=1 Bearer sk-1234567890abcdef12345 eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdef1234';
  const out = redactSecrets(sample);
  assert.ok(!out.includes('my_secret_99'));
  assert.ok(!out.includes('token=leak'));
  assert.ok(!out.includes('sk-1234567890abcdef12345'));
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(out.includes('https://docs.example.org/page'));
});

test('pure-JS handoff exporter prefers transcript_full, redacts secrets, deduplicates, and builds checkpoint index', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ctx-hud-handoff-'));
  try {
    const convId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const logsDir = join(tmp, 'brain', convId, '.system_generated', 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, 'transcript.jsonl'), JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\ntruncated\n</USER_REQUEST>' }) + '\n');
    const fullLines = [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nCheck https://github.com/org/repo?token=secret123 and token=live_val\n</USER_REQUEST>', created_at: '2026-11-24T01:00:00Z' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 4000, cache_read_tokens: 96000, tool_calls: [{ name: 'edit_file', args: { Path: '"/workspace/app/index.ts"' } }, { name: 'invoke_subagent', args: {} }] }),
      JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'CHECKPOINT', created_at: '2026-11-24T02:00:00Z' }),
      JSON.stringify({ step_index: 3, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nKeep it simple, no over-engineering\n</USER_REQUEST>', created_at: '2026-11-24T02:05:00Z' }),
    ];
    writeFileSync(join(logsDir, 'transcript_full.jsonl'), fullLines.join('\n') + '\n');

    const md = buildHandoffMarkdown(join(logsDir, 'transcript.jsonl'));
    assert.ok(md.includes('transcript_full.jsonl'));
    assert.ok(!md.includes('secret123'));
    assert.ok(!md.includes('live_val'));
    assert.ok(md.includes('https://github.com/org/repo'));
    assert.ok(md.includes('CHECKPOINT'));
    assert.ok(md.includes('/workspace/app/index.ts'));
    assert.ok(md.includes('Subagents Invoked'));

    const res = exportHandoffToScratch(tmp, convId);
    assert.equal(res.ok, true);
    assert.ok(existsSync(res.path));
    assert.ok(res.bytes > 100);
    assert.ok(readFileSync(res.path, 'utf-8').includes('Keep it simple'));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('scanTraceMri filters out subagents, detects CN/EN frictions, and aggregates churn hotspots', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'ctx-hud-mri-'));
  try {
    const mainConv = '11111111-1111-1111-1111-111111111111';
    const subConv = '22222222-2222-2222-2222-222222222222';
    const mainLogs = join(tmp, 'brain', mainConv, '.system_generated', 'logs');
    const subLogs = join(tmp, 'brain', subConv, '.system_generated', 'logs');
    mkdirSync(mainLogs, { recursive: true });
    mkdirSync(subLogs, { recursive: true });

    writeFileSync(
      join(mainLogs, 'transcript_full.jsonl'),
      [
        JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\n这个方案太复杂没必要\n</USER_REQUEST>', created_at: '2026-11-24T03:00:00Z' }),
        JSON.stringify({ step_index: 1, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nThis output is too confusing and full of jargon\n</USER_REQUEST>', created_at: '2026-11-24T03:05:00Z' }),
        JSON.stringify({ step_index: 2, source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 10000, cache_read_tokens: 400000, tool_calls: [
          { name: 'edit_file', args: { Path: '"/repo/hot.py"' } },
          { name: 'edit_file', args: { Path: '"/repo/hot.py"' } },
          { name: 'edit_file', args: { Path: '"/repo/hot.py"' } },
        ] }),
      ].join('\n') + '\n',
    );
    // Subagent transcript has NO USER_INPUT / USER_EXPLICIT and must be skipped.
    writeFileSync(
      join(subLogs, 'transcript.jsonl'),
      JSON.stringify({ step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: 'Subagent task prompt' }) + '\n',
    );

    const mri = scanTraceMri(tmp, { days: 30, forceRefresh: true });
    assert.equal(mri.totals.sessions, 1);
    assert.equal(mri.totals.yellow, 1);
    assert.equal(mri.totals.frictions, 2);
    assert.equal(mri.churnHotspots.length, 1);
    assert.equal(mri.churnHotspots[0].name, 'hot.py');
    assert.equal(mri.churnHotspots[0].totalEdits, 3);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('live standalone HTTP server serves UI, /api/hud, /api/mri, and pure-JS /api/handoff', async () => {
  const tmpApp = mkdtempSync(join(tmpdir(), 'ctx-hud-http-'));
  const fakeConv = '33333333-4444-5555-6666-777777777777';
  const logsDir = join(tmpApp, 'brain', fakeConv, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(
    join(logsDir, 'transcript.jsonl'),
    [
      JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<USER_REQUEST>\nStop adding bloat here\n</USER_REQUEST>', created_at: '2026-11-24T05:00:00Z' }),
      JSON.stringify({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', model: 'gemini-4', input_tokens: 5000, cache_read_tokens: 120000, tool_calls: [] }),
    ].join('\n') + '\n',
  );

  const proc = spawn('node', [MAIN_MJS, '--standalone', '--port', '0'], {
    env: { ...process.env, ANTIGRAVITY_EXECUTABLE_DATA_DIR: tmpApp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server start timeout')), 5000);
      proc.stdout.on('data', (d) => {
        const m = String(d).match(/127\.0\.0\.1:(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited prematurely: ${code}`));
      });
    });

    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/styles.css`)).status, 200);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/preload.js`)).status, 200);

    const hud = await (await fetch(`${base}/api/hud?conversationId=${fakeConv}`)).json();
    assert.equal(hud.exists, true);
    assert.equal(hud.report.latest_effective_tokens, 125000);
    assert.equal(hud.handoffSupported, true);

    const mri = await (await fetch(`${base}/api/mri?days=7`)).json();
    assert.equal(mri.totals.sessions, 1);
    assert.equal(mri.totals.frictions, 1);

    const ho = await (
      await fetch(`${base}/api/handoff`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: fakeConv }),
      })
    ).json();
    assert.equal(ho.ok, true);
    assert.ok(existsSync(ho.path));
    assert.ok(readFileSync(ho.path, 'utf-8').includes('Stop adding bloat here'));
  } finally {
    proc.kill('SIGTERM');
    rmSync(tmpApp, { recursive: true, force: true });
  }
});
