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
function showScreen(name) {
  $$('.screen').forEach(s => s.classList.toggle('on', s.id === 'screen-' + name));
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
     settings: renderSettings, report: () => {} })[currentView]?.();
}
function enterApp() {
  if (!aiReady()) return openOnboard();
  showScreen('main');
  setSync();
  if (!teamsSorted().length) { showView('teams'); return; }
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
  $('#cancelOnboard').style.display = aiReady() ? '' : 'none';
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
  $('#doneBtn').disabled = !(AI[stt].canTranscribe && st.connected[stt] && st.connected[llm]);
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
    <h2>Hôm nay · ${esc(today)}</h2>
    ${todays.length ? `<div class="table-wrap"><table><tr><th>Team</th><th>Sprint Goal</th><th>Lý do</th><th>Impediment</th><th></th></tr>
      ${todays.map(d => `<tr><td>${esc(d.teamName)}</td><td>${goalBadge(d.result.sprint_goal.status)}</td><td>${esc(d.result.sprint_goal.reason)}</td>
        <td>${d.result.impediments.length}</td><td><a href="#" data-action="open-report" data-id="${d.id}">Xem</a></td></tr>`).join('')}
      </table></div>` : '<p class="muted">Hôm nay chưa phân tích buổi daily nào. Vào thẻ Phân tích để bắt đầu.</p>'}
    <h2>Impediment đang mở (${openImps.length})</h2>
    ${openImps.length ? openImps.map(x => `<div class="list-item"><div><b>${esc(x.d.teamName)}</b> · ${esc(x.d.date)} · ${esc(x.i.raised_by)}: ${esc(x.i.description)}
      <div class="muted small">Cần: ${esc(x.i.needs)}</div></div>
      <button class="ghost sm" data-action="close-imp" data-id="${esc(x.id)}">Đã xử lý</button></div>`).join('')
      : '<p class="muted">Không có impediment nào đang mở.</p>'}
    <h2>Cần trao đổi với Scrum Master</h2>
    ${flags.length ? '<ul>' + flags.map(f => `<li>${esc(f)}</li>`).join('') + '</ul>' : '<p class="muted">Không có thành viên nào thiếu nội dung 3 daily liên tiếp.</p>'}`;
}

function renderAnalyze() {
  const teams = teamsSorted();
  const sel = $('#teamSel'), prev = sel.value;
  sel.innerHTML = teams.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  if (teams.some(t => t.id === prev)) sel.value = prev;
  $('#goBtn').disabled = !teams.length;
  if (!teams.length) setMsg('#analyzeMsg', 'Chưa có team. Vào thẻ Team để thêm.', 'err');
}

function renderHistory() {
  const items = dailiesSorted();
  $('#view-history').innerHTML = `<h2>Lịch sử (${items.length})</h2>` + (items.length
    ? items.map(d => `<div class="list-item"><a href="#" data-action="open-report" data-id="${d.id}">${esc(d.date)} · <b>${esc(d.teamName)}</b></a>
        <span>${goalBadge(d.result.sprint_goal.status)} <button class="danger sm" data-action="delete-daily" data-id="${d.id}">Xóa</button></span></div>`).join('')
    : '<p class="muted">Chưa có report nào.</p>');
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
  $('#view-teams').innerHTML = `
    <h2>Team của bạn</h2>
    ${teams.length ? teams.map(x => `<div class="list-item"><div><b>${esc(x.name)}</b> · ${esc(x.project)}
        <div class="muted small">${esc(x.members.join(', '))}</div>
        <div class="muted small">Sprint ${esc(x.sprintStart || '?')} → ${esc(x.sprintEnd || '?')} · ${esc(x.sprintGoal)}</div></div>
        <span><button class="ghost sm" data-action="edit-team" data-id="${x.id}">Sửa</button>
        <button class="danger sm" data-action="delete-team" data-id="${x.id}">Xóa</button></span></div>`).join('')
      : '<p class="muted">Chưa có team nào. Thêm team đầu tiên bên dưới.</p>'}
    <div class="card">
      <h4>${t ? 'Sửa team' : 'Thêm team'}</h4>
      <label for="tName">Tên team</label><input id="tName" value="${esc(t?.name || '')}">
      <label for="tProject">Project</label><input id="tProject" value="${esc(t?.project || '')}">
      <label for="tMembers">Thành viên (cách nhau dấu phẩy; có thể thêm tên gọi khác trong ngoặc)</label>
      <textarea id="tMembers" rows="2">${esc(t ? t.members.join(', ') : '')}</textarea>
      <div class="row">
        <div><label for="tStart">Bắt đầu sprint</label><input id="tStart" type="date" value="${esc(t?.sprintStart || '')}"></div>
        <div><label for="tEnd">Kết thúc sprint</label><input id="tEnd" type="date" value="${esc(t?.sprintEnd || '')}"></div>
      </div>
      <label for="tGoal">Sprint Goal</label><textarea id="tGoal" rows="2">${esc(t?.sprintGoal || '')}</textarea>
      <button data-action="save-team">${t ? 'Lưu thay đổi' : 'Thêm team'}</button>
      ${t ? '<button class="ghost" data-action="cancel-team">Hủy</button>' : ''}
      <p class="msg" id="teamMsg"></p>
    </div>`;
}

function renderSettings() {
  const st = setting();
  $('#view-settings').innerHTML = `
    <h2>Kết nối AI</h2>
    <p>Chuyển giọng nói: <b>${esc(AI[st.stt].label)}</b> · Phân tích: <b>${esc(AI[st.llm].label)}</b></p>
    <button class="ghost" data-action="open-onboard">Đổi kết nối AI</button>

    <h2>Đồng bộ giữa các thiết bị</h2>
    <p class="muted">Bản mã hóa được lưu trong thư mục ẩn dành riêng cho app trong Google Drive của bạn. App không thấy file nào khác trong Drive.</p>
    ${CFG.GOOGLE_CLIENT_ID ? (st.syncEnabled
      ? `<p><span class="badge good">Đang bật</span></p>
         <button data-action="sync-now">Đồng bộ ngay</button>
         <button class="ghost" data-action="disable-sync">Tắt đồng bộ</button>
         <button class="danger" data-action="delete-remote">Tắt và xóa bản trên Google Drive</button>`
      : `<button data-action="sync-now">Kết nối Google Drive và bật đồng bộ</button>`)
      : '<p class="warn">Người triển khai app chưa cấu hình Google Client ID nên chưa dùng được đồng bộ. Bạn vẫn có thể dùng file sao lưu.</p>'}

    <h2>Sao lưu</h2>
    <p class="muted">File sao lưu được mã hóa bằng mật khẩu của bạn. Dùng để chuyển sang thiết bị khác hoặc lưu trữ.</p>
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
  async 'create-vault'(btn) {
    const p1 = $('#newPass').value, p2 = $('#newPass2').value;
    if (p1.length < 10) return setMsg('#setupMsg', 'Mật khẩu cần ít nhất 10 ký tự.', 'err');
    if (p1 !== p2) return setMsg('#setupMsg', 'Hai lần nhập mật khẩu không khớp.', 'err');
    busy(btn, true, 'Đang tạo...');
    try { await createSession(p1, newState()); $('#newPass').value = $('#newPass2').value = ''; enterApp(); }
    catch (e) { setMsg('#setupMsg', e.message, 'err'); }
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
  'show-privacy'() { privacyReturn = $$('.screen.on')[0]?.id.replace('screen-', '') || 'setup'; showScreen('privacy'); },
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
      const d = { id: uid(), date: todayStr(), teamId: team.id, teamName: team.name, transcript, result,
                  createdAt: now(), updatedAt: now() };
      S().dailies[d.id] = d;
      await persist();
      $('#audio').value = '';
      setMsg('#analyzeMsg', 'Xong. File ghi âm không được lưu lại.', 'ok');
      $('#analyzeReport').innerHTML = renderReportHtml(d);
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

  'edit-team'(el) { editingTeam = el.dataset.id; renderTeams(); },
  'cancel-team'() { editingTeam = null; renderTeams(); },
  async 'save-team'() {
    const name = $('#tName').value.trim();
    const members = $('#tMembers').value.split(',').map(s => s.trim()).filter(Boolean);
    if (!name) return setMsg('#teamMsg', 'Nhập tên team.', 'err');
    if (!members.length) return setMsg('#teamMsg', 'Nhập ít nhất 1 thành viên.', 'err');
    const id = editingTeam || uid();
    S().teams[id] = { id, name, project: $('#tProject').value.trim(), members,
      sprintStart: $('#tStart').value, sprintEnd: $('#tEnd').value, sprintGoal: $('#tGoal').value.trim(), updatedAt: now() };
    editingTeam = null;
    await persist(); renderTeams();
    setMsg('#teamMsg', 'Đã lưu team ' + name + '.', 'ok');
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
    const blob = await encryptState(S());
    download(`daily-scrum-${todayStr()}.dsbackup`, JSON.stringify(blob), 'application/json');
  }
};

let privacyReturn = 'setup', pendingSyncHint = false;

document.addEventListener('click', e => {
  const nav = e.target.closest('nav [data-view]');
  if (nav) return showView(nav.dataset.view);
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  if (el.tagName === 'A') e.preventDefault();
  const fn = actions[el.dataset.action];
  if (fn) Promise.resolve(fn(el, e)).catch(err => alert(err.message));
});
document.addEventListener('change', e => {
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
    showScreen(vault ? 'lock' : 'setup');
  } catch {
    document.body.innerHTML = '<p class="center">Không mở được bộ nhớ của trình duyệt. Nếu đang dùng chế độ ẩn danh, hãy mở trang ở cửa sổ thường.</p>';
  }
})();
