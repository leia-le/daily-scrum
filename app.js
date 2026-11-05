'use strict';
/* Daily Scrum — chạy hoàn toàn trên trình duyệt.
   Dữ liệu mã hóa AES-256-GCM bằng mật khẩu người dùng, lưu trong IndexedDB,
   đồng bộ (tùy chọn) vào thư mục ẩn appDataFolder trong Google Drive của chính người dùng. */

const CFG = window.DS_CONFIG || {};
const VAULT_FILE = 'daily-scrum-vault.json';
const PBKDF2_ITER = 310000;

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => Date.now();
const todayStr = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD theo giờ máy
const uid = () => crypto.randomUUID();
const arr = x => Array.isArray(x) ? x : [];

/* ---------- AI providers ---------- */
const AI = {
  openai: {
    label: 'ChatGPT (OpenAI)', canTranscribe: true, maxMB: 25,
    sttModel: 'gpt-4o-transcribe', llmModel: 'gpt-5',
    keyUrl: 'https://platform.openai.com/api-keys',
    guide: [
      'Đăng nhập platform.openai.com bằng tài khoản OpenAI của bạn.',
      'Vào Billing và nạp credit (gói ChatGPT Plus không bao gồm API).',
      'Vào API keys → Create new secret key, sao chép key bắt đầu bằng sk-.',
      'Nên đặt giới hạn chi tiêu hằng tháng trong mục Limits.',
      'Dán key vào ô bên dưới, bấm Lưu và kiểm tra kết nối.'
    ]
  },
  gemini: {
    label: 'Gemini (Google)', canTranscribe: true, maxMB: 15,
    sttModel: 'gemini-2.5-flash', llmModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey',
    guide: [
      'Mở Google AI Studio, đăng nhập bằng tài khoản Google của bạn.',
      'Bấm Create API key, chọn hoặc tạo một Google Cloud project.',
      'Với dữ liệu công việc, nên bật thanh toán (gói trả phí): ở gói miễn phí Google có thể dùng nội dung để cải thiện sản phẩm.',
      'Dán key vào ô bên dưới, bấm Lưu và kiểm tra kết nối.'
    ]
  },
  claude: {
    label: 'Claude (Anthropic)', canTranscribe: false,
    llmModel: 'claude-sonnet-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    guide: [
      'Đăng nhập console.anthropic.com bằng tài khoản Anthropic của bạn.',
      'Vào Billing và nạp credit (gói Claude Pro/Max không bao gồm API).',
      'Vào API keys → Create key, sao chép key bắt đầu bằng sk-ant-.',
      'Nên đặt giới hạn chi tiêu hằng tháng trong mục Limits.',
      'Dán key vào ô bên dưới, bấm Lưu và kiểm tra kết nối.'
    ],
    noSttNote: 'Claude chưa nhận file âm thanh qua API nên chỉ dùng được cho bước Phân tích. Hãy chọn ChatGPT hoặc Gemini cho bước Chuyển giọng nói.'
  }
};

const SYSTEM_PROMPT = `Bạn là trợ lý của PM trong tổ chức Scrum. Đầu vào là transcript tiếng Việt của một buổi Daily Scrum,
kèm Sprint Goal, danh sách thành viên và cập nhật 3 ngày gần nhất.

Nhiệm vụ:
1. Tách lời theo từng thành viên. Dựa vào lời tự xưng tên, lời gọi tên người tiếp theo và danh sách thành viên.
   Nếu không chắc ai nói, ghi confidence thấp, không đoán bừa.
2. Với mỗi người, tóm tắt ngắn: việc đã làm từ daily trước, việc làm hôm nay, vướng mắc, mã issue được nhắc.
3. Đánh giá Sprint Goal: "Đúng hướng", "Có rủi ro" hoặc "Lệch hướng", lý do 1 câu dựa trên nội dung transcript.
4. Liệt kê impediment cần người ngoài team (PM, team khác, khách hàng) xử lý.
5. Liệt kê phụ thuộc với team khác.
6. Đánh dấu tín hiệu cho từng người khi có:
   - "Kẹt N ngày": cùng một việc được báo đang làm từ 3 daily trở lên (so với cập nhật 3 ngày gần nhất).
   - "Ngoài sprint": việc không liên quan Sprint Goal.
   - "Không báo cáo": thành viên trong danh sách nhưng không nói trong transcript.
   - "Vướng mắc lặp lại": vướng mắc đã nêu ở các ngày trước.
7. Ghi điểm bất thường và việc cần làm sau daily (ai, việc gì, hạn nếu được nhắc).
8. Kiểm tra mỗi người có trả lời đủ 3 câu hỏi daily: "Hôm qua", "Hôm nay", "Vướng mắc".
   Câu "không có vướng mắc" được tính là đã trả lời. Phần nào không được đề cập thì ghi vào "missing"
   và viết 1 câu gợi ý bổ sung lịch sự, trung tính vào "reminder". Trả lời đủ thì "missing": [].

Nguyên tắc:
- Chỉ dùng thông tin có trong transcript và dữ liệu đi kèm. Không bịa số liệu, tên, hạn.
- Không nhận xét năng lực hay thái độ cá nhân. Chỉ mô tả công việc và vướng mắc.
- Giữ nguyên thuật ngữ tiếng Anh và mã issue như người nói dùng.
- Chỉ trả về đúng một đối tượng JSON theo cấu trúc dưới, không thêm chữ nào khác.

{
  "sprint_goal": { "status": "Đúng hướng | Có rủi ro | Lệch hướng", "reason": "..." },
  "members": [
    { "name": "...", "yesterday": "...", "today": "...", "blockers": "...",
      "issues": ["#123"], "signals": ["Kẹt 3 ngày"], "confidence": "cao | trung bình | thấp",
      "missing": ["Vướng mắc"], "reminder": "Nhớ nêu vướng mắc, nếu không có thì nói 'không có'." }
  ],
  "impediments": [ { "raised_by": "...", "description": "...", "needs": "...", "since": "YYYY-MM-DD" } ],
  "dependencies": [ { "on_team": "...", "item": "...", "needed_by": "..." } ],
  "anomalies": ["..."],
  "actions": [ { "owner": "...", "action": "...", "due": "..." } ]
}`;

/* ---------- Mã hóa ---------- */
function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(str) {
  const bin = atob(str), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function deriveKey(pass, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptState(state) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(state));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, session.key, data));
  return { app: 'daily-scrum', v: 1, iter: session.iter, salt: toB64(session.salt), iv: toB64(iv), ct: toB64(ct), savedAt: now() };
}
async function decryptBlob(blob, pass) {
  if (!blob || blob.app !== 'daily-scrum') throw new Error('File không phải dữ liệu Daily Scrum.');
  const salt = fromB64(blob.salt);
  const key = await deriveKey(pass, salt, blob.iter);
  let pt;
  try { pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct)); }
  catch { throw new Error('Mật khẩu không đúng.'); }
  return { state: JSON.parse(new TextDecoder().decode(pt)), key, salt, iter: blob.iter };
}

/* ---------- IndexedDB ---------- */
const idb = {
  _db: null,
  open() {
    return this._db || (this._db = new Promise((res, rej) => {
      const r = indexedDB.open('daily-scrum', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  },
  async req(mode, fn) {
    const db = await this.open();
    return new Promise((res, rej) => {
      const r = fn(db.transaction('kv', mode).objectStore('kv'));
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  get(k) { return this.req('readonly', s => s.get(k)); },
  set(k, v) { return this.req('readwrite', s => s.put(v, k)); },
  del(k) { return this.req('readwrite', s => s.delete(k)); }
};

/* ---------- Trạng thái ---------- */
let session = null; // { pass, key, salt, iter, state } — chỉ tồn tại khi đã mở khóa

const newState = () => ({
  version: 1,
  settings: { stt: 'openai', llm: 'claude', sttModel: '', llmModel: '', keys: {}, connected: {},
              syncEnabled: false, updatedAt: 0 },
  teams: {}, dailies: {}, impediments: {}
});
const S = () => session.state;
const setting = () => S().settings;
const touchSettings = () => { setting().updatedAt = now(); };
const live = col => Object.values(S()[col] || {}).filter(r => !r.deleted);
const teamsSorted = () => live('teams').sort((a, b) => a.name.localeCompare(b.name, 'vi'));
const dailiesSorted = () => live('dailies').sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));

function mergeStates(a, b) {
  const out = { version: 1 };
  out.settings = (b.settings?.updatedAt || 0) > (a.settings?.updatedAt || 0) ? b.settings : a.settings;
  for (const col of ['teams', 'dailies', 'impediments']) {
    out[col] = { ...(a[col] || {}) };
    for (const [id, r] of Object.entries(b[col] || {})) {
      if (!out[col][id] || (r.updatedAt || 0) > (out[col][id].updatedAt || 0)) out[col][id] = r;
    }
  }
  return out;
}

async function persist() {
  await idb.set('vault', await encryptState(S()));
  scheduleSync();
}

async function openSession(pass, decoded) {
  session = { pass, key: decoded.key, salt: decoded.salt, iter: decoded.iter, state: decoded.state };
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  armAutoLock();
}

async function createSession(pass, state) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pass, salt, PBKDF2_ITER);
  await openSession(pass, { key, salt, iter: PBKDF2_ITER, state });
  await idb.set('vault', await encryptState(S()));
}

function lock(msg) {
  session = null;
  drive.token = null;
  $('#unlockPass').value = '';
  setMsg('#lockMsg', msg || '');
  showScreen('lock');
}

let lockTimer = null;
function armAutoLock() {
  const reset = () => {
    clearTimeout(lockTimer);
    if (session) lockTimer = setTimeout(() => lock('Đã tự khóa sau thời gian không thao tác.'), (CFG.AUTO_LOCK_MINUTES || 30) * 60000);
  };
  ['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, reset, { passive: true }));
  reset();
}

/* ---------- Gọi AI từ trình duyệt ---------- */
async function checkRes(res, name) {
  if (res.ok) return res;
  let detail = '';
  try { detail = (await res.text()).slice(0, 300); } catch {}
  throw new Error(`${name} lỗi (mã ${res.status}). ${detail}`);
}
const claudeHeaders = key => ({
  'x-api-key': key, 'anthropic-version': '2023-06-01',
  'anthropic-dangerous-direct-browser-access': 'true', 'content-type': 'application/json'
});

async function testConnection(provider, key) {
  const url = {
    openai: 'https://api.openai.com/v1/models',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
    claude: 'https://api.anthropic.com/v1/models'
  }[provider];
  const headers = {
    openai: { Authorization: 'Bearer ' + key },
    gemini: { 'x-goog-api-key': key },
    claude: claudeHeaders(key)
  }[provider];
  let res;
  try { res = await fetch(url, { headers }); }
  catch { throw new Error('Không gọi được tới ' + AI[provider].label + '. Kiểm tra mạng.'); }
  if (!res.ok) throw new Error(`Kết nối ${AI[provider].label} thất bại (mã ${res.status}). Kiểm tra lại key hoặc số dư tài khoản.`);
}

async function transcribe(file, team) {
  const st = setting(), provider = st.stt, key = st.keys[provider];
  const model = st.sttModel || AI[provider].sttModel;
  const hint = 'Daily Scrum tiếng Việt. Thành viên: ' + team.members.join(', ') +
    '. Thuật ngữ: sprint, blocker, review, merge, deploy, staging, ticket, issue.';
  if (provider === 'gemini') {
    const data = toB64(new Uint8Array(await file.arrayBuffer()));
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [
        { text: 'Chép lời nguyên văn đoạn ghi âm, giữ đúng tiếng Việt và thuật ngữ tiếng Anh, xuống dòng khi đổi người nói, không tóm tắt, không thêm bình luận. ' + hint },
        { inline_data: { mime_type: file.type || 'audio/mp4', data } }
      ] }] })
    });
    await checkRes(res, 'Gemini chuyển giọng nói');
    const j = await res.json();
    return arr(j.candidates?.[0]?.content?.parts).map(p => p.text || '').join('');
  }
  const form = new FormData();
  form.append('file', file, file.name || 'daily.m4a');
  form.append('model', model);
  form.append('language', 'vi');
  form.append('prompt', hint);
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form
  });
  await checkRes(res, 'ChatGPT chuyển giọng nói');
  return (await res.json()).text || '';
}

async function callLLM(system, user) {
  const st = setting(), provider = st.llm, key = st.keys[provider];
  const model = st.llmModel || AI[provider].llmModel;
  if (provider === 'claude') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: claudeHeaders(key),
      body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] })
    });
    await checkRes(res, 'Claude');
    return arr((await res.json()).content).map(c => c.text || '').join('');
  }
  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    });
    await checkRes(res, 'ChatGPT');
    return (await res.json()).choices?.[0]?.message?.content || '';
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json' }
    })
  });
  await checkRes(res, 'Gemini');
  return arr((await res.json()).candidates?.[0]?.content?.parts).map(p => p.text || '').join('');
}

function parseResult(text) {
  const i = text.indexOf('{'), j = text.lastIndexOf('}');
  if (i < 0 || j < i) throw new Error('AI không trả về kết quả đúng định dạng. Thử lại hoặc đổi model.');
  const r = JSON.parse(text.slice(i, j + 1));
  return {
    sprint_goal: r.sprint_goal || { status: '', reason: '' },
    members: arr(r.members), impediments: arr(r.impediments), dependencies: arr(r.dependencies),
    anomalies: arr(r.anomalies), actions: arr(r.actions)
  };
}

function recentHistory(teamId, days) {
  const since = new Date(Date.now() - days * 864e5).toLocaleDateString('sv-SE');
  return live('dailies').filter(d => d.teamId === teamId && d.date >= since && d.date < todayStr())
    .flatMap(d => d.result.members.map(m => ({ date: d.date, member: m.name, today: m.today, blockers: m.blockers, issues: m.issues })));
}

const aiReady = () => {
  const st = setting();
  return AI[st.stt]?.canTranscribe && !!st.connected[st.stt] && !!st.connected[st.llm];
};

/* ---------- Đồng bộ Google Drive (appDataFolder) ---------- */
const drive = {
  token: null, exp: 0,
  available() { return !!(CFG.GOOGLE_CLIENT_ID && window.google?.accounts?.oauth2); },
  hasToken() { return !!this.token && Date.now() < this.exp - 60000; },
  // Gọi trong sự kiện bấm (không có await trước đó) để popup đăng nhập không bị chặn
  login() {
    return new Promise((res, rej) => {
      if (this.hasToken()) return res(this.token);
      if (!CFG.GOOGLE_CLIENT_ID) return rej(new Error('Người triển khai chưa cấu hình Google Client ID nên chưa dùng được đồng bộ.'));
      if (!this.available()) return rej(new Error('Chưa tải được Google Sign-In. Kiểm tra mạng rồi thử lại.'));
      const client = google.accounts.oauth2.initTokenClient({
        client_id: CFG.GOOGLE_CLIENT_ID,
        scope: 'https://www.googleapis.com/auth/drive.appdata',
        callback: r => {
          if (r.error) return rej(new Error('Đăng nhập Google không thành công: ' + r.error));
          this.token = r.access_token; this.exp = Date.now() + r.expires_in * 1000; res(this.token);
        },
        error_callback: e => rej(new Error('Đăng nhập Google bị hủy hoặc bị chặn popup.' + (e?.type ? ' (' + e.type + ')' : '')))
      });
      client.requestAccessToken({ prompt: '' });
    });
  },
  async api(url, opts = {}) {
    if (!this.hasToken()) throw new Error('need-login');
    const res = await fetch(url, { ...opts, headers: { Authorization: 'Bearer ' + this.token, ...(opts.headers || {}) } });
    if (res.status === 401) { this.token = null; throw new Error('need-login'); }
    return checkRes(res, 'Google Drive');
  },
  async find() {
    const q = encodeURIComponent(`name='${VAULT_FILE}'`);
    const j = await (await this.api(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`)).json();
    return j.files?.[0] || null;
  },
  async download(id) { return (await this.api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).json(); },
  async upload(blob, id) {
    const body = JSON.stringify(blob);
    if (id) {
      await this.api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`,
        { method: 'PATCH', headers: { 'content-type': 'application/json' }, body });
      return id;
    }
    const b = 'ds' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name: VAULT_FILE, parents: ['appDataFolder'] });
    const multipart = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
    const res = await this.api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
      { method: 'POST', headers: { 'content-type': 'multipart/related; boundary=' + b }, body: multipart });
    return (await res.json()).id;
  },
  async remove() { const f = await this.find(); if (f) await this.api(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE' }); }
};

let syncing = false, syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  if (!session || !setting().syncEnabled) return setSync();
  if (!drive.hasToken()) return setSync('Có thay đổi chưa đồng bộ · bấm Đồng bộ', 'warn');
  syncTimer = setTimeout(() => syncNow(), 2000);
}

async function syncNow() {
  if (!session || syncing) return;
  syncing = true;
  setSync('Đang đồng bộ...');
  try {
    const f = await drive.find();
    if (f) {
      const remote = await drive.download(f.id);
      let dec;
      try { dec = await decryptBlob(remote, session.pass); }
      catch { throw new Error('Dữ liệu trên Drive được khóa bằng mật khẩu khác. Hãy dùng đúng mật khẩu đã đặt ở thiết bị đầu tiên.'); }
      session.state = mergeStates(S(), dec.state);
    }
    if (!setting().syncEnabled) { setting().syncEnabled = true; touchSettings(); }
    const blob = await encryptState(S());
    await idb.set('vault', blob);
    await drive.upload(blob, f && f.id);
    await idb.set('syncHint', true);
    setSync('Đã đồng bộ lúc ' + new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }), 'ok');
    refreshCurrentView();
  } catch (e) {
    if (e.message === 'need-login') setSync('Cần đăng nhập Google · bấm Đồng bộ', 'warn');
    else setSync('Đồng bộ lỗi: ' + e.message, 'err');
  } finally { syncing = false; }
}

function setSync(text, kind) {
  const el = $('#syncStatus');
  if (!el) return;
  if (text == null) text = session && setting().syncEnabled ? '' : 'Chưa bật đồng bộ';
  el.textContent = text;
  el.className = 'small ' + (kind === 'err' ? 'msg err' : kind === 'warn' ? 'warn' : kind === 'ok' ? 'msg ok' : 'muted');
}

/* ---------- Giao diện chung ---------- */
const STEPS = ['Đặt mật khẩu', 'Kết nối AI', 'Thêm team', 'Phân tích'];
function stepperHtml(cur) {
  return `<ol class="stepper" aria-label="Bước ${cur} trên ${STEPS.length}">${STEPS.map((s, i) =>
    `<li class="${i + 1 < cur ? 'done' : i + 1 === cur ? 'cur' : ''}"><span>${i + 1 < cur ? '✓' : i + 1}</span>${s}</li>`).join('')}</ol>`;
}
function showScreen(name) {
  $$('.screen').forEach(s => s.classList.toggle('on', s.id === 'screen-' + name));
  $$('[data-stepper]').forEach(el => { el.innerHTML = stepperHtml(Number(el.dataset.stepper)); });
  window.scrollTo(0, 0);
}
function setMsg(sel, text, kind) {
  const el = $(sel);
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}
let currentView = 'overview', reportReturn = 'history';
function showView(name) {
  currentView = name;
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + name));
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.view === name));
  refreshCurrentView();
}
function refreshCurrentView() {
  if (!session || !$('#screen-main').classList.contains('on')) return;
  ({ overview: renderOverview, analyze: renderAnalyze, history: renderHistory, teams: renderTeams,
     settings: renderSettings, help: renderHelp, report: () => {} })[currentView]?.();
}
function enterApp() {
  if (!aiReady()) return openOnboard();
  showScreen('main');
  setSync();
  if (!teamsSorted().length) { showView('teams'); return; }          // bước 3
  if (!live('dailies').length) { showView('analyze'); return; }      // bước 4
  showView('overview');
}

/* ---------- Kết nối AI ---------- */
function openOnboard() {
  const st = setting();
  const opts = Object.entries(AI).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#sttSel').innerHTML = opts; $('#llmSel').innerHTML = opts;
  $('#sttSel').value = st.stt; $('#llmSel').value = st.llm;
  $('#sttModel').value = st.sttModel || AI[st.stt].sttModel || '';
  $('#llmModel').value = st.llmModel || AI[st.llm].llmModel || '';
  const changing = aiReady(); // đã kết nối trước đó, đang vào từ Cài đặt để đổi
  $('#cancelOnboard').style.display = changing ? '' : 'none';
  $('#onboardStepper').dataset.stepper = '2';
  $('#onboardStepper').style.display = changing ? 'none' : '';
  $('#doneBtn').textContent = changing ? 'Lưu thay đổi' : 'Tiếp tục: thêm team';
  showScreen('onboard');
  renderGuides();
}
function renderGuides() {
  const st = setting(), stt = $('#sttSel').value, llm = $('#llmSel').value, sttP = AI[stt];
  $('#sttNote').textContent = sttP.canTranscribe ? '' : sttP.noSttNote;
  const need = [...new Set([sttP.canTranscribe ? stt : null, llm].filter(Boolean))];
  $('#guides').innerHTML = need.map(k => {
    const p = AI[k];
    const state = st.connected[k] ? '<span class="badge good">đã kết nối</span>'
      : st.keys[k] ? '<span class="badge warn">có key, chưa kiểm tra</span>' : '<span class="badge">chưa kết nối</span>';
    return `<div class="card">
      <h4>Kết nối ${esc(p.label)} ${state}</h4>
      <ol>${p.guide.map(g => `<li>${esc(g)}</li>`).join('')}</ol>
      <p><a href="${p.keyUrl}" target="_blank" rel="noopener noreferrer">Mở trang lấy key ${esc(p.label)}</a></p>
      <input type="password" autocomplete="off" data-key="${k}" placeholder="${st.keys[k] ? 'Để trống nếu không đổi' : 'Dán key vào đây'}">
      <button data-action="test-ai" data-provider="${k}">Lưu và kiểm tra kết nối</button>
      <p class="msg" id="aimsg-${k}"></p>
    </div>`;
  }).join('');
  updateDone();
}
function updateDone() {
  const st = setting(), stt = $('#sttSel').value, llm = $('#llmSel').value;
  const ok = AI[stt].canTranscribe && st.connected[stt] && st.connected[llm];
  $('#doneBtn').disabled = !ok;
  const waiting = [...new Set([stt, llm])].filter(k => AI[k].canTranscribe !== false || k === llm).filter(k => !st.connected[k]);
  $('#doneHint').textContent = !AI[stt].canTranscribe ? 'Hãy chọn ChatGPT hoặc Gemini cho việc chuyển giọng nói.'
    : ok ? 'Đã kết nối xong. Bấm nút bên dưới để tiếp tục.'
    : 'Còn chờ kết nối: ' + waiting.map(k => AI[k].label).join(', ') + '.';
}
function collectOnboard() {
  const st = setting();
  const stt = $('#sttSel').value, llm = $('#llmSel').value;
  if (stt !== st.stt || llm !== st.llm || $('#sttModel').value !== st.sttModel || $('#llmModel').value !== st.llmModel) touchSettings();
  st.stt = stt; st.llm = llm;
  st.sttModel = $('#sttModel').value.trim(); st.llmModel = $('#llmModel').value.trim();
  $$('[data-key]').forEach(i => {
    const v = i.value.trim();
    if (v && v !== st.keys[i.dataset.key]) { st.keys[i.dataset.key] = v; st.connected[i.dataset.key] = false; touchSettings(); }
  });
}

/* ---------- Report ---------- */
function goalBadge(status) {
  const cls = /lệch/i.test(status) ? 'bad' : /rủi ro/i.test(status) ? 'warn' : status ? 'good' : '';
  return `<span class="badge ${cls}">${esc(status || 'Chưa rõ')}</span>`;
}
function impedimentId(d, i) { return d.id + ':' + i; }
function impStatus(id) { return S().impediments[id]?.status || 'Mở'; }

function renderReportHtml(d) {
  const r = d.result, list = items => items.length ? '<ul>' + items.map(x => `<li>${x}</li>`).join('') + '</ul>' : '<p class="muted">Không có.</p>';
  const incomplete = r.members.filter(m => arr(m.missing).length);
  return `<h2>Daily ${esc(d.teamName)} · ${esc(d.date)}</h2>
  <p>Sprint Goal: ${goalBadge(r.sprint_goal.status)} ${esc(r.sprint_goal.reason)}</p>
  <h3>Theo thành viên</h3>
  <div class="table-wrap"><table><tr><th>Thành viên</th><th>Hôm qua</th><th>Hôm nay</th><th>Vướng mắc</th><th>Tín hiệu</th></tr>
  ${r.members.map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.yesterday)}</td><td>${esc(m.today)}</td><td>${esc(m.blockers)}</td><td>${esc(arr(m.signals).join('; '))}</td></tr>`).join('')}
  </table></div>
  <h3>Impediment cần PM xử lý</h3>${list(r.impediments.map((i, n) => `${esc(i.raised_by)}: ${esc(i.description)} → cần ${esc(i.needs)} <span class="badge">${esc(impStatus(impedimentId(d, n)))}</span>`))}
  <h3>Phụ thuộc với team khác</h3>${list(r.dependencies.map(x => `${esc(x.on_team)}: ${esc(x.item)} (hạn ${esc(x.needed_by)})`))}
  <h3>Điểm bất thường</h3>${list(r.anomalies.map(esc))}
  <h3>Nhắc nhở đủ 3 câu hỏi daily</h3>${incomplete.length
    ? list(incomplete.map(m => `${esc(m.name)}: thiếu ${esc(arr(m.missing).join(', '))} — ${esc(m.reminder)}`))
    : '<p class="muted">Tất cả thành viên đã trả lời đủ 3 câu hỏi.</p>'}
  <h3>Việc cần làm sau daily</h3>${list(r.actions.map(a => `${esc(a.owner)}: ${esc(a.action)}${a.due ? ' (hạn ' + esc(a.due) + ')' : ''}`))}
  <div class="row">
    <button class="ghost" data-action="copy-report" data-id="${d.id}">Sao chép report</button>
    <button class="ghost" data-action="download-transcript" data-id="${d.id}">Tải bản raw transcript</button>
    <button class="ghost" data-action="toggle-transcript" data-id="${d.id}">Xem transcript</button>
  </div>
  <pre class="transcript" id="tr-${d.id}" hidden>${esc(d.transcript)}</pre>`;
}

function reportText(d) {
  const r = d.result, L = [];
  L.push(`DAILY ${d.teamName} · ${d.date}`, `Sprint Goal: ${r.sprint_goal.status} — ${r.sprint_goal.reason}`, '', 'THEO THÀNH VIÊN');
  r.members.forEach(m => L.push(`- ${m.name}: Hôm qua: ${m.yesterday || '-'} | Hôm nay: ${m.today || '-'} | Vướng mắc: ${m.blockers || '-'}${arr(m.signals).length ? ' | Tín hiệu: ' + m.signals.join('; ') : ''}`));
  const sec = (t, items) => { L.push('', t); (items.length ? items : ['Không có.']).forEach(x => L.push('- ' + x)); };
  sec('IMPEDIMENT', r.impediments.map(i => `${i.raised_by}: ${i.description} → cần ${i.needs}`));
  sec('PHỤ THUỘC', r.dependencies.map(x => `${x.on_team}: ${x.item} (hạn ${x.needed_by})`));
  sec('BẤT THƯỜNG', r.anomalies);
  sec('NHẮC NHỞ 3 CÂU HỎI', r.members.filter(m => arr(m.missing).length).map(m => `${m.name}: thiếu ${m.missing.join(', ')} — ${m.reminder || ''}`));
  sec('VIỆC CẦN LÀM', r.actions.map(a => `${a.owner}: ${a.action}${a.due ? ' (hạn ' + a.due + ')' : ''}`));
  return L.join('\n');
}

/* ---------- Các màn hình chính ---------- */
function repeatedIncomplete() {
  const out = [];
  for (const t of teamsSorted()) {
    const last3 = dailiesSorted().filter(d => d.teamId === t.id).slice(0, 3);
    if (last3.length < 3) continue;
    for (const name of t.members) {
      const key = name.split('(')[0].trim().toLowerCase(); // "Nam (anh Nam)" → "nam"
      const misses = last3.map(d => d.result.members.find(m => (m.name || '').toLowerCase().includes(key)));
      if (misses.every(m => m && arr(m.missing).length)) out.push(`${t.name} · ${name}: thiếu ${arr(misses[0].missing).join(', ')} (3 daily liên tiếp)`);
    }
  }
  return out;
}

function renderOverview() {
  const today = todayStr();
  const todays = dailiesSorted().filter(d => d.date === today);
  const openImps = dailiesSorted().flatMap(d => d.result.impediments.map((i, n) => ({ d, i, id: impedimentId(d, n) })))
    .filter(x => impStatus(x.id) === 'Mở');
  const flags = repeatedIncomplete();
  $('#view-overview').innerHTML = `
    ${checklistHtml()}
    <h2>Hôm nay · ${esc(today)}</h2>
    <p class="muted small">Tổng hợp các buổi daily đã phân tích hôm nay. Bấm "Xem" để mở report chi tiết.</p>
    ${todays.length ? `<div class="table-wrap"><table><tr><th>Team</th><th>Sprint Goal</th><th>Lý do</th><th>Impediment</th><th></th></tr>
      ${todays.map(d => `<tr><td>${esc(d.teamName)}</td><td>${goalBadge(d.result.sprint_goal.status)}</td><td>${esc(d.result.sprint_goal.reason)}</td>
        <td>${d.result.impediments.length}</td><td><a href="#" data-action="open-report" data-id="${d.id}">Xem</a></td></tr>`).join('')}
      </table></div>` : `<div class="empty"><p class="muted">Hôm nay chưa phân tích buổi daily nào.</p>
        <button data-action="goto" data-view="analyze">Phân tích buổi daily</button></div>`}
    <h2>Impediment đang mở (${openImps.length})</h2>
    <p class="muted small">Vướng mắc cần bạn hoặc người ngoài team gỡ. Bấm "Đã xử lý" khi đã gỡ xong.</p>
    ${openImps.length ? openImps.map(x => `<div class="list-item"><div><b>${esc(x.d.teamName)}</b> · ${esc(x.d.date)} · ${esc(x.i.raised_by)}: ${esc(x.i.description)}
      <div class="muted small">Cần: ${esc(x.i.needs)}</div></div>
      <button class="ghost sm" data-action="close-imp" data-id="${esc(x.id)}">Đã xử lý</button></div>`).join('')
      : '<p class="muted">Không có impediment nào đang mở.</p>'}
    <h2>Cần trao đổi với Scrum Master</h2>
    <p class="muted small">Thành viên 3 buổi daily liên tiếp chưa trả lời đủ 3 câu hỏi.</p>
    ${flags.length ? '<ul>' + flags.map(f => `<li>${esc(f)}</li>`).join('') + '</ul>' : '<p class="muted">Không có thành viên nào thiếu nội dung 3 daily liên tiếp.</p>'}`;
}

function renderAnalyze() {
  const teams = teamsSorted();
  const sel = $('#teamSel'), prev = sel.value;
  sel.innerHTML = teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  if (teams.some(t => t.id === prev)) sel.value = prev;
  $('#goBtn').disabled = !teams.length;
  $('#analyzeIntro').innerHTML = !teams.length
    ? `<div class="empty"><p>Bạn cần thêm ít nhất 1 team trước khi phân tích.</p><button data-action="goto" data-view="teams">Thêm team</button></div>`
    : !live('dailies').length
      ? `${stepperHtml(4)}<div class="callout"><b>Bước cuối:</b> phân tích buổi daily đầu tiên. Chưa có file thật? Bạn có thể tự ghi âm 1 phút giả làm 2–3 thành viên báo cáo để thử.</div>`
      : '';
}

function renderHistory() {
  const items = dailiesSorted();
  $('#view-history').innerHTML = `<h2>Lịch sử (${items.length})</h2>
    <p class="muted small">Tất cả report đã phân tích, mới nhất ở trên. Bấm vào một dòng để xem report, transcript và sao chép gửi đi.</p>` + (items.length
    ? items.map(d => `<div class="list-item"><a href="#" data-action="open-report" data-id="${d.id}">${esc(d.date)} · <b>${esc(d.teamName)}</b></a>
        <span>${goalBadge(d.result.sprint_goal.status)} <button class="danger sm" data-action="delete-daily" data-id="${d.id}">Xóa</button></span></div>`).join('')
    : `<div class="empty"><p class="muted">Chưa có report nào.</p><button data-action="goto" data-view="analyze">Phân tích buổi daily đầu tiên</button></div>`);
}

// Danh sách việc cần làm khi mới dùng; ẩn khi đã xong hoặc người dùng tắt
function checklistHtml() {
  const st = setting();
  if (st.hideChecklist) return '';
  const items = [
    { done: aiReady(), text: 'Kết nối AI', view: null, action: 'open-onboard', btn: 'Kết nối' },
    { done: teamsSorted().length > 0, text: 'Thêm team đầu tiên', view: 'teams', btn: 'Thêm team' },
    { done: live('dailies').length > 0, text: 'Phân tích buổi daily đầu tiên', view: 'analyze', btn: 'Phân tích' },
    ...(CFG.GOOGLE_CLIENT_ID ? [{ done: !!st.syncEnabled, text: 'Bật đồng bộ Google Drive để dùng trên nhiều thiết bị (không bắt buộc)', view: 'settings', btn: 'Cài đặt' }] : []),
    { done: !!st.backedUp, text: 'Tải file sao lưu, phòng khi trình duyệt bị xóa dữ liệu', view: 'settings', btn: 'Sao lưu' }
  ];
  const left = items.filter(i => !i.done).length;
  if (!left) return '';
  return `<div class="card"><h4>Bắt đầu với Daily Scrum · còn ${left} việc</h4>
    <ul class="checklist">${items.map(i => `<li class="${i.done ? 'done' : ''}"><span class="tick">${i.done ? '✓' : ''}</span>
      <span class="txt">${esc(i.text)}</span>
      ${i.done ? '' : i.action ? `<button class="ghost sm" data-action="${i.action}">${i.btn}</button>`
        : `<button class="ghost sm" data-action="goto" data-view="${i.view}">${i.btn}</button>`}</li>`).join('')}</ul>
    <p class="small"><a href="#" data-action="hide-checklist">Ẩn danh sách này</a></p></div>`;
}

function renderHelp() {
  $('#view-help').innerHTML = `
    <h2>Hướng dẫn sử dụng</h2>
    <div class="card"><h4>Dùng hằng ngày, 3 bước</h4>
      <ol class="tight">
        <li>Sau buổi daily, vào <b>Phân tích</b>: chọn team, chọn file ghi âm, bấm Phân tích.</li>
        <li>Đọc report: Sprint Goal, vướng mắc từng người, impediment, ai thiếu nội dung 3 câu hỏi.</li>
        <li>Vào <b>Hôm nay</b> để xem tổng hợp mọi team và gỡ các impediment đang mở.</li>
      </ol>
      <div class="row"><button data-action="goto" data-view="analyze">Phân tích ngay</button><button class="ghost" data-action="goto" data-view="overview">Xem Hôm nay</button></div>
    </div>
    <h3>Câu hỏi thường gặp</h3>
    <div class="faq">
      <details><summary>Mật khẩu để làm gì? Quên thì sao?</summary>
        <p>App không có tài khoản hay máy chủ. API key và nội dung daily lưu trên máy bạn và được mã hóa bằng mật khẩu này. Quên mật khẩu là mất dữ liệu, không ai khôi phục được. Hãy lưu mật khẩu vào trình quản lý mật khẩu.</p></details>
      <details><summary>Lấy API key ở đâu? Có tốn tiền không?</summary>
        <p>Vào Cài đặt → Đổi kết nối AI: app có hướng dẫn và link lấy key cho ChatGPT, Gemini, Claude. Gói ChatGPT Plus hay Claude Pro không bao gồm API, cần nạp credit riêng trên trang API. Nên đặt giới hạn chi tiêu hằng tháng cho key.</p></details>
      <details><summary>Vì sao Claude không chép lời được?</summary>
        <p>Claude hiện chưa nhận file âm thanh qua API. Hãy dùng ChatGPT hoặc Gemini để chép lời, Claude vẫn dùng được cho bước phân tích.</p></details>
      <details><summary>App tách sai người, sai tên. Làm sao cho đúng?</summary>
        <ul class="tight"><li>Thống nhất với team: mỗi người tự xưng tên khi đến lượt.</li>
          <li>Trong thẻ Team, ghi tên thành viên đúng cách gọi thật; có thể thêm tên gọi khác trong ngoặc, ví dụ "Nam (anh Nam, Nam BE)".</li>
          <li>Ghi âm gần người nói, tránh phòng ồn.</li></ul></details>
      <details><summary>Có nhiều team, nhập từng cái mất thời gian?</summary>
        <p>Vào thẻ Team → "Nhập từ file Excel/CSV". Tải file mẫu, điền mỗi dòng một team, rồi chọn file (.xlsx hoặc .csv), hoặc dán thẳng vùng dữ liệu từ Excel/Google Sheets. App cho xem trước, báo lỗi từng dòng trước khi nhập. Team trùng tên sẽ được cập nhật, nên khi sang sprint mới bạn có thể tải danh sách team về, sửa ngày và Sprint Goal, rồi nhập lại.</p></details>
      <details><summary>Dùng trên điện thoại hoặc máy khác thế nào?</summary>
        <p>Cài đặt → Đồng bộ: bật đồng bộ Google Drive. Trên máy kia mở app, chọn "Tôi đã dùng app trên thiết bị khác", nhập đúng mật khẩu. Hoặc dùng file sao lưu.</p></details>
      <details><summary>File ghi âm có bị lưu lại không?</summary>
        <p>Không. File chỉ được gửi tới AI chép lời bạn chọn rồi bỏ đi. App chỉ giữ transcript và report, đã mã hóa.</p></details>
      <details><summary>File quá lớn thì sao?</summary>
        <p>ChatGPT nhận tối đa 25 MB, Gemini khoảng 15 MB. Một buổi daily 15 phút thường chỉ vài MB. Nếu lớn hơn, hãy xuất lại file dạng mp3 hoặc cắt ngắn.</p></details>
      <details><summary>Có nên xin phép team trước khi ghi âm?</summary>
        <p>Có. Hãy nói rõ mục đích là giúp PM gỡ vướng, không dùng để đánh giá cá nhân, và cho team xem report của chính họ.</p></details>
    </div>
    <p><a href="#" data-action="show-privacy">Dữ liệu của bạn được xử lý thế nào</a></p>`;
}

function openReport(id, from) {
  const d = S().dailies[id];
  if (!d) return;
  reportReturn = from || currentView;
  $('#view-report').innerHTML = `<button class="ghost sm" data-action="back-report">← Quay lại</button>` + renderReportHtml(d);
  showView('report');
}

let editingTeam = null;
function renderTeams() {
  const teams = teamsSorted(), t = editingTeam ? S().teams[editingTeam] : null;
  const intro = !teams.length ? `${stepperHtml(3)}
    <div class="callout"><b>Thêm team bạn muốn theo dõi.</b> App dùng danh sách thành viên để biết ai đang nói, và dùng Sprint Goal để đánh giá team có đi đúng hướng không. Bạn có thể nhập từng team, hoặc nhập nhiều team một lúc từ file Excel/CSV.</div>` : '';
  const mode = t ? 'manual' : teamMode;
  $('#view-teams').innerHTML = `
    ${intro}
    <h2>Team của bạn</h2>
    ${teams.length ? `<p class="muted small">Bạn có thể tải danh sách team về file Excel/CSV để sửa hàng loạt (ví dụ khi sang sprint mới), rồi nhập lại. Team trùng tên sẽ được cập nhật.
      <a href="#" data-action="export-teams">Tải danh sách team (.csv)</a></p>` : ''}
    ${teams.length ? teams.map(x => `<div class="list-item"><div><b>${esc(x.name)}</b> · ${esc(x.project)}
        <div class="muted small">${esc(x.members.join(', '))}</div>
        <div class="muted small">Sprint ${esc(x.sprintStart || '?')} → ${esc(x.sprintEnd || '?')} · ${esc(x.sprintGoal)}</div></div>
        <span><button class="ghost sm" data-action="edit-team" data-id="${x.id}">Sửa</button>
        <button class="danger sm" data-action="delete-team" data-id="${x.id}">Xóa</button></span></div>`).join('')
      : '<p class="muted">Chưa có team nào. Chọn một cách thêm team bên dưới.</p>'}
    ${t ? '' : `<div class="seg" role="tablist" aria-label="Cách thêm team">
      <button role="tab" class="${mode === 'manual' ? 'on' : ''}" aria-selected="${mode === 'manual'}" data-action="team-mode" data-mode="manual">Thêm thủ công</button>
      <button role="tab" class="${mode === 'import' ? 'on' : ''}" aria-selected="${mode === 'import'}" data-action="team-mode" data-mode="import">Nhập từ file Excel/CSV</button>
    </div>`}
    ${mode === 'import' ? importCardHtml() : `<div class="card">
      <h4>${t ? 'Sửa team' : 'Thêm team'}</h4>
      <label for="tName">Tên team <span class="muted">· bắt buộc</span></label>
      <input id="tName" placeholder="Ví dụ: Invoice A" value="${esc(t?.name || '')}">
      <label for="tProject">Project</label>
      <input id="tProject" placeholder="Ví dụ: Sapo Invoice" value="${esc(t?.project || '')}">
      <label for="tMembers">Thành viên <span class="muted">· bắt buộc, cách nhau dấu phẩy</span></label>
      <textarea id="tMembers" rows="2" placeholder="Ví dụ: Nam (anh Nam, Nam BE), Lan, Hùng">${esc(t ? t.members.join(', ') : '')}</textarea>
      <p class="muted small">Ghi tên đúng cách mọi người gọi nhau trong buổi daily. Tên gọi khác để trong ngoặc giúp app nhận đúng người.</p>
      <div class="row">
        <div><label for="tStart">Bắt đầu sprint</label><input id="tStart" type="date" value="${esc(t?.sprintStart || '')}"></div>
        <div><label for="tEnd">Kết thúc sprint</label><input id="tEnd" type="date" value="${esc(t?.sprintEnd || '')}"></div>
      </div>
      <label for="tGoal">Sprint Goal</label>
      <textarea id="tGoal" rows="2" placeholder="Ví dụ: Ra mắt thanh toán QR cho 100% merchant thử nghiệm">${esc(t?.sprintGoal || '')}</textarea>
      <p class="muted small">Có Sprint Goal thì app mới đánh giá được team đang đúng hướng, có rủi ro hay lệch hướng. Nhớ cập nhật mỗi khi sang sprint mới.</p>
      <button data-action="save-team">${t ? 'Lưu thay đổi' : 'Thêm team'}</button>
      ${t ? '<button class="ghost" data-action="cancel-team">Hủy</button>' : ''}
      <p class="msg" id="teamMsg"></p>
    </div>`}`;
  if (mode === 'import' && importPreview) renderImportPreview();
}

/* ---------- Nhập team từ file ---------- */
let teamMode = 'manual', importPreview = null;
const TEAM_COLUMNS = [
  { key: 'name', label: 'Team', aliases: ['team', 'ten team', 'tên team', 'team name', 'nhom', 'nhóm'] },
  { key: 'project', label: 'Project', aliases: ['project', 'du an', 'dự án', 'san pham', 'sản phẩm'] },
  { key: 'members', label: 'Thành viên', aliases: ['thanh vien', 'thành viên', 'members', 'member', 'nhan su', 'nhân sự'] },
  { key: 'sprintStart', label: 'Bắt đầu sprint', aliases: ['bat dau sprint', 'bắt đầu sprint', 'bat dau', 'bắt đầu', 'sprint start', 'start', 'start date', 'ngay bat dau', 'ngày bắt đầu'] },
  { key: 'sprintEnd', label: 'Kết thúc sprint', aliases: ['ket thuc sprint', 'kết thúc sprint', 'ket thuc', 'kết thúc', 'sprint end', 'end', 'end date', 'ngay ket thuc', 'ngày kết thúc'] },
  { key: 'sprintGoal', label: 'Sprint Goal', aliases: ['sprint goal', 'goal', 'muc tieu', 'mục tiêu', 'muc tieu sprint', 'mục tiêu sprint'] }
];
const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().trim();

// Tách danh sách thành viên theo dấu phẩy, chấm phẩy hoặc xuống dòng, KHÔNG tách bên trong ngoặc: "Nam (anh Nam, Nam BE), Lan"
function splitMembers(text) {
  const out = []; let cur = '', depth = 0;
  for (const ch of String(text ?? '')) {
    if (ch === '(') depth++;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (!depth && (ch === ',' || ch === ';' || ch === '\n')) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

// Ngày: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, số ngày kiểu Excel, hoặc đối tượng Date
function parseDate(v) {
  if (v == null || v === '') return { value: '' };
  const pad = n => String(n).padStart(2, '0');
  const ymd = (y, m, d) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? { value: `${y}-${pad(m)}-${pad(d)}` } : { error: true };
  };
  if (v instanceof Date && !isNaN(v)) return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === 'number' && v > 20000 && v < 80000) { // số ngày của Excel
    const d = new Date(Date.UTC(1899, 11, 30) + v * 864e5);
    return ymd(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return ymd(+m[3], +m[2], +m[1]); // định dạng Việt Nam: ngày/tháng/năm
  return { error: true };
}

// Đọc CSV/TSV (có dấu ngoặc kép, xuống dòng trong ô); tự nhận dấu phân cách
function parseDelimited(text) {
  text = text.replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = ['\t', ';', ','].map(d => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => String(x).trim() !== ''));
}

let xlsxLoading = null;
function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  return xlsxLoading || (xlsxLoading = new Promise((res, rej) => {
    // SheetJS 0.18.5 (Apache 2.0) từ jsDelivr, khóa bằng SRI: file bị sửa dù 1 byte thì trình duyệt từ chối chạy
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.mini.min.js';
    s.integrity = 'sha384-6fBkVFQw1YKyYpZpKf7bguegzeJqso45fTePEWGNuVaGy70fxEhICA/yswrPjW4+';
    s.crossOrigin = 'anonymous';
    s.referrerPolicy = 'no-referrer';
    s.onload = () => res();
    s.onerror = () => { xlsxLoading = null; rej(new Error('Không tải được bộ đọc Excel. Kiểm tra mạng, hoặc lưu file dạng CSV rồi nhập lại.')); };
    document.head.appendChild(s);
  }));
}

async function readTeamFile(file) {
  const name = file.name.toLowerCase();
  if (file.size > 2 * 1024 * 1024) throw new Error('File lớn hơn 2 MB. Danh sách team thường chỉ vài KB, hãy kiểm tra lại file.');
  if (/\.(xlsx|xlsm|xlsb|ods)$/.test(name)) {
    await loadXlsx();
    // cellDates: false → ô ngày giữ dạng số ngày của Excel; parseDate tự đổi theo UTC nên không bị lệch múi giờ
    const wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: false });
    const ws = wb.Sheets[wb.SheetNames[0]];
    return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }).filter(r => r.some(x => String(x).trim() !== ''));
  }
  if (/\.xls$/.test(name)) throw new Error('File .xls (Excel đời cũ) chưa được hỗ trợ. Trong Excel chọn Lưu thành → .xlsx hoặc .csv rồi nhập lại.');
  return parseDelimited(await file.text());
}

// Đối chiếu tiêu đề cột, kiểm tra từng dòng, xác định team mới hay cập nhật
function buildImportPreview(rows) {
  if (rows.length < 2) throw new Error('File cần có dòng tiêu đề và ít nhất 1 dòng team.');
  const header = rows[0].map(fold);
  const colIdx = {};
  TEAM_COLUMNS.forEach(c => { const i = header.findIndex(h => c.aliases.map(fold).includes(h)); if (i >= 0) colIdx[c.key] = i; });
  const missing = ['name', 'members'].filter(k => colIdx[k] == null).map(k => TEAM_COLUMNS.find(c => c.key === k).label);
  if (missing.length) throw new Error(`Không tìm thấy cột bắt buộc: ${missing.join(', ')}. Hãy dùng file mẫu, hoặc đặt tên cột đúng như file mẫu.`);
  const existing = {}; teamsSorted().forEach(t => { existing[fold(t.name)] = t; });
  const seen = {};
  const items = rows.slice(1).map((r, i) => {
    const get = k => colIdx[k] == null ? '' : r[colIdx[k]];
    const errors = [], warnings = [];
    const name = String(get('name') ?? '').trim();
    const members = splitMembers(get('members'));
    const start = parseDate(get('sprintStart')), end = parseDate(get('sprintEnd'));
    if (!name) errors.push('thiếu tên team');
    if (!members.length) errors.push('thiếu thành viên');
    if (start.error) errors.push('ngày bắt đầu không đọc được (dùng dạng 2026-11-03 hoặc 03/11/2026)');
    if (end.error) errors.push('ngày kết thúc không đọc được');
    if (start.value && end.value && start.value > end.value) errors.push('ngày bắt đầu sau ngày kết thúc');
    if (name && seen[fold(name)]) errors.push(`trùng tên với dòng ${seen[fold(name)]}`);
    if (name) seen[fold(name)] = i + 2;
    const goal = String(get('sprintGoal') ?? '').trim();
    if (!goal && !errors.length) warnings.push('chưa có Sprint Goal');
    const match = name ? existing[fold(name)] : null;
    return { line: i + 2, name, project: String(get('project') ?? '').trim(), members,
      sprintStart: start.value || '', sprintEnd: end.value || '', sprintGoal: goal,
      errors, warnings, existingId: match ? match.id : null };
  });
  return { items, columns: Object.keys(colIdx) };
}

function importCardHtml() {
  return `<div class="card">
    <h4>Nhập nhiều team từ file</h4>
    <ol class="tight">
      <li>Tải file mẫu, mở bằng Excel, Google Sheets hoặc Numbers.</li>
      <li>Mỗi dòng là một team. Cột <b>Team</b> và <b>Thành viên</b> bắt buộc; thành viên cách nhau dấu phẩy, tên gọi khác để trong ngoặc.</li>
      <li>Ngày ghi dạng <code>2026-11-03</code> hoặc <code>03/11/2026</code> (ngày/tháng/năm).</li>
      <li>Lưu file (.xlsx hoặc .csv) rồi chọn file bên dưới. Bạn sẽ được xem trước trước khi nhập.</li>
    </ol>
    <div class="row">
      <button class="ghost" data-action="template-csv">Tải file mẫu (.csv)</button>
    </div>
    <label for="teamFile">Chọn file (.xlsx, .csv)</label>
    <input id="teamFile" type="file" accept=".xlsx,.xlsm,.ods,.csv,.tsv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">
    <details>
      <summary class="muted small">Hoặc dán trực tiếp từ Excel/Google Sheets</summary>
      <p class="muted small">Chọn vùng có cả dòng tiêu đề trong bảng tính, sao chép (Ctrl/Cmd+C) rồi dán vào đây.</p>
      <textarea id="teamPaste" rows="5" placeholder="Team	Project	Thành viên	Bắt đầu sprint	Kết thúc sprint	Sprint Goal"></textarea>
      <button class="ghost" data-action="preview-paste">Xem trước dữ liệu đã dán</button>
    </details>
    <p class="msg" id="importMsg"></p>
    <div id="importPreview"></div>
  </div>`;
}

function renderImportPreview() {
  const box = $('#importPreview');
  if (!box || !importPreview) return;
  const it = importPreview.items;
  const ok = it.filter(x => !x.errors.length), bad = it.filter(x => x.errors.length);
  const nNew = ok.filter(x => !x.existingId).length, nUpd = ok.filter(x => x.existingId).length;
  box.innerHTML = `<h4>Xem trước · ${it.length} dòng</h4>
    <p class="small">${nNew ? `<span class="badge good">${nNew} team mới</span> ` : ''}${nUpd ? `<span class="badge warn">${nUpd} team sẽ được cập nhật</span> ` : ''}${bad.length ? `<span class="badge bad">${bad.length} dòng lỗi, sẽ bỏ qua</span>` : ''}</p>
    ${nUpd ? '<p class="muted small">Team trùng tên với team đã có sẽ được ghi đè bằng thông tin trong file. Lịch sử report của team vẫn giữ nguyên.</p>' : ''}
    <div class="table-wrap"><table>
      <tr><th>Dòng</th><th>Team</th><th>Thành viên</th><th>Sprint</th><th>Sprint Goal</th><th>Kết quả</th></tr>
      ${it.map(x => `<tr>
        <td>${x.line}</td><td><b>${esc(x.name || '—')}</b>${x.project ? `<div class="muted small">${esc(x.project)}</div>` : ''}</td>
        <td>${esc(x.members.join(', ') || '—')}<div class="muted small">${x.members.length} người</div></td>
        <td class="small">${esc(x.sprintStart || '?')} → ${esc(x.sprintEnd || '?')}</td>
        <td class="small">${esc(x.sprintGoal || '—')}</td>
        <td class="small">${x.errors.length ? `<span class="badge bad">Lỗi</span> ${esc(x.errors.join('; '))}`
          : `<span class="badge ${x.existingId ? 'warn' : 'good'}">${x.existingId ? 'Cập nhật' : 'Mới'}</span>${x.warnings.length ? ` <span class="muted">${esc(x.warnings.join('; '))}</span>` : ''}`}</td>
      </tr>`).join('')}
    </table></div>
    ${ok.length ? `<button data-action="confirm-import">Nhập ${ok.length} team</button>` : '<p class="msg err">Không có dòng hợp lệ để nhập. Sửa file rồi chọn lại.</p>'}
    <button class="ghost" data-action="cancel-import">Hủy</button>`;
}

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function teamsCsv(teams) {
  const header = TEAM_COLUMNS.map(c => c.label);
  const lines = [header, ...teams.map(t => [t.name, t.project, t.members.join(', '), t.sprintStart, t.sprintEnd, t.sprintGoal])];
  return '﻿' + lines.map(r => r.map(csvCell).join(',')).join('\r\n'); // BOM để Excel đọc đúng tiếng Việt
}

function renderSettings() {
  const st = setting();
  $('#view-settings').innerHTML = `
    <h2>Kết nối AI</h2>
    <p>Chép lời: <b>${esc(AI[st.stt].label)}</b> · Phân tích: <b>${esc(AI[st.llm].label)}</b></p>
    <p class="muted small">Đổi AI, cập nhật key mới hoặc đổi model.</p>
    <button class="ghost" data-action="open-onboard">Đổi kết nối AI</button>

    <h2>Đồng bộ giữa các thiết bị</h2>
    <p class="muted">Bật để dùng app trên cả máy tính và iPad/điện thoại. Bản đã mã hóa được lưu trong thư mục ẩn dành riêng cho app trong Google Drive của bạn; app không thấy file nào khác trong Drive. Trên máy khác, chọn "Tôi đã dùng app trên thiết bị khác" và nhập cùng mật khẩu.</p>
    ${CFG.GOOGLE_CLIENT_ID ? (st.syncEnabled
      ? `<p><span class="badge good">Đang bật</span></p>
         <button data-action="sync-now">Đồng bộ ngay</button>
         <button class="ghost" data-action="disable-sync">Tắt đồng bộ</button>
         <button class="danger" data-action="delete-remote">Tắt và xóa bản trên Google Drive</button>`
      : `<button data-action="sync-now">Kết nối Google Drive và bật đồng bộ</button>`)
      : '<p class="warn">Người triển khai app chưa cấu hình Google Client ID nên chưa dùng được đồng bộ. Bạn vẫn có thể dùng file sao lưu.</p>'}

    <h2>Sao lưu</h2>
    <p class="muted">Dữ liệu trong trình duyệt có thể mất nếu xóa lịch sử duyệt web, hoặc Safari tự dọn khi lâu không mở app. Nên tải file sao lưu định kỳ. File được mã hóa bằng mật khẩu của bạn.</p>
    <button class="ghost" data-action="export-backup">Tải file sao lưu</button>

    <h2>Bảo mật và quyền riêng tư</h2>
    <p class="muted">Tự khóa sau ${esc(CFG.AUTO_LOCK_MINUTES || 30)} phút không thao tác.</p>
    <button class="ghost" data-action="show-privacy">Dữ liệu được xử lý thế nào</button>
    <button class="danger" data-action="wipe-all">Xóa toàn bộ dữ liệu trên máy này</button>`;
}

/* ---------- Tiện ích ---------- */
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function readJsonFile(input) {
  const f = input.files[0];
  if (!f) throw new Error('Chưa chọn file.');
  try { return JSON.parse(await f.text()); } catch { throw new Error('File không đọc được.'); }
}
function busy(btn, on, text) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = text || 'Đang xử lý...'; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}

/* ---------- Xử lý thao tác ---------- */
const actions = {
  'go-create'() { setMsg('#createMsg', ''); showScreen('create'); $('#newPass').focus(); },
  'go-restore'() { setMsg('#setupMsg', ''); showScreen('restore'); },
  'go-welcome'() { showScreen('welcome'); },
  goto(el) { showView(el.dataset.view); },
  async 'hide-checklist'() { setting().hideChecklist = true; touchSettings(); await persist(); renderOverview(); },
  async 'create-vault'(btn) {
    const p1 = $('#newPass').value, p2 = $('#newPass2').value;
    if (p1.length < 10) return setMsg('#createMsg', 'Mật khẩu cần ít nhất 10 ký tự.', 'err');
    if (p1 !== p2) return setMsg('#createMsg', 'Hai lần nhập mật khẩu không khớp.', 'err');
    if (!$('#ackPass').checked) return setMsg('#createMsg', 'Hãy tích ô xác nhận đã lưu mật khẩu ở nơi an toàn.', 'err');
    busy(btn, true, 'Đang tạo...');
    try { await createSession(p1, newState()); $('#newPass').value = $('#newPass2').value = ''; enterApp(); }
    catch (e) { setMsg('#createMsg', e.message, 'err'); }
    finally { busy(btn, false); }
  },
  'restore-drive'(btn) {
    const pass = $('#restorePass').value;
    if (!pass) return setMsg('#setupMsg', 'Nhập mật khẩu đã đặt ở thiết bị trước.', 'err');
    const login = drive.login(); // gọi ngay trong sự kiện bấm để popup không bị chặn
    busy(btn, true, 'Đang khôi phục...');
    (async () => {
      try {
        await login;
        const f = await drive.find();
        if (!f) throw new Error('Không tìm thấy dữ liệu Daily Scrum trong Google Drive của tài khoản này.');
        const dec = await decryptBlob(await drive.download(f.id), pass);
        await openSession(pass, dec);
        await idb.set('vault', await encryptState(S()));
        await idb.set('syncHint', true);
        $('#restorePass').value = '';
        enterApp();
        setSync('Đã khôi phục từ Google Drive', 'ok');
      } catch (e) { setMsg('#setupMsg', e.message, 'err'); }
      finally { busy(btn, false); }
    })();
  },
  async 'restore-file'(btn) {
    const pass = $('#restorePass').value;
    if (!pass) return setMsg('#setupMsg', 'Nhập mật khẩu của file sao lưu.', 'err');
    busy(btn, true, 'Đang khôi phục...');
    try {
      const dec = await decryptBlob(await readJsonFile($('#restoreFile')), pass);
      await openSession(pass, dec);
      await idb.set('vault', await encryptState(S()));
      $('#restorePass').value = '';
      enterApp();
    } catch (e) { setMsg('#setupMsg', e.message, 'err'); }
    finally { busy(btn, false); }
  },
  unlock(btn) {
    const pass = $('#unlockPass').value;
    if (!pass) return;
    // Nếu từng bật đồng bộ: xin token Google ngay trong sự kiện bấm (iPad chặn popup nếu chờ)
    const loginP = (pendingSyncHint && drive.available()) ? drive.login().catch(() => null) : null;
    busy(btn, true, 'Đang mở...');
    (async () => {
      try {
        await openSession(pass, await decryptBlob(await idb.get('vault'), pass));
        $('#unlockPass').value = '';
        enterApp();
        if (loginP) { await loginP; if (drive.hasToken() && setting().syncEnabled) syncNow(); else setSync(); }
      } catch (e) { setMsg('#lockMsg', e.message, 'err'); }
      finally { busy(btn, false); }
    })();
  },
  lock() { lock(); },
  'wipe-local'() {
    if (!confirm('Xóa toàn bộ dữ liệu Daily Scrum trên máy này? Bản trên Google Drive (nếu có) vẫn giữ nguyên.')) return;
    idb.del('vault').then(() => idb.del('syncHint')).then(() => location.reload());
  },
  async 'wipe-all'() {
    if (!confirm('Xóa toàn bộ dữ liệu trên máy này? Bản trên Google Drive (nếu có) vẫn giữ nguyên, và có thể khôi phục bằng mật khẩu.')) return;
    await idb.del('vault'); await idb.del('syncHint');
    session = null; location.reload();
  },
  'show-privacy'() { privacyReturn = $$('.screen.on')[0]?.id.replace('screen-', '') || 'welcome'; showScreen('privacy'); },
  'close-privacy'() { showScreen(privacyReturn); },

  'open-onboard'() { openOnboard(); },
  'cancel-onboard'() { enterApp(); },
  async 'test-ai'(btn) {
    const k = btn.dataset.provider;
    collectOnboard();
    const key = setting().keys[k];
    if (!key) return setMsg('#aimsg-' + k, 'Dán key trước khi kiểm tra.', 'err');
    busy(btn, true, 'Đang kiểm tra...');
    try {
      await testConnection(k, key);
      setting().connected[k] = true; touchSettings();
      await persist();
      renderGuides();
      setMsg('#aimsg-' + k, 'Kết nối ' + AI[k].label + ' thành công.', 'ok');
    } catch (e) {
      setting().connected[k] = false; touchSettings();
      await persist();
      setMsg('#aimsg-' + k, e.message, 'err');
      updateDone();
    } finally { busy(btn, false); }
  },
  async 'finish-onboard'() {
    collectOnboard();
    if (!aiReady()) { renderGuides(); return; }
    await persist();
    enterApp();
  },

  async analyze(btn) {
    const team = S().teams[$('#teamSel').value], f = $('#audio').files[0], st = setting();
    if (!team) return setMsg('#analyzeMsg', 'Chọn team.', 'err');
    if (!f) return setMsg('#analyzeMsg', 'Chọn file ghi âm.', 'err');
    const max = AI[st.stt].maxMB || 25;
    if (f.size > max * 1024 * 1024) return setMsg('#analyzeMsg', `File lớn hơn ${max} MB, giới hạn của ${AI[st.stt].label}. Hãy nén (mp3) hoặc cắt ngắn.`, 'err');
    busy(btn, true, 'Đang xử lý...');
    $('#analyzeReport').innerHTML = '';
    try {
      setMsg('#analyzeMsg', 'Đang chép lời bằng ' + AI[st.stt].label + '...');
      const transcript = await transcribe(f, team);
      if (!transcript.trim()) throw new Error('Không nhận được nội dung chép lời. Kiểm tra lại file ghi âm.');
      setMsg('#analyzeMsg', 'Đang phân tích bằng ' + AI[st.llm].label + '...');
      const userMsg = [
        `Team: ${team.name} | Project: ${team.project}`,
        `Ngày daily: ${todayStr()}`,
        `Sprint: ${team.sprintStart || '?'} đến ${team.sprintEnd || '?'}`,
        `Sprint Goal: ${team.sprintGoal}`,
        `Thành viên: ${team.members.join(', ')}`,
        `Cập nhật 3 ngày gần nhất (JSON): ${JSON.stringify(recentHistory(team.id, 3))}`,
        '--- TRANSCRIPT ---', transcript
      ].join('\n');
      const result = parseResult(await callLLM(SYSTEM_PROMPT, userMsg));
      const isFirst = !live('dailies').length;
      const d = { id: uid(), date: todayStr(), teamId: team.id, teamName: team.name, transcript, result,
                  createdAt: now(), updatedAt: now() };
      S().dailies[d.id] = d;
      await persist();
      $('#audio').value = '';
      $('#analyzeIntro').innerHTML = '';
      setMsg('#analyzeMsg', 'Xong. File ghi âm không được lưu lại.', 'ok');
      $('#analyzeReport').innerHTML = (isFirst ? `<div class="callout"><b>Hoàn tất 4 bước!</b> Report đầu tiên ở ngay dưới đây.
        Từ giờ, sau mỗi buổi daily chỉ cần vào thẻ Phân tích. Thẻ <a href="#" data-action="goto" data-view="overview">Hôm nay</a> tổng hợp mọi team và impediment đang mở.
        Nên vào <a href="#" data-action="goto" data-view="settings">Cài đặt</a> để bật đồng bộ hoặc tải file sao lưu.</div>` : '') + renderReportHtml(d);
    } catch (e) { setMsg('#analyzeMsg', e.message, 'err'); }
    finally { busy(btn, false); }
  },
  'open-report'(el) { openReport(el.dataset.id); },
  'back-report'() { showView(reportReturn === 'report' ? 'history' : reportReturn); },
  async 'copy-report'(el) {
    const text = reportText(S().dailies[el.dataset.id]);
    try { await navigator.clipboard.writeText(text); el.textContent = 'Đã sao chép'; }
    catch { download(`report-${S().dailies[el.dataset.id].date}.txt`, text, 'text/plain;charset=utf-8'); }
  },
  'download-transcript'(el) {
    const d = S().dailies[el.dataset.id];
    download(`${d.date}_${d.teamName}.txt`, d.transcript, 'text/plain;charset=utf-8');
  },
  'toggle-transcript'(el) { const p = $('#tr-' + el.dataset.id); p.hidden = !p.hidden; },
  async 'delete-daily'(el) {
    if (!confirm('Xóa report này (cả transcript)?')) return;
    const d = S().dailies[el.dataset.id];
    S().dailies[d.id] = { id: d.id, deleted: true, updatedAt: now() };
    await persist(); renderHistory();
  },
  async 'close-imp'(el) {
    S().impediments[el.dataset.id] = { status: 'Đã xử lý', updatedAt: now() };
    await persist(); renderOverview();
  },

  'team-mode'(el) { teamMode = el.dataset.mode; importPreview = null; renderTeams(); },
  'template-csv'() {
    const sample = [
      { name: 'Invoice A', project: 'Sapo Invoice', members: ['Nam (anh Nam, Nam BE)', 'Lan', 'Hùng'], sprintStart: '2026-11-03', sprintEnd: '2026-11-14', sprintGoal: 'Ra mắt thanh toán QR cho merchant thử nghiệm' },
      { name: 'Accounting B', project: 'Sapo Accounting', members: ['Minh', 'Thảo', 'Quân'], sprintStart: '2026-11-03', sprintEnd: '2026-11-14', sprintGoal: 'Hoàn thiện báo cáo công nợ' }
    ];
    download('daily-scrum-mau-team.csv', teamsCsv(sample), 'text/csv;charset=utf-8');
  },
  'export-teams'() { download(`daily-scrum-team-${todayStr()}.csv`, teamsCsv(teamsSorted()), 'text/csv;charset=utf-8'); },
  'preview-paste'() {
    try {
      const text = $('#teamPaste').value;
      if (!text.trim()) return setMsg('#importMsg', 'Chưa có dữ liệu để xem trước.', 'err');
      importPreview = buildImportPreview(parseDelimited(text));
      setMsg('#importMsg', ''); renderImportPreview();
    } catch (e) { importPreview = null; $('#importPreview').innerHTML = ''; setMsg('#importMsg', e.message, 'err'); }
  },
  'cancel-import'() { importPreview = null; renderTeams(); },
  async 'confirm-import'(btn) {
    const ok = importPreview.items.filter(x => !x.errors.length);
    busy(btn, true, 'Đang nhập...');
    const wasEmpty = !teamsSorted().length;
    let firstId = null;
    ok.forEach(x => {
      const id = x.existingId || uid();
      firstId = firstId || id;
      S().teams[id] = { id, name: x.name, project: x.project, members: x.members, sprintStart: x.sprintStart,
        sprintEnd: x.sprintEnd, sprintGoal: x.sprintGoal, updatedAt: now() };
    });
    await persist();
    const nNew = ok.filter(x => !x.existingId).length, nUpd = ok.length - nNew;
    importPreview = null; teamMode = 'manual';
    if (wasEmpty && !live('dailies').length) { showView('analyze'); if (firstId) $('#teamSel').value = firstId; return; }
    renderTeams();
    setMsg('#teamMsg', `Đã nhập ${nNew} team mới${nUpd ? `, cập nhật ${nUpd} team` : ''}.`, 'ok');
  },
  'edit-team'(el) { editingTeam = el.dataset.id; teamMode = 'manual'; renderTeams(); },
  'cancel-team'() { editingTeam = null; renderTeams(); },
  async 'save-team'() {
    const name = $('#tName').value.trim();
    const members = splitMembers($('#tMembers').value);
    if (!name) return setMsg('#teamMsg', 'Nhập tên team.', 'err');
    if (!members.length) return setMsg('#teamMsg', 'Nhập ít nhất 1 thành viên.', 'err');
    const id = editingTeam || uid();
    const wasFirst = !teamsSorted().length;
    S().teams[id] = { id, name, project: $('#tProject').value.trim(), members,
      sprintStart: $('#tStart').value, sprintEnd: $('#tEnd').value, sprintGoal: $('#tGoal').value.trim(), updatedAt: now() };
    editingTeam = null;
    await persist();
    // Team đầu tiên trong luồng làm quen: chuyển sang bước 4
    if (wasFirst && !live('dailies').length) { showView('analyze'); $('#teamSel').value = id; return; }
    renderTeams();
    setMsg('#teamMsg', 'Đã lưu team ' + name + '. Thêm team khác, hoặc sang thẻ Phân tích.', 'ok');
  },
  async 'delete-team'(el) {
    const t = S().teams[el.dataset.id];
    if (!confirm(`Xóa team ${t.name}? Report cũ của team vẫn giữ trong Lịch sử.`)) return;
    S().teams[t.id] = { id: t.id, deleted: true, updatedAt: now() };
    await persist(); renderTeams();
  },

  'sync-now'() {
    if (!session) return;
    if (drive.hasToken()) return syncNow();
    const login = drive.login(); // ngay trong sự kiện bấm
    login.then(() => syncNow()).catch(e => setSync(e.message, 'err'));
  },
  async 'disable-sync'() {
    setting().syncEnabled = false; touchSettings();
    await idb.del('syncHint');
    await idb.set('vault', await encryptState(S()));
    setSync(); renderSettings();
  },
  'delete-remote'() {
    if (!confirm('Tắt đồng bộ và xóa bản đã mã hóa trên Google Drive? Dữ liệu trên máy này vẫn giữ nguyên.')) return;
    const login = drive.login();
    login.then(async () => {
      await drive.remove();
      setting().syncEnabled = false; touchSettings();
      await idb.del('syncHint');
      await idb.set('vault', await encryptState(S()));
      setSync('Đã xóa bản trên Google Drive', 'ok'); renderSettings();
    }).catch(e => setSync(e.message, 'err'));
  },
  async 'export-backup'() {
    if (!setting().backedUp) { setting().backedUp = true; touchSettings(); await persist(); }
    const blob = await encryptState(S());
    download(`daily-scrum-${todayStr()}.dsbackup`, JSON.stringify(blob), 'application/json');
  }
};

let privacyReturn = 'welcome', pendingSyncHint = false;

document.addEventListener('click', e => {
  const nav = e.target.closest('nav [data-view]');
  if (nav) return showView(nav.dataset.view);
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  if (el.tagName === 'A') e.preventDefault();
  const fn = actions[el.dataset.action];
  if (fn) Promise.resolve(fn(el, e)).catch(err => alert(err.message));
});
document.addEventListener('change', async e => {
  if (e.target.id === 'teamFile') {
    const f = e.target.files[0];
    if (!f) return;
    setMsg('#importMsg', 'Đang đọc file ' + f.name + '...');
    try {
      importPreview = buildImportPreview(await readTeamFile(f));
      setMsg('#importMsg', ''); renderImportPreview();
    } catch (err) { importPreview = null; $('#importPreview').innerHTML = ''; setMsg('#importMsg', err.message, 'err'); }
    e.target.value = '';
    return;
  }
  if (e.target.dataset.change === 'show-pass') {
    e.target.dataset.target.split(',').forEach(id => { $('#' + id).type = e.target.checked ? 'text' : 'password'; });
    return;
  }
  if (e.target.dataset.change !== 'pick-ai') return;
  const which = e.target.id === 'sttSel' ? 'stt' : 'llm';
  $('#' + which + 'Model').value = AI[e.target.value][which + 'Model'] || '';
  renderGuides();
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'unlockPass') actions.unlock($('[data-action="unlock"]'));
});

/* ---------- Khởi động ---------- */
(async function start() {
  if (!window.crypto?.subtle || !window.indexedDB) {
    document.body.innerHTML = '<p class="center">Trình duyệt này không hỗ trợ mã hóa hoặc lưu trữ cần thiết. Hãy dùng Chrome, Safari, Edge hoặc Firefox bản mới, và không dùng chế độ ẩn danh.</p>';
    return;
  }
  try {
    const vault = await idb.get('vault');
    pendingSyncHint = !!(await idb.get('syncHint'));
    showScreen(vault ? 'lock' : 'welcome');
  } catch {
    document.body.innerHTML = '<p class="center">Không mở được bộ nhớ của trình duyệt. Nếu đang dùng chế độ ẩn danh, hãy mở trang ở cửa sổ thường.</p>';
  }
})();
