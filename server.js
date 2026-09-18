import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
// Small dependency-free .env loader. Existing environment variables always win.
try {
  const envText = await readFile(path.join(root, '.env'), 'utf8');
  for (const line of envText.split(/\r?\n/)) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(path.join(root, 'data'), { recursive: true });
const db = new DatabaseSync(path.join(root, 'data', 'api-hub.db'));
db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS connectors (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, description TEXT NOT NULL,
 provider TEXT NOT NULL, model TEXT NOT NULL, instructions TEXT NOT NULL,
 input_schema TEXT NOT NULL, output_schema TEXT NOT NULL, auth_mode TEXT NOT NULL DEFAULT 'api_key',
 api_key_hash TEXT NOT NULL, api_key_preview TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS request_logs (
 id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, success INTEGER NOT NULL, status_code INTEGER NOT NULL,
 provider TEXT, model TEXT, duration_ms INTEGER NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
 total_tokens INTEGER, estimated_cost REAL, error_type TEXT, error_message TEXT, created_at TEXT NOT NULL
);`);

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value);
const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const apiKey = () => `uai_${randomBytes(24).toString('base64url')}`;
const publicConnector = (row) => row && ({ ...row, input_schema: parse(row.input_schema, []), output_schema: parse(row.output_schema, {}), api_key_hash: undefined });

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(json(body));
}
async function body(req) {
  const chunks = []; let total = 0;
  for await (const chunk of req) { total += chunk.length; if (total > 8_000_000) throw Object.assign(new Error('Request exceeds 8 MB limit'), { status: 413 }); chunks.push(chunk); }
  const buffer = Buffer.concat(chunks); const raw = buffer.toString();
  if (!raw) return {};
  const contentType = req.headers['content-type'] || '';
  if (contentType.includes('application/json')) { try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Invalid JSON request body'), { status: 400 }); } }
  const match = contentType.match(/multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!match) throw Object.assign(new Error('Send application/json or multipart/form-data'), { status: 415 });
  const boundary = Buffer.from(`--${match[1] || match[2]}`); const output = {}; let cursor = 0;
  while (cursor < buffer.length) {
    const start = buffer.indexOf(boundary, cursor); if (start < 0) break;
    const headerStart = start + boundary.length + 2; const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart); if (headerEnd < 0) break;
    const header = buffer.subarray(headerStart, headerEnd).toString(); const next = buffer.indexOf(boundary, headerEnd + 4); if (next < 0) break;
    const value = buffer.subarray(headerEnd + 4, next - 2); const name = header.match(/name="([^"]+)"/i)?.[1]; const filename = header.match(/filename="([^"]*)"/i)?.[1]; const mimeType = header.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
    if (name) output[name] = filename ? { filename, mime_type: mimeType || 'application/octet-stream', data: value.toString('base64') } : value.toString();
    cursor = next;
  }
  return output;
}
function assertAdmin(req) {
  if (ADMIN_TOKEN && req.headers['x-admin-token'] !== ADMIN_TOKEN) throw Object.assign(new Error('Admin authentication required'), { status: 401 });
}
function validSlug(value) { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value); }
function validateConnector(value, partial = false) {
  const required = ['name', 'slug', 'description', 'provider', 'model', 'instructions', 'input_schema', 'output_schema'];
  if (!partial) for (const field of required) if (value[field] === undefined || value[field] === '') throw Object.assign(new Error(`${field} is required`), { status: 400 });
  if (value.slug && !validSlug(value.slug)) throw Object.assign(new Error('Slug must be lowercase words separated by hyphens'), { status: 400 });
  if (value.provider && !['openai', 'gemini', 'groq'].includes(value.provider)) throw Object.assign(new Error('Provider must be openai, gemini, or groq'), { status: 400 });
  if (value.status && !['active', 'disabled'].includes(value.status)) throw Object.assign(new Error('Status must be active or disabled'), { status: 400 });
  if (value.input_schema !== undefined && (!Array.isArray(value.input_schema) || value.input_schema.some(f => !f.name || !['text','number','boolean','image','file','json'].includes(f.type)))) throw Object.assign(new Error('Input schema must contain named supported fields'), { status: 400 });
  if (value.output_schema !== undefined && (typeof value.output_schema !== 'object' || Array.isArray(value.output_schema))) throw Object.assign(new Error('Output schema must be a JSON object'), { status: 400 });
}
function validateInput(schema, input) {
  for (const field of schema) {
    const value = input[field.name];
    if (field.required && (value === undefined || value === null || value === '')) throw Object.assign(new Error(`Missing required input: ${field.name}`), { status: 400 });
    if (value !== undefined && field.type === 'number' && typeof value !== 'number') throw Object.assign(new Error(`${field.name} must be a number`), { status: 400 });
    if (value !== undefined && field.type === 'boolean' && typeof value !== 'boolean') throw Object.assign(new Error(`${field.name} must be a boolean`), { status: 400 });
    if (value !== undefined && field.type === 'json' && typeof value !== 'object') throw Object.assign(new Error(`${field.name} must be JSON`), { status: 400 });
    if (value !== undefined && ['image','file'].includes(field.type) && !(typeof value === 'object' && value.data && value.mime_type)) throw Object.assign(new Error(`${field.name} must be supplied as a multipart file or { data, mime_type } JSON object`), { status: 400 });
  }
}
function normalizeInput(schema, input) {
  for (const field of schema) {
    if (typeof input[field.name] !== 'string') continue;
    if (field.type === 'number') input[field.name] = Number(input[field.name]);
    if (field.type === 'boolean') input[field.name] = input[field.name].toLowerCase() === 'true';
    if (field.type === 'json') { try { input[field.name] = JSON.parse(input[field.name]); } catch { /* validation reports it */ } }
  }
  return input;
}
function outputSchema(schema) {
  const properties = {}; const required = [];
  for (const [key, type] of Object.entries(schema)) { properties[key] = { type: type === 'number' ? 'number' : type === 'boolean' ? 'boolean' : type === 'array' ? 'array' : type === 'object' ? 'object' : 'string' }; required.push(key); }
  return { type: 'object', properties, required, additionalProperties: false };
}
function extractJson(value) {
  if (typeof value === 'object') return value;
  const stripped = String(value).replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(stripped);
}
async function askProvider(connector, input) {
  const schema = outputSchema(parse(connector.output_schema, {}));
  const safeInput = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, value?.data ? { filename: value.filename, mime_type: value.mime_type, uploaded: true } : value]));
  const instruction = `${connector.instructions}\n\nReturn only JSON conforming to this schema:\n${json(schema)}\n\nUser input:\n${json(safeInput)}`;
  if (connector.provider === 'openai') {
    if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error('OPENAI_API_KEY is not configured on the server'), { status: 503, type: 'configuration' });
    const content = [{ type: 'text', text: instruction }, ...Object.values(input).filter(v => v?.data && v.mime_type?.startsWith('image/')).map(v => ({ type: 'image_url', image_url: { url: `data:${v.mime_type};base64,${v.data}` } }))];
    const response = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'content-type': 'application/json' }, body: json({ model: connector.model, messages: [{ role: 'system', content: 'You produce strict JSON responses.' }, { role: 'user', content }], response_format: { type: 'json_object' } }), signal: AbortSignal.timeout(55000) });
    const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error?.message || 'OpenAI request failed'), { status: 502, type: 'provider' });
    return { data: extractJson(data.choices?.[0]?.message?.content), usage: data.usage || {} };
  }
  if (connector.provider === 'groq') {
    if (!process.env.GROQ_API_KEY) throw Object.assign(new Error('GROQ_API_KEY is not configured on the server'), { status: 503, type: 'configuration' });
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'content-type': 'application/json' }, body: json({ model: connector.model, messages: [{ role: 'system', content: 'You produce strict JSON responses.' }, { role: 'user', content: instruction }], response_format: { type: 'json_object' } }), signal: AbortSignal.timeout(55000) });
    const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Groq request failed'), { status: 502, type: 'provider' });
    return { data: extractJson(data.choices?.[0]?.message?.content), usage: data.usage || {} };
  }
  if (!process.env.GEMINI_API_KEY) throw Object.assign(new Error('GEMINI_API_KEY is not configured on the server'), { status: 503, type: 'configuration' });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(connector.model)}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  // Gemini's schema dialect does not accept JSON Schema's `additionalProperties` keyword.
  const geminiSchema = { type: schema.type, properties: schema.properties, required: schema.required };
  const parts = [{ text: instruction }, ...Object.values(input).filter(v => v?.data).map(v => ({ inline_data: { mime_type: v.mime_type, data: v.data } }))];
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json({ system_instruction: { parts: [{ text: 'You produce strict JSON responses.' }] }, contents: [{ role: 'user', parts }], generationConfig: { responseMimeType: 'application/json', responseSchema: geminiSchema } }), signal: AbortSignal.timeout(55000) });
  const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error?.message || 'Gemini request failed'), { status: 502, type: 'provider' });
  return { data: extractJson(data.candidates?.[0]?.content?.parts?.[0]?.text), usage: { input_tokens: data.usageMetadata?.promptTokenCount, output_tokens: data.usageMetadata?.candidatesTokenCount, total_tokens: data.usageMetadata?.totalTokenCount } };
}
function logRequest(connector, outcome) {
  db.prepare('INSERT INTO request_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), connector.id, outcome.success ? 1 : 0, outcome.status, connector.provider, connector.model, outcome.duration, outcome.usage?.prompt_tokens ?? outcome.usage?.input_tokens ?? null, outcome.usage?.completion_tokens ?? outcome.usage?.output_tokens ?? null, outcome.usage?.total_tokens ?? null, null, outcome.type || null, outcome.error || null, now());
}
async function invoke(connector, input) {
  const started = Date.now();
  try { input = normalizeInput(parse(connector.input_schema, []), input); validateInput(parse(connector.input_schema, []), input); const result = await askProvider(connector, input); const duration = Date.now() - started; logRequest(connector, { success: true, status: 200, duration, usage: result.usage }); return { success: true, data: result.data, error: null, meta: { response_time_ms: duration, provider: connector.provider, model: connector.model, usage: result.usage } }; }
  catch (error) { const duration = Date.now() - started; const status = error.status || (error.name === 'TimeoutError' ? 504 : 500); logRequest(connector, { success: false, status, duration, type: error.type || error.name, error: error.message }); throw Object.assign(error, { status }); }
}
function docs(connector) {
  const inputs = parse(connector.input_schema, []);
  const base = process.env.PUBLIC_URL || `http://localhost:${PORT}`; const example = Object.fromEntries(inputs.filter(i => !['image','file'].includes(i.type)).map(i => [i.name, i.example || 'value']));
  const hasFiles = inputs.some(i => ['image','file'].includes(i.type));
  return { name: connector.name, purpose: connector.description, endpoint: { method: 'POST', url: `/v1/${connector.slug}` }, authentication: connector.auth_mode === 'api_key' ? 'Authorization: Bearer <connector API key> or x-api-key header' : 'None', provider: connector.provider, model: connector.model, request_fields: inputs, response: { success: true, data: parse(connector.output_schema, {}), error: null }, errors: { 400: 'Invalid or missing input', 401: 'Invalid API key', 404: 'Connector disabled or not found', 502: 'Provider request failed' }, curl: hasFiles ? `curl -X POST ${base}/v1/${connector.slug} -H "Authorization: Bearer YOUR_CONNECTOR_KEY" -F "${inputs.find(i => ['image','file'].includes(i.type)).name}=@./sample.jpg"` : `curl -X POST ${base}/v1/${connector.slug} -H "Authorization: Bearer YOUR_CONNECTOR_KEY" -H "Content-Type: application/json" -d '${json(example)}'` };
}
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function docsPage(connector) { const d = docs(connector); return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(d.name)} API docs</title><style>body{font:16px system-ui;margin:0;background:#07111f;color:#edf4ff;line-height:1.5}main{max-width:850px;margin:auto;padding:48px 24px}code,pre{background:#0d1b2d;border:1px solid #233650;border-radius:8px;padding:12px;overflow:auto;display:block}h1{margin-bottom:4px}h2{margin-top:32px;color:#55e6a5}table{width:100%;border-collapse:collapse}td,th{padding:10px;border-bottom:1px solid #233650;text-align:left}</style></head><body><main><p>UNIVERSAL AI API HUB</p><h1>${escapeHtml(d.name)}</h1><p>${escapeHtml(d.purpose)}</p><h2>Endpoint</h2><pre>POST ${escapeHtml(d.endpoint.url)}\n${escapeHtml(d.authentication)}</pre><h2>Request fields</h2><table><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr>${d.request_fields.map(f => `<tr><td>${escapeHtml(f.name)}</td><td>${escapeHtml(f.type)}</td><td>${f.required ? 'Yes' : 'No'}</td><td>${escapeHtml(f.description || '')}</td></tr>`).join('')}</table><h2>Example request</h2><pre>${escapeHtml(d.curl)}</pre><h2>Successful response</h2><pre>${escapeHtml(json(d.response))}</pre><h2>Error responses</h2><pre>${escapeHtml(json(d.errors))}</pre><p>Provider: ${escapeHtml(d.provider)} · Model: ${escapeHtml(d.model)} · <a style="color:#55e6a5" href="/docs/${escapeHtml(connector.slug)}.json">JSON documentation</a></p></main></body></html>`; }
async function serveStatic(res, file, type) { try { res.writeHead(200, { 'content-type': type }); res.end(await readFile(path.join(root, 'public', file))); } catch { send(res, 404, { error: 'Not found' }); } }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`); const segments = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/') return serveStatic(res, 'index.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/demo-card') return serveStatic(res, 'demo-card.html', 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/app.js') return serveStatic(res, 'app.js', 'text/javascript; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/styles.css') return serveStatic(res, 'styles.css', 'text/css; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { status: 'ok' });
    if (segments[0] === 'docs' && segments[1] && req.method === 'GET') { const slug = segments[1].replace(/\.json$/, ''); const c = db.prepare('SELECT * FROM connectors WHERE slug = ?').get(slug); if (!c) return send(res, 404, { error: 'Connector not found' }); if (segments[1].endsWith('.json')) return send(res, 200, docs(c)); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(docsPage(c)); }
    if (segments[0] === 'v1' && segments[1] && req.method === 'POST') { const c = db.prepare('SELECT * FROM connectors WHERE slug = ?').get(segments[1]); if (!c || c.status !== 'active') return send(res, 404, { success: false, data: null, error: 'Connector not found or disabled' }); const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || req.headers['x-api-key']; if (c.auth_mode === 'api_key' && (!token || hash(token) !== c.api_key_hash)) return send(res, 401, { success: false, data: null, error: 'Invalid API key' }); const result = await invoke(c, await body(req)); return send(res, 200, result); }
    if (url.pathname.startsWith('/api/')) assertAdmin(req);
    if (req.method === 'GET' && url.pathname === '/api/connectors') return send(res, 200, db.prepare(`SELECT c.*, count(l.id) AS requests FROM connectors c LEFT JOIN request_logs l ON l.connector_id=c.id GROUP BY c.id ORDER BY c.created_at DESC`).all().map(publicConnector));
    if (req.method === 'POST' && url.pathname === '/api/connectors') { const value = await body(req); validateConnector(value); const key = apiKey(); const row = { id: randomUUID(), name: value.name, slug: value.slug, description: value.description, provider: value.provider, model: value.model, instructions: value.instructions, input_schema: json(value.input_schema), output_schema: json(value.output_schema), auth_mode: value.auth_mode || 'api_key', api_key_hash: hash(key), api_key_preview: key.slice(0, 12) + '…', status: value.status || 'active', created_at: now(), updated_at: now() }; db.prepare('INSERT INTO connectors VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(...Object.values(row)); return send(res, 201, { connector: publicConnector(row), api_key: key }); }
    if (segments[0] === 'api' && segments[1] === 'connectors' && segments[2] && req.method === 'PATCH') { const old = db.prepare('SELECT * FROM connectors WHERE id = ?').get(segments[2]); if (!old) return send(res, 404, { error: 'Connector not found' }); const patch = await body(req); validateConnector(patch, true); const merged = { ...old, ...patch, input_schema: patch.input_schema === undefined ? old.input_schema : json(patch.input_schema), output_schema: patch.output_schema === undefined ? old.output_schema : json(patch.output_schema), updated_at: now() }; db.prepare('UPDATE connectors SET name=?,slug=?,description=?,provider=?,model=?,instructions=?,input_schema=?,output_schema=?,auth_mode=?,status=?,updated_at=? WHERE id=?').run(merged.name, merged.slug, merged.description, merged.provider, merged.model, merged.instructions, merged.input_schema, merged.output_schema, merged.auth_mode, merged.status, merged.updated_at, old.id); return send(res, 200, publicConnector(merged)); }
    if (segments[0] === 'api' && segments[1] === 'connectors' && segments[2] && req.method === 'DELETE') { db.prepare('DELETE FROM connectors WHERE id = ?').run(segments[2]); return send(res, 204, {}); }
    if (segments[0] === 'api' && segments[1] === 'connectors' && segments[2] && segments[3] === 'rotate-key' && req.method === 'POST') { const c = db.prepare('SELECT * FROM connectors WHERE id=?').get(segments[2]); if (!c) return send(res, 404, { error: 'Connector not found' }); const key = apiKey(); db.prepare('UPDATE connectors SET api_key_hash=?, api_key_preview=?, updated_at=? WHERE id=?').run(hash(key), key.slice(0, 12) + '…', now(), c.id); return send(res, 200, { api_key: key, message: 'Save this key now. The old key no longer works.' }); }
    if (segments[0] === 'api' && segments[1] === 'connectors' && segments[2] && segments[3] === 'test' && req.method === 'POST') { const c = db.prepare('SELECT * FROM connectors WHERE id = ?').get(segments[2]); if (!c) return send(res, 404, { error: 'Connector not found' }); return send(res, 200, await invoke(c, await body(req))); }
    if (segments[0] === 'api' && segments[1] === 'connectors' && segments[2] && segments[3] === 'stats' && req.method === 'GET') { const rows = db.prepare('SELECT * FROM request_logs WHERE connector_id=? ORDER BY created_at DESC LIMIT 25').all(segments[2]); const summary = db.prepare('SELECT count(*) AS total, sum(success) AS successful, count(*)-sum(success) AS failed, round(avg(duration_ms)) AS avg_response_ms, max(created_at) AS last_used FROM request_logs WHERE connector_id=?').get(segments[2]); return send(res, 200, { summary, logs: rows }); }
    return send(res, 404, { error: 'Route not found' });
  } catch (error) { console.error(error); return send(res, error.status || 500, { success: false, data: null, error: error.status && error.status < 500 ? error.message : 'The request could not be completed' }); }
});
server.listen(PORT, () => console.log(`Universal AI API Hub listening on http://localhost:${PORT}`));
