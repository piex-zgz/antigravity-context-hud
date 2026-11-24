/**
 * Context HUD & Trace MRI — Antigravity Sidecar Backend.
 *
 * Strictly read-only on conversation logs (only writes handoff markdown into
 * `<appData>/brain/<convId>/scratch/` when the user explicitly clicks Export).
 * Zero third-party dependencies, zero Python dependency, zero model tokens.
 */

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ID_RE,
  exportHandoffToScratch,
  formatMriMarkdown,
  inspectConversationHud,
  resolveAppDataDir,
  scanTraceMri,
} from './scanner.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DATA = resolveAppDataDir();

const STATIC = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

const titleCache = new Map();
const titlePending = new Set();
const TITLE_TTL_MS = 5 * 60 * 1000;

function extractTitleFromMetadata(raw) {
  const md =
    raw?.response?.conversationMetadata?.metadata ||
    raw?.response?.conversation_metadata?.metadata ||
    raw?.conversationMetadata?.metadata ||
    raw?.metadata ||
    raw;
  return String(md?.title || md?.summary || md?.name || md?.conversation?.title || '').trim();
}

function warmTitle(convId) {
  if (!convId || !ID_RE.test(convId) || titlePending.has(convId)) return;
  const cached = titleCache.get(convId);
  if (cached && Date.now() - cached.at < TITLE_TTL_MS) return;
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  if (!exe && !process.env.ANTIGRAVITY_LS_ADDRESS) return;
  titlePending.add(convId);
  const file = exe || 'agentapi';
  const args = exe ? ['agentapi', 'get-conversation-metadata', convId] : ['get-conversation-metadata', convId];
  execFile(file, args, { encoding: 'utf-8', timeout: 1500 }, (err, stdout) => {
    titlePending.delete(convId);
    if (err || !stdout) {
      titleCache.set(convId, { title: '', at: Date.now() });
      return;
    }
    try {
      const title = extractTitleFromMetadata(JSON.parse(stdout));
      titleCache.set(convId, { title, at: Date.now() });
    } catch {
      titleCache.set(convId, { title: '', at: Date.now() });
    }
  });
}

function getCachedTitles() {
  const out = {};
  for (const [k, v] of titleCache.entries()) {
    if (v.title) out[k] = v.title;
  }
  return out;
}

function handleHud(data, defaultConvId = '') {
  const convId = String(data.conversationId || defaultConvId || '').trim();
  if (!convId || !ID_RE.test(convId)) {
    return { conversationId: null, exists: false, title: '', report: null, handoffSupported: true };
  }
  warmTitle(convId);
  const res = inspectConversationHud(APP_DATA, convId);
  const title = titleCache.get(convId)?.title || res.report?.first_user_prompt || convId.slice(0, 8);
  return {
    conversationId: convId,
    exists: res.exists,
    title,
    report: res.report,
    handoffSupported: true,
  };
}

function handleMri(data) {
  const rawDays = Number.parseInt(String(data.days ?? '7'), 10);
  const days = Number.isFinite(rawDays) && rawDays >= 0 ? rawDays : 7;
  const forceRefresh = data.refresh === '1' || data.refresh === 'true';
  const mri = scanTraceMri(APP_DATA, {
    days,
    titles: getCachedTitles(),
    forceRefresh,
  });
  for (const s of mri.sessions.slice(0, 15)) {
    warmTitle(s.conversationId);
  }
  return {
    ...mri,
    markdown: formatMriMarkdown(mri),
  };
}

function handleHandoff(data, defaultConvId = '') {
  const convId = String(data.conversationId || defaultConvId || '').trim();
  return exportHandoffToScratch(APP_DATA, convId);
}

// Standalone preview mode (works outside Antigravity host without sidecar_sdk).
function runStandalone(port) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(__dirname, 'index.html'), 'utf-8'));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/preload.js') {
      const stub = `window.sidecar = { conversationId: new URLSearchParams(location.search).get('conversationId') || '', fetch: (u, o) => fetch(u, o), ui: { toggleConversation: () => {} }, agent: {} };`;
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(stub);
      return;
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'Content-Type': type });
      res.end(readFileSync(join(__dirname, file), 'utf-8'));
      return;
    }
    const data = Object.fromEntries(url.searchParams.entries());
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      if (body) {
        try { Object.assign(data, JSON.parse(body)); } catch {}
      }
    }
    try {
      if (req.method === 'GET' && url.pathname === '/api/hud') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(handleHud(data)));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/mri') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(handleMri(data)));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/handoff') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(handleHandoff(data)));
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[context-hud standalone] listening on 127.0.0.1:${server.address().port}`);
  });
}

if (process.argv.includes('--standalone')) {
  const portIdx = process.argv.indexOf('--port');
  const port = portIdx !== -1 ? Number.parseInt(process.argv[portIdx + 1], 10) || 0 : 0;
  runStandalone(port);
} else {
  const { SidecarApp, Response } = await import('sidecar_sdk');
  const app = new SidecarApp();

  app.page('/', () => readFileSync(join(__dirname, 'index.html'), 'utf-8'));
  for (const [route, [file, type]] of Object.entries(STATIC)) {
    app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType: type }), 'GET');
  }
  app.api('/api/hud', (data) => handleHud(data, app.config.conversationId), 'GET');
  app.api('/api/mri', (data) => handleMri(data), 'GET');
  app.api('/api/handoff', (data) => handleHandoff(data, app.config.conversationId), 'POST');

  app.run();
}
