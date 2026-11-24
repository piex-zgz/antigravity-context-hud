/**
 * Read-only transcript telemetry, deterministic Channel-A handoff exporter,
 * and cross-session Trace MRI diagnostics for Antigravity.
 *
 * Strictly zero third-party dependencies (Node.js built-ins only).
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const DEFAULT_COMPACTION_CLIFF = 512_000;
export const RECENT_WINDOW = 40;
export const ID_RE = /^[0-9a-f-]{8,}$/i;

const EDIT_TOOLS = new Set(['edit_file', 'write_file']);
const STRIP_META_RE = /<(?:ADDITIONAL_METADATA|ORCHESTRATOR|CONTEXT_SUMMARY)>[\s\S]*?<\/(?:ADDITIONAL_METADATA|ORCHESTRATOR|CONTEXT_SUMMARY)>/g;

// Wire-anchored Antigravity failure regexes so exit-0 commands printing foreign logs never false-positive.
const GENERIC_CMD_FAIL_RE = /^(?:Created At: [^\r\n]*\r?\nCompleted At: [^\r\n]*\r?\n)?(?:The tool's output was truncated[^\r\n]*\r?\n\r?\nHere is a preview with the middle of the output truncated:\r?\n)?(?:Created At: [^\r\n]*\r?\nCompleted At: [^\r\n]*\r?\n)*Command exited with code ([1-9]\d*)\.?(?:\r?\n|$)/;
const BG_TASK_FAIL_RE = /Task id "[^"]+\/task-\d+" finished with result:\r?\n(?:The tool's output was truncated[^\r\n]*\r?\n\r?\nHere is a preview with the middle of the output truncated:\r?\n)?Command exited with code ([1-9]\d*)\.?(?:\r?\n|$)/;

const URL_RE = /https?:\/\/[^\s"'<>\\`\]\)}）》，。；：、]+/g;
const NOISY_URL_HOSTS = new Set([
  'vertexaisearch.cloud.google.com',
  'daily-cloudcode-pa.googleapis.com',
  'www.w3.org',
  'schemas.openxmlformats.org',
  'example.com',
]);

const SECRET_PATTERNS = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_JWT]'],
  [/(["']?(?:disposable_login_token|access_token|refresh_token|id_token|csrf_token|api[_-]?key|client_secret|flow_id|user_code|password|passwd|secret|ticket|token)["']?\s*[:=]\s*)(["']?)[^\s&"'`,;)}\]]+\2/gi, '$1$2[REDACTED]$2'],
  [/\b(Bearer|Token|Basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi, '$1 [REDACTED]'],
  [/\b(?:sk-[A-Za-z0-9_\-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9\-]{12,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED_KEY]'],
];

// Plain-language friction clusters (Chinese + English pushback patterns).
export const FRICTION_CATEGORIES = [
  {
    id: 'readability',
    label: '读不懂 / 黑话与视角错位',
    shortLabel: '读不懂/黑话',
    patterns: [
      /啥意思|什么意思|没理解|看不懂|看得.*乱|啥玩意|太抽象|说人话|黑话|表格.*乱|不明所以|什么通道|太难读|谁看得懂|太简略|别人都不知道.*是啥/,
      /\b(?:makes no sense|too confusing|unreadable|jargon|plain english|what do you mean|hard to read)\b/i,
    ],
  },
  {
    id: 'overengineering',
    label: '过度设计 / 冗余与跑偏',
    shortLabel: '过度设计/跑偏',
    patterns: [
      /没必要|太重了|过度设计|过度工程|一堆垃圾|写一堆|别加|不要加|砍掉|精简|太复杂|双轨|跑偏|偏离|莫名其妙|用不了|白写|干扰|污染|过时的.*丢|多余/,
      /\b(?:over[- ]?engineer\w*|too complex|unnecessary|bloat\w*|off[- ]?track|wrong direction|don't add|stop adding)\b/i,
    ],
  },
  {
    id: 'fakegreen',
    label: '假绿 / 漏报与实证不足',
    shortLabel: '假绿/漏报',
    patterns: [
      /假绿|误报|漏掉|漏报|根本没|没生效|反复触发|小\s*bug|死循环|越过测试|跳过测试|不对啊|不对吧|算错了|截丢|不准|失真|没跑|没验证|压根没/,
      /\b(?:false positive|fake green|didn't actually|never ran|skipped test|broken again|infinite loop|still failing)\b/i,
    ],
  },
  {
    id: 'workflow',
    label: '交互节奏 / 对齐摩擦',
    shortLabel: '节奏/对齐摩擦',
    patterns: [
      /太一刀切|畏手畏脚|被否了|怎么又|别直接|先别|不要直接|先问我|为什么不先问|自己说一句.*才|感觉不好|不放心|没啥感觉|没对齐|擅自/,
      /\b(?:without asking|ask me first|don't jump ahead|slow down|didn't ask you to)\b/i,
    ],
  },
];

const IGNORE_USER_RE = /^(?:ok|okay|lgtm|yes|no|continue|go ahead|looks good|好的|好|行|可以|同意|继续|确认|收到|谢谢|thanks|\/compact|\/clear|\/goal|\/plan|做个交付吧|继续清理吧|补充|接续一下)[。.!！?？\s]*$/i;

export function resolveAppDataDir() {
  const fromEnv = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (fromEnv) {
    // Under Antigravity host, ANTIGRAVITY_EXECUTABLE_DATA_DIR points to
    // `<appData>/sidecar_data/<id>/data`; walk up to `<appData>`.
    for (let d = fromEnv; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        const appData = dirname(d);
        if (existsSync(join(appData, 'brain'))) return appData;
      }
    }
    if (existsSync(join(fromEnv, 'brain'))) return fromEnv;
  }
  return join(homedir(), '.gemini', 'antigravity');
}

export function compactionCliff() {
  const raw = Number.parseInt(process.env.CONTEXT_HUD_COMPACTION_CLIFF || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COMPACTION_CLIFF;
}

export function redactSecrets(text) {
  let out = String(text || '').replace(URL_RE, (raw) => {
    const m = raw.match(/^(.*?)([.,;:!?)\]}\"']*)$/);
    const core = m ? m[1] : raw;
    const tail = m ? m[2] : '';
    try {
      const u = new URL(core);
      return `${u.protocol}//${u.host}${u.pathname}${tail}`;
    } catch {
      return `[REDACTED_URL]${tail}`;
    }
  });
  for (const [pat, repl] of SECRET_PATTERNS) {
    out = out.replace(pat, repl);
  }
  return out;
}

function sanitizeUrl(rawUrl) {
  const cleaned = String(rawUrl || '').replace(/[.,;:!?)\]}\"']+$/, '');
  try {
    const u = new URL(cleaned);
    const host = (u.hostname || '').toLowerCase();
    if (!host || NOISY_URL_HOSTS.has(host) || host.endsWith('.googleapis.com')) return null;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

function extractCleanUrls(text) {
  const found = [];
  const seen = new Set();
  for (const m of String(text || '').matchAll(URL_RE)) {
    const u = sanitizeUrl(m[0]);
    if (u && !seen.has(u)) {
      seen.add(u);
      found.push(u);
    }
  }
  return found;
}

export function extractUserRequest(rawContent) {
  const s = String(rawContent || '');
  const startTag = '<USER_REQUEST>';
  const endTag = '</USER_REQUEST>';
  const i = s.indexOf(startTag);
  const j = s.lastIndexOf(endTag);
  if (i !== -1 && j !== -1 && j > i) {
    return s.slice(i + startTag.length, j).trim();
  }
  return s.replace(STRIP_META_RE, '').trim();
}

export function parseArgPath(val) {
  if (typeof val !== 'string' || !val.trim()) return null;
  let s = val.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') s = parsed;
    } catch {
      s = s.slice(1, -1);
    }
  }
  return s.trim() || null;
}

function resolveFullTranscript(transcriptPath) {
  if (basename(transcriptPath) === 'transcript.jsonl') {
    const full = join(dirname(transcriptPath), 'transcript_full.jsonl');
    if (existsSync(full)) return full;
  }
  return transcriptPath;
}

function extractFailureSnippet(content, exitCode) {
  const lines = String(content || '').split(/\r?\n/);
  const idx = lines.findIndex((l) => l.includes(`Command exited with code ${exitCode}`));
  const after = idx >= 0 ? lines.slice(idx + 1) : lines;
  const meaningful = after
    .map((l) => l.trim())
    .filter((l) => l && l !== 'Command output:' && !l.startsWith('Log: file://') && !l.startsWith('</SYSTEM_MESSAGE>'))
    .slice(0, 2)
    .join(' | ');
  return redactSecrets((meaningful || `exit code ${exitCode}`).slice(0, 140));
}

function classifyFriction(text) {
  const cleaned = String(text || '').trim();
  if (!cleaned || cleaned.length < 4 || IGNORE_USER_RE.test(cleaned)) return null;
  const probe = cleaned.length > 500 ? cleaned.slice(0, 260) : cleaned;
  for (const cat of FRICTION_CATEGORIES) {
    for (const pat of cat.patterns) {
      if (pat.test(probe)) return cat;
    }
  }
  return null;
}

function freshHudState(filePath, inode) {
  return {
    path: filePath,
    inode,
    offset: 0,
    is_main: false,
    total_steps: 0,
    first_step_index: null,
    checkpoints: 0,
    latest_effective_tokens: 0,
    peak_effective_tokens: 0,
    latest_model: '',
    last_step_at: '',
    gen_steps: 0,
    gen_user_turns: 0,
    gen_tool_actions: 0,
    total_cmd_failures: 0,
    recent_cmd_fails: [],
    token_series: [],
    file_edits: {},
    recent_failures: [],
    first_user_prompt: '',
    total_user_turns: 0,
  };
}

function shouldParseHudLine(line, isMain, firstStepSeen) {
  if (!firstStepSeen) return true;
  if (!isMain && (line.includes('"USER_INPUT"') || line.includes('"USER_EXPLICIT"'))) return true;
  return (
    line.includes('"CHECKPOINT"') ||
    line.includes('"USER_INPUT"') ||
    line.includes('"PLANNER_RESPONSE"') ||
    line.includes('Command exited with code ')
  );
}

function buildHealthReport(state, cliff) {
  const g = state.checkpoints || 0;
  const eff = state.latest_effective_tokens || 0;
  const peak = state.peak_effective_tokens || 0;
  const firstIdx = state.first_step_index;
  const isForked = typeof firstIdx === 'number' && firstIdx > 0;
  const genUi = state.gen_user_turns || 0;
  const genActions = state.gen_tool_actions || 0;
  const actionsPerUi = Math.round((genActions / Math.max(1, genUi)) * 10) / 10;
  const recentFails = state.recent_cmd_fails.reduce((a, b) => a + b, 0);
  const fillRatio = cliff > 0 ? Math.round((eff / cliff) * 1000) / 1000 : 0;

  const reasons = [];
  let level = 'GREEN';
  if (
    (g >= 2 && (fillRatio >= 0.70 || recentFails >= 4 || (fillRatio >= 0.45 && actionsPerUi >= 40.0))) ||
    (g >= 1 && recentFails >= 6) ||
    (fillRatio >= 0.85 && (recentFails >= 4 || actionsPerUi >= 25.0))
  ) {
    level = 'RED';
    if (g >= 2) reasons.push(`已多代压缩（G=${g}），早期细节持续折损`);
    if (fillRatio >= 0.70) reasons.push(`当前水位 ${Math.round(fillRatio * 100)}%（${eff.toLocaleString()}/${cliff.toLocaleString()}）`);
    if ((g >= 2 && fillRatio >= 0.45 && actionsPerUi >= 40.0) || (fillRatio >= 0.85 && actionsPerUi >= 25.0)) {
      reasons.push(`工具密度偏高（${actionsPerUi} 次/轮）`);
    }
    if (recentFails >= 4) reasons.push(`近 ${RECENT_WINDOW} 步出现 ${recentFails} 次命令失败`);
  } else if (
    g >= 2 ||
    fillRatio >= 0.75 ||
    (isForked && fillRatio >= 0.55) ||
    (g >= 1 && actionsPerUi >= 20.0) ||
    recentFails >= 5
  ) {
    level = 'YELLOW';
    if (g >= 2) reasons.push(`已压缩 ${g} 代，建议关注上下文失真`);
    if (fillRatio >= 0.75 || (isForked && fillRatio >= 0.55)) {
      reasons.push(`当前水位 ${Math.round(fillRatio * 100)}%（${eff.toLocaleString()}/${cliff.toLocaleString()}）`);
    }
    if (g >= 1 && actionsPerUi >= 20.0) reasons.push(`工具密度较高（${actionsPerUi} 次/轮）`);
    if (recentFails >= 5) reasons.push(`近 ${RECENT_WINDOW} 步出现 ${recentFails} 次命令失败`);
  }

  const hotFiles = Object.entries(state.file_edits)
    .map(([filePath, edits]) => ({
      path: filePath,
      name: basename(filePath),
      edits,
      churn: edits >= 4,
    }))
    .sort((a, b) => b.edits - a.edits || a.name.localeCompare(b.name))
    .slice(0, 8);

  return {
    level,
    reasons,
    is_main: Boolean(state.is_main),
    is_forked: isForked,
    first_step_index: firstIdx,
    total_steps: state.total_steps,
    total_user_turns: state.total_user_turns,
    compaction_generation: g,
    latest_effective_tokens: eff,
    peak_effective_tokens: peak,
    compaction_cliff: cliff,
    fill_ratio: fillRatio,
    fill_percent: Math.min(100, Math.round(fillRatio * 100)),
    latest_model: state.latest_model,
    last_step_at: state.last_step_at,
    gen_steps: state.gen_steps,
    gen_user_turns: genUi,
    gen_tool_actions: genActions,
    actions_per_ui: actionsPerUi,
    recent_cmd_failures: recentFails,
    total_cmd_failures: state.total_cmd_failures,
    token_series: state.token_series.slice(-36),
    hot_files: hotFiles,
    recent_failures: state.recent_failures.slice(-5).reverse(),
    first_user_prompt: state.first_user_prompt,
  };
}

const hudCache = new Map();

export function inspectTranscriptIncremental(transcriptPath, { cliff = compactionCliff(), cache = hudCache } = {}) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    const empty = freshHudState(transcriptPath || '', 0);
    return { report: buildHealthReport(empty, cliff), exists: false };
  }
  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    const empty = freshHudState(transcriptPath, 0);
    return { report: buildHealthReport(empty, cliff), exists: false };
  }

  const inode = Number(st.ino);
  const size = Number(st.size);
  let state = cache ? cache.get(transcriptPath) : null;
  if (!state || state.inode !== inode || state.offset < 0 || state.offset > size) {
    state = freshHudState(transcriptPath, inode);
  }

  if (size > state.offset) {
    const toRead = size - state.offset;
    const buf = Buffer.allocUnsafe(toRead);
    const fd = openSync(transcriptPath, 'r');
    let bytesRead = 0;
    try {
      while (bytesRead < toRead) {
        const n = readSync(fd, buf, bytesRead, toRead - bytesRead, state.offset + bytesRead);
        if (n <= 0) break;
        bytesRead += n;
      }
    } finally {
      closeSync(fd);
    }

    const chunk = buf.subarray(0, bytesRead);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline !== -1) {
      const completeBytes = lastNewline + 1;
      state.offset += completeBytes;
      const lines = chunk.subarray(0, completeBytes).toString('utf-8').split('\n');
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;
        state.total_steps += 1;
        state.gen_steps += 1;
        let stepFailed = 0;

        if (shouldParseHudLine(line, state.is_main, state.first_step_index !== null)) {
          let obj = null;
          try {
            obj = JSON.parse(line);
          } catch {
            obj = null;
          }
          if (obj && typeof obj === 'object') {
            if (state.first_step_index === null && typeof obj.step_index === 'number') {
              state.first_step_index = obj.step_index;
            }
            if (typeof obj.created_at === 'string' && obj.created_at) {
              state.last_step_at = obj.created_at;
            }
            const stType = obj.type;
            const stSrc = obj.source;
            const stepIdx = typeof obj.step_index === 'number' ? obj.step_index : state.total_steps - 1;
            if (stType === 'USER_INPUT' || stSrc === 'USER_EXPLICIT') {
              state.is_main = true;
            }
            if (stType === 'USER_INPUT') {
              state.gen_user_turns += 1;
              state.total_user_turns += 1;
              if (!state.first_user_prompt) {
                const req = redactSecrets(extractUserRequest(obj.content || ''))
                  .replace(/\s+/g, ' ')
                  .trim();
                if (req) state.first_user_prompt = req.slice(0, 90);
              }
            } else if (stType === 'CHECKPOINT') {
              state.checkpoints += 1;
              state.latest_effective_tokens = 0;
              state.gen_steps = 0;
              state.gen_user_turns = 0;
              state.gen_tool_actions = 0;
              state.recent_cmd_fails = [];
              state.token_series.push({ step: stepIdx, tokens: 0, gen: state.checkpoints, checkpoint: true });
              if (state.token_series.length > 80) state.token_series = state.token_series.slice(-60);
            } else if (stType === 'PLANNER_RESPONSE') {
              const tcs = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
              state.gen_tool_actions += tcs.length;
              for (const tc of tcs) {
                if (tc && EDIT_TOOLS.has(tc.name)) {
                  const p = parseArgPath(tc.args?.Path || tc.args?.path);
                  if (p) state.file_edits[p] = (state.file_edits[p] || 0) + 1;
                }
              }
              const inTok = typeof obj.input_tokens === 'number' ? obj.input_tokens : 0;
              const cacheTok = typeof obj.cache_read_tokens === 'number' ? obj.cache_read_tokens : 0;
              const eff = inTok + cacheTok;
              if (eff > 0) {
                state.latest_effective_tokens = eff;
                if (eff > state.peak_effective_tokens) state.peak_effective_tokens = eff;
                state.token_series.push({ step: stepIdx, tokens: eff, gen: state.checkpoints });
                if (state.token_series.length > 80) state.token_series = state.token_series.slice(-60);
              }
              if (typeof obj.model === 'string' && obj.model) {
                state.latest_model = obj.model;
              }
            } else if (stType === 'GENERIC') {
              const m = typeof obj.content === 'string' ? GENERIC_CMD_FAIL_RE.exec(obj.content) : null;
              if (m) {
                stepFailed = 1;
                state.total_cmd_failures += 1;
                state.recent_failures.push({
                  step: stepIdx,
                  code: Number(m[1]),
                  snippet: extractFailureSnippet(obj.content, m[1]),
                  at: obj.created_at || '',
                });
                if (state.recent_failures.length > 10) state.recent_failures = state.recent_failures.slice(-8);
              }
            } else if (stType === 'SYSTEM_MESSAGE') {
              const m = typeof obj.content === 'string' ? BG_TASK_FAIL_RE.exec(obj.content) : null;
              if (m) {
                stepFailed = 1;
                state.total_cmd_failures += 1;
                state.recent_failures.push({
                  step: stepIdx,
                  code: Number(m[1]),
                  snippet: extractFailureSnippet(obj.content, m[1]),
                  at: obj.created_at || '',
                });
                if (state.recent_failures.length > 10) state.recent_failures = state.recent_failures.slice(-8);
              }
            }
          }
        }

        state.recent_cmd_fails.push(stepFailed);
        if (state.recent_cmd_fails.length > RECENT_WINDOW) {
          state.recent_cmd_fails.splice(0, state.recent_cmd_fails.length - RECENT_WINDOW);
        }
      }
    }
  }

  if (cache) {
    if (cache.size > 100) cache.clear();
    cache.set(transcriptPath, state);
  }
  return { report: buildHealthReport(state, cliff), exists: true };
}

export function inspectConversationHud(appData, convId, { cliff = compactionCliff() } = {}) {
  if (!convId || !ID_RE.test(convId)) {
    return { conversationId: convId || null, exists: false, report: null };
  }
  const transcriptPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  const { report, exists } = inspectTranscriptIncremental(transcriptPath, { cliff });
  return {
    conversationId: convId,
    transcriptPath,
    exists,
    report,
  };
}

/**
 * Pure zero-dependency deterministic handoff exporter (zero LLM rewriting,
 * secret-redacted before clipping, anchored by `(line_no, step_index)`).
 */
export function buildHandoffMarkdown(transcriptPath, { maxUserChars = 800, cliff = compactionCliff() } = {}) {
  const src = resolveFullTranscript(transcriptPath);
  const raw = readFileSync(src, 'utf-8');
  const rawLines = raw.split('\n');

  const userEntries = [];
  const checkpoints = [];
  const fileEdits = new Map();
  const urls = [];
  const seenUrls = new Set();
  let subagentCount = 0;
  let totalLines = 0;
  let lastStepIndex = null;
  let lastUserSig = null;

  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const line = rawLines[idx].trim();
    if (!line) continue;
    const lineNo = idx + 1;
    totalLines = lineNo;
    if (!line.includes('"USER_INPUT"') && !line.includes('"CHECKPOINT"') && !line.includes('"PLANNER_RESPONSE"')) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const stepIdx = typeof obj.step_index === 'number' ? obj.step_index : null;
    if (stepIdx !== null) lastStepIndex = stepIdx;
    const stType = obj.type;
    const content = typeof obj.content === 'string' ? obj.content : '';
    const createdAt = String(obj.created_at || '').slice(0, 19).replace('T', ' ');

    if (stType === 'USER_INPUT' && content) {
      const req = redactSecrets(extractUserRequest(content));
      if (!req) continue;
      const sig = `${stepIdx}:${req}`;
      if (sig === lastUserSig) continue;
      if (
        userEntries.length &&
        stepIdx !== null &&
        userEntries[userEntries.length - 1].stepIndex === stepIdx &&
        req.startsWith(userEntries[userEntries.length - 1].rawPrefix)
      ) {
        userEntries.pop();
      }
      lastUserSig = sig;
      for (const u of extractCleanUrls(req)) {
        if (!seenUrls.has(u)) {
          seenUrls.add(u);
          urls.push(u);
        }
      }
      const clipped = req.length <= maxUserChars ? req : `${req.slice(0, maxUserChars).trimEnd()} ... [clipped]`;
      userEntries.push({
        lineNo,
        stepIndex: stepIdx,
        createdAt,
        text: clipped,
        rawPrefix: req.slice(0, 200),
      });
    } else if (stType === 'CHECKPOINT') {
      checkpoints.push({ lineNo, stepIndex: stepIdx, createdAt });
    } else if (stType === 'PLANNER_RESPONSE') {
      if (content) {
        for (const u of extractCleanUrls(content)) {
          if (!seenUrls.has(u)) {
            seenUrls.add(u);
            urls.push(u);
          }
        }
      }
      for (const tc of Array.isArray(obj.tool_calls) ? obj.tool_calls : []) {
        if (!tc || typeof tc !== 'object') continue;
        if (tc.name === 'invoke_subagent') subagentCount += 1;
        if (EDIT_TOOLS.has(tc.name)) {
          const pStr = parseArgPath(tc.args?.Path || tc.args?.path);
          if (pStr && !pStr.includes('/.gemini/antigravity/brain/') && !pStr.includes('/scratch/') && !pStr.startsWith('/tmp/')) {
            fileEdits.set(pStr, (fileEdits.get(pStr) || 0) + 1);
          }
        }
      }
    }
  }

  const healthRep = inspectTranscriptIncremental(src, { cliff, cache: null }).report;
  const out = [
    '# Deterministic Session Handoff (Zero LLM Rewriting)',
    '',
    `- **Full Transcript Pointer**: \`${src}\` (lines \`1..${totalLines}\`, last \`step_index=${lastStepIndex}\`)`,
    `- **Session Health**: \`${healthRep.level}\` | \`G=${healthRep.compaction_generation}\` | Context \`${healthRep.latest_effective_tokens.toLocaleString()}/${healthRep.compaction_cliff.toLocaleString()}\` | Shell fails \`${healthRep.recent_cmd_failures}\` (recent ${RECENT_WINDOW}) / \`${healthRep.total_cmd_failures}\` total`,
  ];
  if (subagentCount) {
    out.push(`- **Subagents Invoked**: ${subagentCount} (inspect workspace \`git status\`/\`git log\` for subagent edits)`);
  }

  out.push('', '## 1. Verbatim User Requests & Corrections (`<USER_REQUEST>` only)');
  if (!userEntries.length) {
    out.push('- (none)');
  } else {
    for (const e of userEntries) {
      const flat = e.text.replace(/\s+/g, ' ').trim();
      out.push(`- \`(L${e.lineNo}, step=${e.stepIndex}, ${e.createdAt})\` ${flat}`);
    }
  }

  out.push('', '## 2. Generation / Checkpoint Page-Fault Index');
  if (!checkpoints.length) {
    out.push(`- \`G0\`: lines \`1..${totalLines}\` (no compaction)`);
  } else {
    let prevLine = 1;
    checkpoints.forEach((cp, idx) => {
      out.push(`- \`G${idx}\`: lines \`${prevLine}..${cp.lineNo - 1}\` → **CHECKPOINT** at \`(L${cp.lineNo}, step=${cp.stepIndex}, ${cp.createdAt})\``);
      prevLine = cp.lineNo + 1;
    });
    if (prevLine <= totalLines) {
      out.push(`- \`G${checkpoints.length}\` (current): lines \`${prevLine}..${totalLines}\``);
    }
  }

  out.push('', '## 3. Touched Workspace Files (Direct Tool Edits)');
  const sortedEdits = [...fileEdits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!sortedEdits.length) {
    out.push('- (no direct workspace `edit_file`/`write_file` edits recorded outside scratch)');
  } else {
    for (const [fpath, cnt] of sortedEdits.slice(0, 30)) {
      out.push(`- \`${fpath}\` (${cnt} edits)`);
    }
    if (sortedEdits.length > 30) {
      out.push(`- ... (+${sortedEdits.length - 30} more files)`);
    }
  }

  if (urls.length) {
    out.push('', '## 4. Referenced External Links (Query Strings Stripped)');
    for (const u of urls.slice(0, 25)) {
      out.push(`- ${u}`);
    }
  }

  out.push(
    '',
    `## ${urls.length ? 5 : 4}. New-Session Landing Instruction`,
    `Read this deterministic handoff and inspect the current workspace files directly (page-fault exact lines from \`${src}\` only if a specific past detail is ambiguous). Before making broad edits, confirm:`,
    '1. Exact next concrete diff/plan (target files and change);',
    '2. 1 explicit non-goal (what you will NOT build or change);',
    '3. 1 real-sample verification target.',
  );

  return `${out.join('\n')}\n`;
}

function timestampStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function exportHandoffToScratch(appData, convId, { cliff = compactionCliff() } = {}) {
  if (!convId || !ID_RE.test(convId)) {
    return { ok: false, error: '无效的 conversationId' };
  }
  const transcriptPath = join(appData, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(transcriptPath)) {
    return { ok: false, error: '当前会话尚未生成 transcript.jsonl' };
  }
  const scratchDir = join(appData, 'brain', convId, 'scratch');
  mkdirSync(scratchDir, { recursive: true });
  const outPath = join(scratchDir, `handoff-${timestampStamp()}.md`);
  const md = buildHandoffMarkdown(transcriptPath, { cliff });
  writeFileSync(outPath, md, 'utf-8');
  return {
    ok: true,
    path: outPath,
    bytes: Buffer.byteLength(md, 'utf-8'),
    starterPrompt: `请先读取交接包 ${outPath}，按其中最新用户目标继续推进。`,
  };
}

function isMainTranscriptFast(filePath) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n).toString('utf-8');
    return head.includes('"USER_INPUT"') || head.includes('"USER_EXPLICIT"');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

const mriFileCache = new Map();

function analyzeSessionForMri(convId, logsDir, cliff) {
  const compactPath = join(logsDir, 'transcript.jsonl');
  const fullPath = join(logsDir, 'transcript_full.jsonl');
  const chosenPath = existsSync(fullPath) ? fullPath : compactPath;
  if (!existsSync(chosenPath)) return null;
  if (!isMainTranscriptFast(compactPath) && !isMainTranscriptFast(chosenPath)) return null;

  let st;
  try {
    st = statSync(chosenPath);
  } catch {
    return null;
  }
  const cacheKey = `${st.mtimeMs}:${st.size}`;
  const cached = mriFileCache.get(chosenPath);
  if (cached && cached.key === cacheKey) return cached.summary;

  const state = freshHudState(chosenPath, Number(st.ino));
  const frictions = [];
  const raw = readFileSync(chosenPath, 'utf-8');
  const lines = raw.split('\n');
  let startedAt = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    state.total_steps += 1;
    state.gen_steps += 1;
    let stepFailed = 0;

    if (shouldParseHudLine(line, state.is_main, state.first_step_index !== null)) {
      let obj = null;
      try {
        obj = JSON.parse(line);
      } catch {
        obj = null;
      }
      if (obj && typeof obj === 'object') {
        if (state.first_step_index === null && typeof obj.step_index === 'number') {
          state.first_step_index = obj.step_index;
        }
        if (typeof obj.created_at === 'string' && obj.created_at) {
          if (!startedAt) startedAt = obj.created_at;
          state.last_step_at = obj.created_at;
        }
        const stType = obj.type;
        const stSrc = obj.source;
        const stepIdx = typeof obj.step_index === 'number' ? obj.step_index : state.total_steps - 1;
        if (stType === 'USER_INPUT' || stSrc === 'USER_EXPLICIT') state.is_main = true;

        if (stType === 'USER_INPUT') {
          state.gen_user_turns += 1;
          state.total_user_turns += 1;
          const req = redactSecrets(extractUserRequest(obj.content || ''));
          const singleLine = req.replace(/\s+/g, ' ').trim();
          if (!state.first_user_prompt && singleLine) {
            state.first_user_prompt = singleLine.slice(0, 90);
          }
          const cat = classifyFriction(req);
          if (cat) {
            frictions.push({
              conversationId: convId,
              step: stepIdx,
              at: obj.created_at || '',
              categoryId: cat.id,
              categoryLabel: cat.shortLabel,
              quote: singleLine.slice(0, 180),
            });
          }
        } else if (stType === 'CHECKPOINT') {
          state.checkpoints += 1;
          state.latest_effective_tokens = 0;
          state.gen_steps = 0;
          state.gen_user_turns = 0;
          state.gen_tool_actions = 0;
          state.recent_cmd_fails = [];
        } else if (stType === 'PLANNER_RESPONSE') {
          const tcs = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
          state.gen_tool_actions += tcs.length;
          for (const tc of tcs) {
            if (tc && EDIT_TOOLS.has(tc.name)) {
              const p = parseArgPath(tc.args?.Path || tc.args?.path);
              if (p) state.file_edits[p] = (state.file_edits[p] || 0) + 1;
            }
          }
          const inTok = typeof obj.input_tokens === 'number' ? obj.input_tokens : 0;
          const cacheTok = typeof obj.cache_read_tokens === 'number' ? obj.cache_read_tokens : 0;
          const eff = inTok + cacheTok;
          if (eff > 0) {
            state.latest_effective_tokens = eff;
            if (eff > state.peak_effective_tokens) state.peak_effective_tokens = eff;
          }
          if (typeof obj.model === 'string' && obj.model) state.latest_model = obj.model;
        } else if (stType === 'GENERIC') {
          const m = typeof obj.content === 'string' ? GENERIC_CMD_FAIL_RE.exec(obj.content) : null;
          if (m) {
            stepFailed = 1;
            state.total_cmd_failures += 1;
            state.recent_failures.push({
              step: stepIdx,
              code: Number(m[1]),
              snippet: extractFailureSnippet(obj.content, m[1]),
              at: obj.created_at || '',
            });
          }
        } else if (stType === 'SYSTEM_MESSAGE') {
          const m = typeof obj.content === 'string' ? BG_TASK_FAIL_RE.exec(obj.content) : null;
          if (m) {
            stepFailed = 1;
            state.total_cmd_failures += 1;
            state.recent_failures.push({
              step: stepIdx,
              code: Number(m[1]),
              snippet: extractFailureSnippet(obj.content, m[1]),
              at: obj.created_at || '',
            });
          }
        }
      }
    }

    state.recent_cmd_fails.push(stepFailed);
    if (state.recent_cmd_fails.length > RECENT_WINDOW) {
      state.recent_cmd_fails.splice(0, state.recent_cmd_fails.length - RECENT_WINDOW);
    }
  }

  if (!state.is_main) return null;
  const rep = buildHealthReport(state, cliff);
  const summary = {
    conversationId: convId,
    mtimeMs: st.mtimeMs,
    startedAt,
    lastStepAt: rep.last_step_at,
    firstPrompt: rep.first_user_prompt,
    level: rep.level,
    reasons: rep.reasons,
    compactionGeneration: rep.compaction_generation,
    fillPercent: rep.fill_percent,
    peakPercent: cliff > 0 ? Math.min(100, Math.round((rep.peak_effective_tokens / cliff) * 100)) : 0,
    latestEffectiveTokens: rep.latest_effective_tokens,
    totalSteps: rep.total_steps,
    userTurns: rep.total_user_turns,
    totalCmdFailures: rep.total_cmd_failures,
    recentCmdFailures: rep.recent_cmd_failures,
    frictionCount: frictions.length,
    frictions,
    fileEdits: state.file_edits,
    recentFailures: rep.recent_failures.slice(0, 3),
  };

  if (mriFileCache.size > 200) mriFileCache.clear();
  mriFileCache.set(chosenPath, { key: cacheKey, summary });
  return summary;
}

export function scanTraceMri(appData, { days = 7, cliff = compactionCliff(), titles = {}, forceRefresh = false } = {}) {
  const t0 = Date.now();
  if (forceRefresh) mriFileCache.clear();
  const brainDir = join(appData, 'brain');
  if (!existsSync(brainDir)) {
    return {
      scannedAt: new Date().toISOString(),
      elapsedMs: Date.now() - t0,
      days,
      totals: { sessions: 0, red: 0, yellow: 0, green: 0, userTurns: 0, frictions: 0, frictionRate: 0, cmdFailures: 0 },
      categories: FRICTION_CATEGORIES.map((c) => ({ id: c.id, label: c.label, shortLabel: c.shortLabel, count: 0, share: 0 })),
      frictions: [],
      churnHotspots: [],
      sessions: [],
    };
  }

  const cutoffMs = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const entries = readdirSync(brainDir, { withFileTypes: true });
  const sessions = [];

  for (const ent of entries) {
    if (!ent.isDirectory() || !ID_RE.test(ent.name)) continue;
    const logsDir = join(brainDir, ent.name, '.system_generated', 'logs');
    const probeFile = existsSync(join(logsDir, 'transcript.jsonl'))
      ? join(logsDir, 'transcript.jsonl')
      : join(logsDir, 'transcript_full.jsonl');
    if (!existsSync(probeFile)) continue;
    let st;
    try {
      st = statSync(probeFile);
    } catch {
      continue;
    }
    if (cutoffMs && st.mtimeMs < cutoffMs) continue;
    const summary = analyzeSessionForMri(ent.name, logsDir, cliff);
    if (summary) sessions.push(summary);
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const catCounts = Object.fromEntries(FRICTION_CATEGORIES.map((c) => [c.id, 0]));
  const allFrictions = [];
  const fileAgg = new Map();

  let red = 0;
  let yellow = 0;
  let green = 0;
  let totalUserTurns = 0;
  let totalCmdFailures = 0;

  for (const s of sessions) {
    if (s.level === 'RED') red += 1;
    else if (s.level === 'YELLOW') yellow += 1;
    else green += 1;
    totalUserTurns += s.userTurns;
    totalCmdFailures += s.totalCmdFailures;

    const title = titles[s.conversationId] || s.firstPrompt || s.conversationId.slice(0, 8);
    for (const f of s.frictions) {
      catCounts[f.categoryId] = (catCounts[f.categoryId] || 0) + 1;
      allFrictions.push({ ...f, title });
    }
    for (const [fp, cnt] of Object.entries(s.fileEdits)) {
      let rec = fileAgg.get(fp);
      if (!rec) {
        rec = { path: fp, name: basename(fp), totalEdits: 0, maxInSession: 0, sessionIds: new Set() };
        fileAgg.set(fp, rec);
      }
      rec.totalEdits += cnt;
      if (cnt > rec.maxInSession) rec.maxInSession = cnt;
      rec.sessionIds.add(s.conversationId);
    }
  }

  const totalFrictions = allFrictions.length;
  const categories = FRICTION_CATEGORIES.map((c) => ({
    id: c.id,
    label: c.label,
    shortLabel: c.shortLabel,
    count: catCounts[c.id] || 0,
    share: totalFrictions > 0 ? Math.round(((catCounts[c.id] || 0) / totalFrictions) * 100) : 0,
  })).sort((a, b) => b.count - a.count);

  allFrictions.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));

  const churnHotspots = [...fileAgg.values()]
    .filter((r) => r.totalEdits >= 3)
    .map((r) => ({
      path: r.path,
      name: r.name,
      totalEdits: r.totalEdits,
      maxInSession: r.maxInSession,
      sessionCount: r.sessionIds.size,
    }))
    .sort((a, b) => b.totalEdits - a.totalEdits || b.sessionCount - a.sessionCount || a.name.localeCompare(b.name))
    .slice(0, 12);

  return {
    scannedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    days,
    totals: {
      sessions: sessions.length,
      red,
      yellow,
      green,
      userTurns: totalUserTurns,
      frictions: totalFrictions,
      frictionRate: totalUserTurns > 0 ? Math.round((totalFrictions / totalUserTurns) * 100) : 0,
      cmdFailures: totalCmdFailures,
    },
    categories,
    frictions: allFrictions.slice(0, 60),
    churnHotspots,
    sessions: sessions.map((s) => ({
      conversationId: s.conversationId,
      title: titles[s.conversationId] || s.firstPrompt || s.conversationId.slice(0, 8),
      firstPrompt: s.firstPrompt,
      mtimeMs: s.mtimeMs,
      lastStepAt: s.lastStepAt,
      level: s.level,
      reasons: s.reasons,
      compactionGeneration: s.compactionGeneration,
      fillPercent: s.fillPercent,
      peakPercent: s.peakPercent,
      latestEffectiveTokens: s.latestEffectiveTokens,
      totalSteps: s.totalSteps,
      userTurns: s.userTurns,
      totalCmdFailures: s.totalCmdFailures,
      recentCmdFailures: s.recentCmdFailures,
      frictionCount: s.frictionCount,
    })),
  };
}

export function formatMriMarkdown(mri) {
  const label = mri.days > 0 ? `近 ${mri.days} 天` : '全部历史';
  const lines = [
    `# Agent 轨迹体检报告（${label}）`,
    '',
    `- **扫描主会话**：${mri.totals.sessions} 个（🔴 ${mri.totals.red} / 🟡 ${mri.totals.yellow} / 🟢 ${mri.totals.green}）`,
    `- **用户发言轮次**：${mri.totals.userTurns} 轮｜**识别摩擦/打回**：${mri.totals.frictions} 轮（${mri.totals.frictionRate}%）｜**累计真实命令失败**：${mri.totals.cmdFailures} 次`,
    '',
    '## 1. 摩擦主题分布',
  ];
  for (const c of mri.categories) {
    lines.push(`- **${c.label}**：${c.count} 次（${c.share}%）`);
  }
  if (mri.churnHotspots.length) {
    lines.push('', '## 2. 高频返工热点文件（编辑 ≥ 3 次）');
    for (const h of mri.churnHotspots.slice(0, 8)) {
      lines.push(`- \`${h.name}\`：累计 ${h.totalEdits} 次（单会话最高 ${h.maxInSession} 次，跨 ${h.sessionCount} 个会话）— \`${h.path}\``);
    }
  }
  if (mri.frictions.length) {
    lines.push('', '## 3. 近期典型摩擦原话（前 10 条）');
    for (const f of mri.frictions.slice(0, 10)) {
      lines.push(`- [${f.categoryLabel}] **${f.title}** (step ${f.step}): ${f.quote}`);
    }
  }
  return lines.join('\n');
}
