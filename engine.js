/* =========================================================
   USMLE BRAIN — Step 2/3 Engine
   engine.js — all module logic
   ========================================================= */

/* ---------- GLOBAL STATE ---------- */
let currentProvider = 'groq';
let currentModule = 'compressor';
let imgB64 = null, imgMime = null;
let analysis = null, chatHist = [], chatMode = 'free';

/* ---------- PROVIDERS ---------- */
const PROVIDERS = {
  groq: {
    name: 'GROQ', color: '#4ADE80',
    placeholder: 'Groq API key — console.groq.com',
    storageKey: 'ub_key_groq'
  },
  openrouter: {
    name: 'OPENROUTER', color: '#60A5FA',
    placeholder: 'OpenRouter API key — openrouter.ai',
    storageKey: 'ub_key_or'
  },
  gemini: {
    name: 'GEMINI', color: '#F472B6',
    placeholder: 'Gemini API key — aistudio.google.com',
    storageKey: 'ub_key_gem'
  }
};

function switchProvider(p) {
  currentProvider = p;
  document.querySelectorAll('.prov-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('ptab-' + p).classList.add('active');
  const prov = PROVIDERS[p];
  document.getElementById('apikey').placeholder = prov.placeholder;
  const saved = localStorage.getItem(prov.storageKey);
  document.getElementById('apikey').value = saved || '';
  setKeyStatus(saved ? '✓ ' + prov.name + ' key loaded' : 'Paste your ' + prov.name + ' key', saved ? 'ok' : '');
}
function saveKey() {
  const k = document.getElementById('apikey').value.trim();
  if (k) {
    localStorage.setItem(PROVIDERS[currentProvider].storageKey, k);
    setKeyStatus('✓ ' + PROVIDERS[currentProvider].name + ' saved', 'ok');
  }
}
function loadKey() {
  // migrate old single key
  const old = localStorage.getItem('ub_key');
  if (old && !localStorage.getItem('ub_key_groq')) localStorage.setItem('ub_key_groq', old);
  const k = localStorage.getItem(PROVIDERS[currentProvider].storageKey);
  if (k) {
    document.getElementById('apikey').value = k;
    setKeyStatus('✓ Key loaded', 'ok');
  } else {
    setKeyStatus('Paste your key (free at console.groq.com)', '');
  }
}
function setKeyStatus(t, cls) {
  const el = document.getElementById('keystatus');
  if (!el) return;
  el.textContent = t;
  el.className = 'key-status' + (cls ? ' ' + cls : '');
}
function getKey(provider) { return localStorage.getItem(PROVIDERS[provider].storageKey) || ''; }
function anyKey() { return getKey('groq') || getKey('openrouter') || getKey('gemini'); }

/* ---------- API CALLS ---------- */
async function smartCall(messages, json_mode, opts = {}) {
  const order = ['groq', 'openrouter', 'gemini'];
  const tryOrder = [currentProvider, ...order.filter(p => p !== currentProvider)];
  let lastErr = '';
  for (const provider of tryOrder) {
    const key = getKey(provider);
    if (!key) continue;
    try {
      const result = await callProvider(provider, key, messages, json_mode, opts);
      if (result) return result;
    } catch (err) {
      lastErr = err.message;
      console.log(provider + ' failed:', err.message);
      continue;
    }
  }
  const have = order.filter(p => getKey(p));
  if (!have.length) throw new Error('No API key — paste one at the top (Groq is free at console.groq.com)');
  throw new Error('All providers failed. ' + lastErr);
}

async function callProvider(provider, key, messages, json_mode, opts = {}) {
  const max = opts.maxTokens || 4000;
  const temp = opts.temperature ?? 0.2;

  if (provider === 'groq') {
    const body = { model: 'llama-3.3-70b-versatile', messages, temperature: temp, max_tokens: max };
    if (json_mode) body.response_format = { type: 'json_object' };
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Groq error ' + r.status);
    return d.choices?.[0]?.message?.content || '';
  }

  if (provider === 'openrouter') {
    const body = { model: 'google/gemini-2.0-flash-exp:free', messages, temperature: temp, max_tokens: max };
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key,
        'HTTP-Referer': 'https://usmle-brain.app', 'X-Title': 'USMLE Brain'
      },
      body: JSON.stringify(body)
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'OpenRouter error ' + r.status);
    const content = d.choices?.[0]?.message?.content || '';
    if (!content) throw new Error('Empty response');
    return content;
  }

  if (provider === 'gemini') {
    const sys = messages.find(m => m.role === 'system')?.content || '';
    const userMsgs = messages.filter(m => m.role !== 'system');
    const gemContents = userMsgs.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
    }));
    const gemBody = { contents: gemContents, generationConfig: { temperature: temp, maxOutputTokens: max } };
    if (sys) gemBody.system_instruction = { parts: [{ text: sys }] };
    if (json_mode) gemBody.generationConfig.response_mime_type = 'application/json';
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + key, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(gemBody)
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error?.message || 'Gemini error ' + r.status);
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) throw new Error('Empty Gemini response');
    return text;
  }
}

async function smartVision(base64, mime, prompt) {
  const groqKey = getKey('groq');
  if (groqKey) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + groqKey },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
          ]}],
          temperature: 0, max_tokens: 2000
        })
      });
      const d = await r.json();
      if (r.ok) return d.choices?.[0]?.message?.content || '';
    } catch (e) { console.log('Groq vision failed'); }
  }
  const gemKey = getKey('gemini');
  if (gemKey) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + gemKey, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [
            { text: prompt }, { inline_data: { mime_type: mime, data: base64 } }
          ]}],
          generationConfig: { temperature: 0, maxOutputTokens: 2000 }
        })
      });
      const d = await r.json();
      if (r.ok && d.candidates?.[0]?.content?.parts?.[0]?.text) return d.candidates[0].content.parts[0].text;
    } catch (e) { console.log('Gemini vision failed'); }
  }
  throw new Error('No vision-capable key. Add Groq or Gemini key.');
}

function parseJSON(raw) {
  raw = (raw || '').replace(/```json|```/g, '').trim();
  // Try direct parse first
  try { return JSON.parse(raw); } catch {}
  // Find outermost object/array
  const findBlock = (open, close) => {
    const s = raw.indexOf(open);
    if (s === -1) return null;
    let depth = 0, end = -1;
    for (let i = s; i < raw.length; i++) {
      if (raw[i] === open) depth++;
      else if (raw[i] === close) { depth--; if (depth === 0) { end = i; break; } }
    }
    return end > -1 ? raw.substring(s, end + 1) : null;
  };
  const obj = findBlock('{', '}');
  if (obj) { try { return JSON.parse(obj); } catch {} }
  const arr = findBlock('[', ']');
  if (arr) { try { return JSON.parse(arr); } catch {} }
  throw new Error('Could not parse AI response. Try again.');
}

/* ---------- MODULE NAVIGATION ---------- */
function switchModule(m) {
  currentModule = m;
  document.querySelectorAll('.modtab').forEach(t => t.classList.toggle('active', t.dataset.mod === m));
  document.querySelectorAll('.module').forEach(el => el.classList.toggle('active', el.id === 'mod-' + m));
  localStorage.setItem('ub_module', m);
}

/* ---------- THEME / FONT ---------- */
const THEMES = ['dark', 'light', 'purple', 'green'];
const THEME_ICONS = ['🌙', '☀️', '🔮', '🌿'];
let themeIdx = parseInt(localStorage.getItem('ub_theme') || '0');
let fontSize = parseInt(localStorage.getItem('ub_fs') || '14');

function cycleTheme() {
  themeIdx = (themeIdx + 1) % THEMES.length;
  applyTheme();
  localStorage.setItem('ub_theme', themeIdx);
}
function applyTheme() {
  document.body.className = 'theme-' + THEMES[themeIdx];
  const btn = document.getElementById('themebtn');
  if (btn) btn.textContent = THEME_ICONS[themeIdx];
}
function changeFont(delta) {
  fontSize = Math.max(11, Math.min(20, fontSize + delta));
  document.documentElement.style.setProperty('font-size', fontSize + 'px');
  localStorage.setItem('ub_fs', fontSize);
}

/* ---------- HELPERS ---------- */
function esc(s) { return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escAttr(s) { return (s || '').toString().replace(/'/g, "\\'").replace(/\n/g, ' '); }
function showError(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
}
function hideError(elId) {
  const el = document.getElementById(elId);
  if (el) el.classList.remove('show');
}
function showSpin(elId, txt) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.classList.add('show');
  const t = el.querySelector('.spin-txt');
  if (t && txt) t.textContent = txt;
}
function hideSpin(elId) {
  const el = document.getElementById(elId);
  if (el) el.classList.remove('show');
}

/* =========================================================
   FEATURE 1 — ADAPTIVE VIGNETTE COMPRESSOR
   ========================================================= */

let compressorPatterns = JSON.parse(localStorage.getItem('ub_patterns') || '[]');

const COMPRESSOR_SYS = `You are a USMLE Step 2/3 pattern-recognition coach. Read the input (notes / review-book paragraph / vignette / lecture transcript) and extract every clinically distinct concept as a compressed exam-trigger pattern.

For EACH concept return:
- "trigger": array of 3-5 short phrases (the cluster of clinical clues that should fire instant pattern-match — demographic + symptom + sign + buzz feature)
- "diagnosis": the diagnosis or finding
- "next_step": single best next step (test/management/treatment) — what NBME asks
- "buzzwords": array of 1-3 highest-yield buzzwords (the words the writer plants)
- "trap": ONE-line sentence describing the most common reason students get this wrong on boards
- "topic": short topic tag like "Cardio - ACS" or "Surg - Trauma"

Rules:
- Each pattern must be readable in <5 seconds.
- Skip filler. Only extract exam-relevant patterns. Aim for 5-25 patterns per input.
- Use precise NBME phrasing for triggers (e.g. "Elderly", "Fall on outstretched hand", "Inability to externally rotate").

Return ONLY valid JSON: { "patterns": [ { ... }, { ... } ] }`;

async function compressorRun() {
  const txt = document.getElementById('comp-input').value.trim();
  if (!txt) return showError('comp-err', 'Paste some text — notes, a paragraph from First Aid, or a vignette.');
  if (!anyKey()) return showError('comp-err', 'Add an API key at the top first.');
  hideError('comp-err');

  const btn = document.getElementById('comp-btn');
  btn.disabled = true; btn.textContent = 'Compressing…';
  showSpin('comp-spin', 'Compressing into exam triggers…');

  try {
    const raw = await smartCall(
      [{ role: 'system', content: COMPRESSOR_SYS }, { role: 'user', content: txt.slice(0, 16000) }],
      true, { maxTokens: 6000 }
    );
    const d = parseJSON(raw);
    const newPatterns = (d.patterns || []).map(p => ({
      ...p, id: 'p' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      created: Date.now()
    }));
    compressorPatterns = [...newPatterns, ...compressorPatterns];
    localStorage.setItem('ub_patterns', JSON.stringify(compressorPatterns.slice(0, 500)));
    renderCompressor();
  } catch (err) {
    showError('comp-err', err.message);
  } finally {
    btn.disabled = false; btn.textContent = '⚡ Compress to Triggers';
    hideSpin('comp-spin');
  }
}

function renderCompressor() {
  const list = document.getElementById('comp-list');
  const stats = document.getElementById('comp-stats');
  const filter = (document.getElementById('comp-search')?.value || '').toLowerCase();

  if (!compressorPatterns.length) {
    list.innerHTML = `<div class="hint" style="text-align:center;padding:30px">No patterns yet. Paste some text above and hit Compress.</div>`;
    stats.innerHTML = '';
    return;
  }

  const topics = {};
  compressorPatterns.forEach(p => { topics[p.topic || 'Other'] = (topics[p.topic || 'Other'] || 0) + 1; });
  stats.innerHTML = `
    <div class="stat-pill"><b>${compressorPatterns.length}</b> patterns</div>
    <div class="stat-pill"><b>${Object.keys(topics).length}</b> topics</div>
    <button class="btn-mini btn-ghost" onclick="exportPatterns()">📥 Export</button>
    <button class="btn-mini btn-ghost btn-warn" onclick="if(confirm('Clear all patterns?')){compressorPatterns=[];localStorage.removeItem('ub_patterns');renderCompressor();}">🗑️ Clear</button>
  `;

  const filtered = filter
    ? compressorPatterns.filter(p =>
        (p.diagnosis || '').toLowerCase().includes(filter) ||
        (p.topic || '').toLowerCase().includes(filter) ||
        (p.trigger || []).join(' ').toLowerCase().includes(filter) ||
        (p.buzzwords || []).join(' ').toLowerCase().includes(filter)
      )
    : compressorPatterns;

  list.innerHTML = filtered.map(p => `
    <div class="pat-card">
      <div class="pat-trigger">
        ${(p.trigger || []).map(t => `<code>${esc(t)}</code>`).join(' <span class="pat-arrow">+</span> ')}
        <span class="pat-arrow">→</span>
        <span class="pat-dx">${esc(p.diagnosis || '')}</span>
      </div>
      ${p.next_step ? `<div class="pat-next"><b>Next:</b> ${esc(p.next_step)}</div>` : ''}
      <div class="pat-meta">
        ${p.topic ? `<span class="stat-pill" style="font-size:10px">${esc(p.topic)}</span>` : ''}
        ${(p.buzzwords || []).map(b => `<span class="pat-buzz">${esc(b)}</span>`).join('')}
      </div>
      ${p.trap ? `<div class="pat-trap"><b>Trap:</b> ${esc(p.trap)}</div>` : ''}
    </div>
  `).join('');
}

function exportPatterns() {
  const txt = compressorPatterns.map(p =>
    `${(p.trigger || []).join(' + ')} → ${p.diagnosis} → ${p.next_step || ''}\n[${p.topic || ''}] Buzz: ${(p.buzzwords || []).join(', ')}\nTrap: ${p.trap || ''}\n`
  ).join('\n---\n');
  const blob = new Blob([txt], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'usmle-patterns.txt'; a.click();
  URL.revokeObjectURL(url);
}

/* ---------- PDF UPLOAD for compressor & oracle ---------- */
async function readPDF(file) {
  if (!window.pdfjsLib) throw new Error('PDF library not loaded — refresh page');
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(' ') + '\n\n';
  }
  return text;
}

async function compressorOnFile(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  const ta = document.getElementById('comp-input');
  showSpin('comp-spin', 'Reading PDF…');
  try {
    let allText = ta.value || '';
    for (const f of files) {
      if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        const t = await readPDF(f);
        allText += '\n\n=== ' + f.name + ' ===\n\n' + t;
      } else if (f.type.startsWith('text/')) {
        allText += '\n\n=== ' + f.name + ' ===\n\n' + await f.text();
      }
    }
    ta.value = allText.trim();
  } catch (err) {
    showError('comp-err', 'PDF read error: ' + err.message);
  } finally {
    hideSpin('comp-spin');
    e.target.value = '';
  }
}

/* =========================================================
   FEATURE 2 — 20-SECOND BUZZER TRAINER
   ========================================================= */

let buzzerState = {
  topic: '', count: 10, seconds: 20, currentIdx: 0,
  questions: [], history: [], score: { correct: 0, wrong: 0, timeout: 0 },
  timer: null, timeLeft: 20, answered: false
};
let buzzerSession = JSON.parse(localStorage.getItem('ub_buzz_session') || '{}');
let buzzerWeak = JSON.parse(localStorage.getItem('ub_buzz_weak') || '{}');

const BUZZER_SYS = `You are an NBME-style USMLE Step 2/3 question writer. Generate {N} multiple-choice vignettes on the topic "{TOPIC}".

Each vignette MUST:
- Be intentionally vague or twisted (single subtle clue clinches it — like a real NBME stem).
- Be 3-6 sentences max (concise, exam-style).
- Have exactly 5 options (A-E) — one clearly correct, four NBME-style distractors.
- Test pattern-recognition under 20-second time pressure.

Return ONLY valid JSON:
{
  "questions": [
    {
      "stem": "the vignette + question stem",
      "options": ["A) ...", "B) ...", "C) ...", "D) ...", "E) ..."],
      "correct": "B",
      "reasoning_chain": ["Step 1: identify the cluster", "Step 2: differentiate from X", "Step 3: pick the best next step"],
      "trap": "the exact reason most students miss this — the misdirection",
      "topic_tag": "specific topic e.g. Cardio - ACS"
    }
  ]
}`;

async function buzzerStart() {
  const topic = document.getElementById('buz-topic').value.trim() || 'random Step 2/3 high-yield topic';
  const count = Math.max(3, Math.min(30, parseInt(document.getElementById('buz-count').value) || 10));
  const seconds = Math.max(10, Math.min(60, parseInt(document.getElementById('buz-seconds').value) || 20));
  if (!anyKey()) return showError('buz-err', 'Add an API key at the top first.');
  hideError('buz-err');

  const btn = document.getElementById('buz-start');
  btn.disabled = true; btn.textContent = 'Generating…';
  showSpin('buz-spin', 'Generating ' + count + ' vignettes…');

  try {
    const sys = BUZZER_SYS.replace('{N}', count).replace('{TOPIC}', topic);
    const raw = await smartCall(
      [{ role: 'system', content: sys }, { role: 'user', content: 'Generate the questions now.' }],
      true, { maxTokens: 6000, temperature: 0.4 }
    );
    const d = parseJSON(raw);
    if (!d.questions || !d.questions.length) throw new Error('No questions returned');

    buzzerState = {
      topic, count, seconds, currentIdx: 0,
      questions: d.questions, history: [],
      score: { correct: 0, wrong: 0, timeout: 0 },
      timer: null, timeLeft: seconds, answered: false
    };
    document.getElementById('buz-setup').style.display = 'none';
    document.getElementById('buz-arena').classList.add('on');
    buzzerShow();
  } catch (err) {
    showError('buz-err', err.message);
  } finally {
    btn.disabled = false; btn.textContent = '⚡ Start Drill';
    hideSpin('buz-spin');
  }
}

function buzzerShow() {
  const q = buzzerState.questions[buzzerState.currentIdx];
  if (!q) { buzzerFinish(); return; }
  buzzerState.answered = false;
  buzzerState.timeLeft = buzzerState.seconds;
  document.getElementById('buz-reveal').classList.remove('on');
  document.getElementById('buz-stem').textContent = q.stem;
  document.getElementById('buz-info-topic').textContent = q.topic_tag || buzzerState.topic;
  document.getElementById('buz-num').textContent = buzzerState.timeLeft;
  document.getElementById('buz-progress').textContent = `${buzzerState.currentIdx + 1} / ${buzzerState.questions.length}`;
  document.getElementById('buz-correct').textContent = buzzerState.score.correct;
  document.getElementById('buz-wrong').textContent = buzzerState.score.wrong;

  const opts = (q.options || []).map((opt, i) => {
    const letter = opt.match(/^[A-E]\)/) ? opt[0] : String.fromCharCode(65 + i);
    const text = opt.replace(/^[A-E]\)\s*/, '');
    return `<button class="buz-opt" id="buz-opt-${letter}" onclick="buzzerAnswer('${letter}')">
      <span class="buz-opt-letter">${letter}</span><span>${esc(text)}</span>
    </button>`;
  }).join('');
  document.getElementById('buz-options').innerHTML = opts;

  const circ = 2 * Math.PI * 38;
  const fg = document.getElementById('buz-fg');
  fg.style.strokeDasharray = circ;
  fg.style.strokeDashoffset = 0;
  fg.classList.remove('warn', 'crit');

  clearInterval(buzzerState.timer);
  const start = Date.now();
  const total = buzzerState.seconds * 1000;
  buzzerState.timer = setInterval(() => {
    const elapsed = Date.now() - start;
    const remain = Math.max(0, total - elapsed);
    buzzerState.timeLeft = Math.ceil(remain / 1000);
    document.getElementById('buz-num').textContent = buzzerState.timeLeft;
    fg.style.strokeDashoffset = circ * (elapsed / total);
    if (remain <= total * 0.25) fg.classList.add('crit');
    else if (remain <= total * 0.5) fg.classList.add('warn');
    if (remain <= 0) buzzerAnswer(null);
  }, 100);
}

function buzzerAnswer(letter) {
  if (buzzerState.answered) return;
  buzzerState.answered = true;
  clearInterval(buzzerState.timer);
  const q = buzzerState.questions[buzzerState.currentIdx];
  const correct = q.correct;

  if (letter === null) buzzerState.score.timeout++;
  else if (letter === correct) buzzerState.score.correct++;
  else buzzerState.score.wrong++;

  document.querySelectorAll('.buz-opt').forEach(b => b.disabled = true);
  if (letter && letter !== correct) {
    const btn = document.getElementById('buz-opt-' + letter);
    if (btn) btn.classList.add('no');
  }
  const ok = document.getElementById('buz-opt-' + correct);
  if (ok) ok.classList.add('ok');

  // Track weak spots
  const tag = q.topic_tag || 'general';
  if (!buzzerWeak[tag]) buzzerWeak[tag] = { seen: 0, missed: 0 };
  buzzerWeak[tag].seen++;
  if (letter !== correct) buzzerWeak[tag].missed++;
  localStorage.setItem('ub_buzz_weak', JSON.stringify(buzzerWeak));

  buzzerState.history.push({
    stem: q.stem.slice(0, 100), correct, picked: letter, topic: tag,
    result: letter === null ? 'timeout' : (letter === correct ? 'correct' : 'wrong')
  });

  document.getElementById('buz-correct').textContent = buzzerState.score.correct;
  document.getElementById('buz-wrong').textContent = buzzerState.score.wrong;

  // Show reasoning
  const chain = (q.reasoning_chain || []).map(s => `<div class="buz-chain-step">${esc(s)}</div>`).join('');
  document.getElementById('buz-reveal').innerHTML = `
    <div class="buz-chain-card">
      <div class="panel-title"><span class="dot"></span>Reasoning Chain — ${letter === correct ? '✓ correct' : letter === null ? '⏱ timeout' : '✗ wrong'}</div>
      ${chain}
      ${q.trap ? `<div class="buz-trap-box"><b>Trap:</b> ${esc(q.trap)}</div>` : ''}
      <div class="actions">
        <button class="btn" onclick="buzzerNext()">${buzzerState.currentIdx + 1 >= buzzerState.questions.length ? 'See Results →' : 'Next →'}</button>
        <button class="btn btn-ghost" onclick="buzzerSkip()">Skip Reasoning</button>
      </div>
    </div>
  `;
  document.getElementById('buz-reveal').classList.add('on');
}

function buzzerNext() {
  buzzerState.currentIdx++;
  if (buzzerState.currentIdx >= buzzerState.questions.length) buzzerFinish();
  else buzzerShow();
}
function buzzerSkip() { buzzerNext(); }
function buzzerStop() {
  clearInterval(buzzerState.timer);
  buzzerFinish();
}
function buzzerFinish() {
  clearInterval(buzzerState.timer);
  const total = buzzerState.score.correct + buzzerState.score.wrong + buzzerState.score.timeout;
  const pct = total ? Math.round((buzzerState.score.correct / total) * 100) : 0;

  // Save session
  buzzerSession = {
    topic: buzzerState.topic,
    date: new Date().toISOString(),
    score: buzzerState.score,
    history: buzzerState.history
  };
  const sessions = JSON.parse(localStorage.getItem('ub_buzz_sessions') || '[]');
  sessions.unshift(buzzerSession);
  localStorage.setItem('ub_buzz_sessions', JSON.stringify(sessions.slice(0, 30)));

  document.getElementById('buz-arena').innerHTML = `
    <div class="panel">
      <div class="mod-title" style="font-size:24px">Drill complete — ${pct}%</div>
      <div class="hint">${buzzerState.score.correct} correct · ${buzzerState.score.wrong} wrong · ${buzzerState.score.timeout} timed out</div>
      <div class="actions" style="margin-top:14px">
        <button class="btn" onclick="buzzerReset()">▶ Run Another Drill</button>
        <button class="btn btn-ghost" onclick="renderBuzzerWeak()">📊 View Weak Spots</button>
      </div>
    </div>
    <div id="buz-weak-out"></div>
  `;
  renderBuzzerWeak();
}
function buzzerReset() {
  document.getElementById('buz-arena').classList.remove('on');
  document.getElementById('buz-arena').innerHTML = '';
  document.getElementById('buz-setup').style.display = 'block';
  // Re-render arena structure for next time
  setupBuzzerArena();
}
function setupBuzzerArena() {
  // Built into HTML, only needs reset when DOM was overwritten
  if (document.getElementById('buz-stem')) return;
  document.getElementById('buz-arena').innerHTML = buzzerArenaHTML();
}
function buzzerArenaHTML() {
  return `
    <div class="buz-timer-wrap">
      <div class="buz-circle">
        <svg viewBox="0 0 88 88">
          <circle class="buz-circle-bg" cx="44" cy="44" r="38"/>
          <circle id="buz-fg" class="buz-circle-fg" cx="44" cy="44" r="38"/>
        </svg>
        <div class="buz-num" id="buz-num">20</div>
      </div>
      <div class="buz-info">
        <div class="buz-info-row">
          <span class="buz-info-tag">Topic</span>
          <span class="buz-info-topic" id="buz-info-topic">—</span>
          <span class="buz-info-tag" id="buz-progress">1 / 1</span>
        </div>
        <div class="buz-score">
          <span class="ok">✓ <b id="buz-correct">0</b></span>
          <span class="no">✗ <b id="buz-wrong">0</b></span>
          <button class="btn-mini btn-ghost" onclick="buzzerStop()" style="margin-left:auto">End Drill</button>
        </div>
      </div>
    </div>
    <div class="buz-stem" id="buz-stem"></div>
    <div class="buz-options" id="buz-options"></div>
    <div class="buz-reveal" id="buz-reveal"></div>
  `;
}
function renderBuzzerWeak() {
  const out = document.getElementById('buz-weak-out') || document.getElementById('buz-weak-anchor');
  if (!out) return;
  const entries = Object.entries(buzzerWeak)
    .map(([topic, s]) => ({ topic, ...s, missRate: s.seen ? s.missed / s.seen : 0 }))
    .sort((a, b) => b.missRate - a.missRate || b.seen - a.seen);
  if (!entries.length) { out.innerHTML = '<div class="hint">No drill history yet — run a drill to track weak spots.</div>'; return; }
  out.innerHTML = `
    <div class="panel">
      <div class="panel-title"><span class="dot"></span>Weak Spot Tracker (all-time)</div>
      <div class="weak-grid">
        ${entries.map(e => {
          const pct = Math.round(e.missRate * 100);
          const cls = pct >= 50 ? 'bad' : pct >= 25 ? 'med' : 'good';
          return `<div class="weak-card">
            <div class="weak-topic">${esc(e.topic)}</div>
            <div class="weak-stat">${e.missed} missed of ${e.seen} · ${pct}% miss rate</div>
            <div class="weak-bar"><div class="weak-bar-fill ${cls}" style="width:${pct}%"></div></div>
          </div>`;
        }).join('')}
      </div>
      <div class="actions" style="margin-top:14px">
        <button class="btn-mini btn-ghost" onclick="buzzerDrillWeak()">🎯 Drill My Worst Topic</button>
        <button class="btn-mini btn-ghost btn-warn" onclick="if(confirm('Reset weak-spot tracker?')){buzzerWeak={};localStorage.removeItem('ub_buzz_weak');renderBuzzerWeak();}">Reset Tracker</button>
      </div>
    </div>
  `;
}
function buzzerDrillWeak() {
  const entries = Object.entries(buzzerWeak)
    .map(([topic, s]) => ({ topic, ...s, missRate: s.seen ? s.missed / s.seen : 0 }))
    .filter(e => e.seen >= 2)
    .sort((a, b) => b.missRate - a.missRate);
  if (!entries.length) return alert('Need more drill data first.');
  buzzerReset();
  document.getElementById('buz-topic').value = entries[0].topic;
}

/* =========================================================
   FEATURE 3 — DISTRACTOR DISSECTOR
   ========================================================= */

const DISSECTOR_SYS = `You are an elite NBME question dissector. The student pastes a USMLE Step 2/3 question with options. Your job: explain why each WRONG answer is wrong in NBME-specific style, identify red herrings (numbers/findings the writer planted to mislead), and reveal the question writer's "trick".

Return ONLY valid JSON:
{
  "diagnosis": "the actual diagnosis being tested in 1 line",
  "correct_letter": "A",
  "correct_explanation": "1-2 sentence NBME-style reason it is correct",
  "red_herrings": ["specific item from stem that misleads", "another distractor data point"],
  "options": [
    {
      "letter": "A",
      "text": "the option text",
      "correct": true or false,
      "category": "CORRECT" or "RED_HERRING_DRIVEN" or "NEAR_MISS" or "KNOWLEDGE_GAP" or "DISTRACTOR",
      "why_wrong": "specific NBME-style reasoning — what makes this WRONG vs the correct answer",
      "would_be_correct_if": "what change in the stem would make THIS the right answer (skip if correct)"
    }
  ],
  "the_trick": "1-2 sentence summary of the writer's misdirection — what they wanted you to do vs what you should have done",
  "fix_for_next_time": "the rule to remember so you never miss this style again"
}

Categories:
- RED_HERRING_DRIVEN: option seems correct because of a red-herring number/finding the writer planted
- NEAR_MISS: clinically close but missing the discriminating feature
- KNOWLEDGE_GAP: requires fact most students don't know — recall failure
- DISTRACTOR: clearly wrong but might attract careless readers`;

async function dissectorRun() {
  const txt = document.getElementById('dis-input').value.trim();
  if (!txt) return showError('dis-err', 'Paste the full question + all answer options.');
  if (!anyKey()) return showError('dis-err', 'Add an API key at the top first.');
  hideError('dis-err');

  const btn = document.getElementById('dis-btn');
  btn.disabled = true; btn.textContent = 'Dissecting…';
  showSpin('dis-spin', 'Dissecting every distractor…');

  try {
    const raw = await smartCall(
      [{ role: 'system', content: DISSECTOR_SYS }, { role: 'user', content: txt }],
      true, { maxTokens: 4500 }
    );
    const d = parseJSON(raw);
    renderDissector(d);
  } catch (err) {
    showError('dis-err', err.message);
  } finally {
    btn.disabled = false; btn.textContent = '🔬 Dissect Distractors';
    hideSpin('dis-spin');
  }
}

function renderDissector(d) {
  const out = document.getElementById('dis-result');
  const tagFor = c => ({
    CORRECT: '', RED_HERRING_DRIVEN: 'tag-rh', NEAR_MISS: 'tag-near',
    KNOWLEDGE_GAP: 'tag-gap', DISTRACTOR: 'tag-trap'
  }[c] || 'tag-trap');
  const tagLabel = c => ({
    CORRECT: '', RED_HERRING_DRIVEN: 'Red-Herring Trap',
    NEAR_MISS: 'Near Miss', KNOWLEDGE_GAP: 'Knowledge Gap', DISTRACTOR: 'Distractor'
  }[c] || c);

  out.innerHTML = `
    <div class="panel">
      <div class="panel-title"><span class="dot"></span>Diagnosis</div>
      <div class="box-green">${esc(d.diagnosis || '')}</div>
    </div>

    ${d.red_herrings?.length ? `
      <div class="panel">
        <div class="dis-rhbox">
          <div class="dis-rhbox-title">⚠️ Red Herrings the writer planted</div>
          ${d.red_herrings.map(r => `<div class="dis-rhbox-item">• ${esc(r)}</div>`).join('')}
        </div>
      </div>
    ` : ''}

    <div class="panel">
      <div class="panel-title"><span class="dot"></span>Option-by-Option Dissection</div>
      ${(d.options || []).map(o => `
        <div class="dis-row">
          <div class="dis-letter ${o.correct ? 'ok' : 'no'}">${o.letter || '?'}</div>
          <div class="dis-content">
            <div class="dis-name">${esc(o.text || '')}</div>
            ${!o.correct && o.category ? `<span class="dis-tag ${tagFor(o.category)}">${tagLabel(o.category)}</span>` : ''}
            <div class="dis-why" style="margin-top:5px">${esc(o.correct ? (d.correct_explanation || o.why_wrong || '') : o.why_wrong || '')}</div>
            ${!o.correct && o.would_be_correct_if ? `<div class="dis-why" style="margin-top:4px;color:var(--accent2)"><b>Would be correct if:</b> ${esc(o.would_be_correct_if)}</div>` : ''}
          </div>
        </div>
      `).join('')}
    </div>

    ${d.the_trick ? `
      <div class="panel">
        <div class="dis-trick">
          <div class="dis-trick-title">🎯 The Trick</div>
          <div class="dis-trick-text">${esc(d.the_trick)}</div>
        </div>
      </div>
    ` : ''}

    ${d.fix_for_next_time ? `
      <div class="panel">
        <div class="panel-title"><span class="dot"></span>Fix for Next Time</div>
        <div class="box-green">${esc(d.fix_for_next_time)}</div>
      </div>
    ` : ''}
  `;
  out.style.display = 'block';
}

/* =========================================================
   FEATURE 4 — RECENT BLOCK PATTERN MINER
   ========================================================= */

const MINER_SYS = `You are an elite USMLE Step 2/3 performance analyst. The student pastes data from their last several Qbank blocks (could be: a list of missed topics, a screenshot's text dump, or detailed per-question performance with topic/time/answer info).

Your job:
1. Identify the TOP 5-8 weak topics they keep missing.
2. For each, classify the miss-type as KNOWLEDGE_GAP | DISTRACTOR_TRAP | TIME_PRESSURE | PATTERN_RECOGNITION_FAIL.
3. Write the specific reason and a one-line FIX.
4. Generate 5 NEW NBME-style questions targeted at the WORST patterns.

Return ONLY valid JSON:
{
  "summary": "1-2 sentence overview of their main failure mode",
  "weak_topics": [
    {
      "topic": "specific topic e.g. ACS - NSTEMI vs UA",
      "miss_count": 3,
      "miss_type": "KNOWLEDGE_GAP" | "DISTRACTOR_TRAP" | "TIME_PRESSURE" | "PATTERN_RECOGNITION_FAIL",
      "why": "specific reasoning — what is breaking",
      "fix": "1-line actionable fix"
    }
  ],
  "targeted_questions": [
    {
      "stem": "vignette + question",
      "options": ["A) ...", "B) ...", "C) ...", "D) ...", "E) ..."],
      "correct": "C",
      "tests_pattern": "exact weak pattern this Q tests",
      "explanation": "1-2 line answer explanation"
    }
  ]
}`;

async function minerRun() {
  const txt = document.getElementById('miner-input').value.trim();
  if (!txt) return showError('miner-err', 'Paste your block performance data — missed topics, scores by system, or per-question dump.');
  if (!anyKey()) return showError('miner-err', 'Add an API key at the top first.');
  hideError('miner-err');

  const btn = document.getElementById('miner-btn');
  btn.disabled = true; btn.textContent = 'Mining…';
  showSpin('miner-spin', 'Mining your weak patterns…');

  try {
    const raw = await smartCall(
      [{ role: 'system', content: MINER_SYS }, { role: 'user', content: txt.slice(0, 12000) }],
      true, { maxTokens: 6000 }
    );
    const d = parseJSON(raw);
    renderMiner(d);
  } catch (err) {
    showError('miner-err', err.message);
  } finally {
    btn.disabled = false; btn.textContent = '⛏️ Mine Weak Patterns';
    hideSpin('miner-spin');
  }
}

function renderMiner(d) {
  const out = document.getElementById('miner-result');
  const mtClass = t => ({
    KNOWLEDGE_GAP: 'mt-knowledge', DISTRACTOR_TRAP: 'mt-distractor',
    TIME_PRESSURE: 'mt-time', PATTERN_RECOGNITION_FAIL: 'mt-pattern'
  }[t] || 'mt-knowledge');
  const mtLabel = t => ({
    KNOWLEDGE_GAP: 'Knowledge Gap', DISTRACTOR_TRAP: 'Distractor Trap',
    TIME_PRESSURE: 'Time Pressure', PATTERN_RECOGNITION_FAIL: 'Pattern Fail'
  }[t] || t);

  out.innerHTML = `
    <div class="miner-summary">${esc(d.summary || '')}</div>

    <div class="panel">
      <div class="panel-title"><span class="dot"></span>Weak Topics — ranked</div>
      ${(d.weak_topics || []).map(t => `
        <div class="miner-row">
          <div class="miner-row-head">
            <span class="miner-topic">${esc(t.topic)}</span>
            <span class="miner-misstype ${mtClass(t.miss_type)}">${mtLabel(t.miss_type)} · ${t.miss_count || 0}×</span>
          </div>
          <div class="miner-why">${esc(t.why || '')}</div>
          <div class="miner-fix"><b>Fix:</b> ${esc(t.fix || '')}</div>
        </div>
      `).join('')}
    </div>

    <div class="panel">
      <div class="panel-title"><span class="dot"></span>5 Targeted Questions on Your Weakest Patterns</div>
      ${(d.targeted_questions || []).map((q, i) => `
        <div class="miner-q">
          <div class="miner-q-tag">Q${i + 1} · tests: ${esc(q.tests_pattern || '')}</div>
          <div class="miner-q-stem">${esc(q.stem || '')}</div>
          <div class="miner-q-opts">
            ${(q.options || []).map(opt => {
              const letter = opt.match(/^[A-E]\)/) ? opt[0] : '?';
              const text = opt.replace(/^[A-E]\)\s*/, '');
              return `<button class="miner-q-opt" onclick="minerCheck(this,'${letter}','${escAttr(q.correct)}','${escAttr(q.explanation)}',${i})">${esc(letter)}) ${esc(text)}</button>`;
            }).join('')}
          </div>
          <div id="miner-exp-${i}"></div>
        </div>
      `).join('')}
    </div>
  `;
  out.style.display = 'block';
}

function minerCheck(btn, picked, correct, explanation, idx) {
  // Disable all sibling options
  const parent = btn.parentElement;
  parent.querySelectorAll('.miner-q-opt').forEach(b => {
    b.disabled = true;
    const l = b.textContent.trim()[0];
    if (l === correct) b.classList.add('ok');
    else if (l === picked && picked !== correct) b.classList.add('no');
  });
  document.getElementById('miner-exp-' + idx).innerHTML =
    `<div class="miner-fix" style="margin-top:6px"><b>${picked === correct ? '✓ Correct' : '✗ Correct: ' + correct}.</b> ${esc(explanation)}</div>`;
}

/* =========================================================
   FEATURE 5 — STEP 2 ORACLE (PDF → Flash Vignettes)
   ========================================================= */

const ORACLE_SYS = `You are the Step 2 Oracle. Convert dense review-book text (First Aid / Step Up / OnlineMedEd / lecture notes) into NBME-style 4-line flash vignettes you can drill in 20 seconds.

For each clinically distinct concept in the input, produce a vignette where:
- Line 1: Demographics + chief complaint
- Line 2: Key history + most relevant exam finding
- Line 3: Critical lab/imaging clue (one decisive data point)
- Line 4: Question stem ("Most likely diagnosis?" or "Best next step?")

Each vignette must have:
- 5 answer options (A-E), one correct, four NBME-style distractors
- The concept (1-line) so the student knows what topic it tests

Skip filler. Only extract clinically distinct, exam-relevant concepts. Aim for 5-25 vignettes per input.

Return ONLY valid JSON:
{
  "vignettes": [
    {
      "stem": "the 4-line vignette joined with newlines, ending in a question",
      "options": ["A) ...", "B) ...", "C) ...", "D) ...", "E) ..."],
      "correct": "B",
      "concept": "what core concept this tests"
    }
  ]
}`;

let oracleVignettes = [];

async function oracleOnFile(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  showSpin('oracle-spin', 'Reading file…');
  try {
    let text = document.getElementById('oracle-input').value || '';
    for (const f of files) {
      if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        const t = await readPDF(f);
        text += '\n\n=== ' + f.name + ' ===\n\n' + t;
      } else if (f.type.startsWith('text/')) {
        text += '\n\n=== ' + f.name + ' ===\n\n' + await f.text();
      }
    }
    document.getElementById('oracle-input').value = text.trim();
  } catch (err) {
    showError('oracle-err', 'File read error: ' + err.message);
  } finally {
    hideSpin('oracle-spin');
    e.target.value = '';
  }
}

async function oracleRun() {
  const txt = document.getElementById('oracle-input').value.trim();
  if (!txt) return showError('oracle-err', 'Upload a PDF or paste review-book text.');
  if (!anyKey()) return showError('oracle-err', 'Add an API key at the top first.');
  hideError('oracle-err');

  const btn = document.getElementById('oracle-btn');
  btn.disabled = true; btn.textContent = 'Converting…';
  showSpin('oracle-spin', 'Forging flash vignettes…');

  try {
    const raw = await smartCall(
      [{ role: 'system', content: ORACLE_SYS }, { role: 'user', content: txt.slice(0, 14000) }],
      true, { maxTokens: 6500, temperature: 0.3 }
    );
    const d = parseJSON(raw);
    oracleVignettes = d.vignettes || [];
    renderOracle();
  } catch (err) {
    showError('oracle-err', err.message);
  } finally {
    btn.disabled = false; btn.textContent = '✨ Convert to Flash Vignettes';
    hideSpin('oracle-spin');
  }
}

function renderOracle() {
  const out = document.getElementById('oracle-result');
  if (!oracleVignettes.length) {
    out.innerHTML = '<div class="hint">No vignettes generated.</div>';
    out.style.display = 'block';
    return;
  }
  out.innerHTML = `
    <div class="pat-stats" style="margin-bottom:12px">
      <div class="stat-pill"><b>${oracleVignettes.length}</b> flash vignettes</div>
      <button class="btn-mini btn-ghost" onclick="oracleStartDrill()">⏱ Drill Them in Buzzer →</button>
      <button class="btn-mini btn-ghost" onclick="oracleExport()">📥 Export</button>
    </div>
    ${oracleVignettes.map((v, i) => `
      <div class="oracle-vignette">
        <div class="oracle-num">Vignette ${i + 1}</div>
        <div class="oracle-stem">${esc(v.stem || '')}</div>
        <div class="oracle-opts">
          ${(v.options || []).map(opt => {
            const letter = opt.match(/^[A-E]\)/) ? opt[0] : '?';
            const text = opt.replace(/^[A-E]\)\s*/, '');
            return `<button class="oracle-opt" onclick="oracleCheck(this,'${letter}','${escAttr(v.correct)}',${i})">${esc(letter)}) ${esc(text)}</button>`;
          }).join('')}
        </div>
        <div id="oracle-exp-${i}"></div>
        ${v.concept ? `<div class="oracle-concept"><b>Tests:</b> ${esc(v.concept)}</div>` : ''}
      </div>
    `).join('')}
  `;
  out.style.display = 'block';
}

function oracleCheck(btn, picked, correct, idx) {
  const parent = btn.parentElement;
  parent.querySelectorAll('.oracle-opt').forEach(b => {
    b.disabled = true;
    const l = b.textContent.trim()[0];
    if (l === correct) b.classList.add('ok');
    else if (l === picked && picked !== correct) b.classList.add('no');
  });
  document.getElementById('oracle-exp-' + idx).innerHTML =
    `<div class="miner-fix" style="margin-top:6px"><b>${picked === correct ? '✓' : '✗'}</b> Correct answer: ${correct}.</div>`;
}

function oracleStartDrill() {
  if (!oracleVignettes.length) return;
  // Push into buzzer queue
  buzzerState = {
    topic: 'Oracle vignettes',
    count: oracleVignettes.length,
    seconds: 20,
    currentIdx: 0,
    questions: oracleVignettes.map(v => ({
      stem: v.stem, options: v.options, correct: v.correct,
      reasoning_chain: ['Concept tested: ' + (v.concept || '')],
      trap: '', topic_tag: v.concept || 'Oracle'
    })),
    history: [], score: { correct: 0, wrong: 0, timeout: 0 },
    timer: null, timeLeft: 20, answered: false
  };
  switchModule('buzzer');
  document.getElementById('buz-setup').style.display = 'none';
  document.getElementById('buz-arena').classList.add('on');
  setupBuzzerArena();
  buzzerShow();
}

function oracleExport() {
  const txt = oracleVignettes.map((v, i) =>
    `Vignette ${i + 1}\n${v.stem}\n${(v.options || []).join('\n')}\nAnswer: ${v.correct}\nConcept: ${v.concept || ''}\n`
  ).join('\n---\n');
  const blob = new Blob([txt], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'oracle-vignettes.txt'; a.click();
  URL.revokeObjectURL(url);
}

/* =========================================================
   FEATURE 6 — STATS TWIST DECODER
   ========================================================= */

const STATS_SYS = `You are an elite USMLE biostat decoder. The student pastes a stats question (NNT / NNH / sensitivity / specificity / PPV / NPV / likelihood ratio / RRR / ARR / odds ratio / relative risk). Boards plant red-herring numbers — your job is the 10-second solve.

Return ONLY valid JSON:
{
  "stat_type": "NNT" | "Sensitivity" | "Specificity" | "PPV" | "NPV" | "LR+" | "LR-" | "RR" | "ARR" | "RRR" | "OR" | "Other",
  "two_by_two": {
    "TP": 12, "FP": 8, "FN": 3, "TN": 77,
    "labels": { "row1": "Disease+", "row2": "Disease-", "col1": "Test+", "col2": "Test-" }
  },
  "template_steps": [
    "Step 1: Identify which numbers go where in the 2x2 (skip values not needed for this stat)",
    "Step 2: Apply formula — e.g. Sens = TP/(TP+FN)",
    "Step 3: Compute under 10 seconds"
  ],
  "formula": "the exact formula in plain text",
  "answer": "the numeric answer with units e.g. 0.80 (80%) or NNT = 25",
  "red_herrings": ["specific number from stem that does NOT belong in the formula", "another distractor data point"],
  "memorize": "ONE memorable rule of thumb for this stat type — make it stick"
}

If a 2x2 doesn't apply (e.g. for NNT the data may already be event rates), set two_by_two to null and use template_steps to do the calculation directly.`;

async function statsRun() {
  const txt = document.getElementById('stats-input').value.trim();
  if (!txt) return showError('stats-err', 'Paste the biostat question (with all numbers).');
  if (!anyKey()) return showError('stats-err', 'Add an API key at the top first.');
  hideError('stats-err');

  const btn = document.getElementById('stats-btn');
  btn.disabled = true; btn.textContent = 'Decoding…';
  showSpin('stats-spin', 'Decoding the twist…');

  // Start a timer for time-pressure simulation
  const timerEl = document.getElementById('stats-timer');
  if (timerEl) {
    let t = 0;
    timerEl.textContent = '0.0s';
    const start = Date.now();
    timerEl._int = setInterval(() => {
      t = (Date.now() - start) / 1000;
      timerEl.textContent = t.toFixed(1) + 's';
    }, 100);
  }

  try {
    const raw = await smartCall(
      [{ role: 'system', content: STATS_SYS }, { role: 'user', content: txt }],
      true, { maxTokens: 3000 }
    );
    const d = parseJSON(raw);
    renderStats(d);
  } catch (err) {
    showError('stats-err', err.message);
  } finally {
    btn.disabled = false; btn.textContent = '🧮 Decode';
    hideSpin('stats-spin');
    if (timerEl?._int) clearInterval(timerEl._int);
  }
}

function renderStats(d) {
  const out = document.getElementById('stats-result');
  let twoBy = '';
  if (d.two_by_two && typeof d.two_by_two === 'object') {
    const t = d.two_by_two;
    const L = t.labels || {};
    twoBy = `
      <div class="stats-2x2">
        <div class="h"></div>
        <div class="h">${esc(L.col1 || 'Test+')}</div>
        <div class="h">${esc(L.col2 || 'Test-')}</div>
        <div class="h">${esc(L.row1 || 'Disease+')}</div>
        <div class="v">TP: ${t.TP ?? '—'}</div>
        <div class="v">FN: ${t.FN ?? '—'}</div>
        <div class="h">${esc(L.row2 || 'Disease-')}</div>
        <div class="v">FP: ${t.FP ?? '—'}</div>
        <div class="v">TN: ${t.TN ?? '—'}</div>
      </div>
    `;
  }

  out.innerHTML = `
    <span class="stats-type">${esc(d.stat_type || 'Stats')}</span>
    ${twoBy}
    ${d.formula ? `<div class="hint" style="font-family:'JetBrains Mono',monospace;font-size:13px;color:var(--accent2);background:var(--surface);padding:10px 13px;border-radius:6px;border:1px solid var(--border);margin:8px 0">${esc(d.formula)}</div>` : ''}

    <div class="stats-template">
      <div class="stats-template-title">⏱ 10-Second Solve Template</div>
      ${(d.template_steps || []).map((s, i) => `<div class="stats-template-step"><b>${i + 1}.</b> ${esc(s)}</div>`).join('')}
    </div>

    <div class="stats-answer">
      <div>
        <div class="stats-ans-label">Answer</div>
        <div class="stats-ans-val">${esc(d.answer || '—')}</div>
      </div>
    </div>

    ${d.red_herrings?.length ? `
      <div class="stats-rh">
        <div class="stats-rh-title">⚠️ Red Herrings — numbers you should ignore</div>
        ${d.red_herrings.map(r => `<div class="stats-rh-item">• ${esc(r)}</div>`).join('')}
      </div>
    ` : ''}

    ${d.memorize ? `<div class="stats-memo"><b>Memorize:</b> ${esc(d.memorize)}</div>` : ''}
  `;
  out.style.display = 'block';
}

/* =========================================================
   ANALYZER (existing — preserved with chat & magic actions)
   ========================================================= */

const ANALYZER_SYS = `You are an elite USMLE Step 1/2/3 tutor. Analyze this MCQ and return ONLY a JSON object with these exact keys:
{
  "trap_detector": "2-3 sentences on the main trap/twist in the stem",
  "trap_they_want": "exact wrong answer they want and WHY students pick it",
  "options": [{"letter":"A","name":"text","correct":true,"oneliner":"why correct/wrong"}],
  "teaching_point": "core concept 3-4 sentences",
  "cheat_code": "single most important exam-day shortcut",
  "axiom": "if...then golden rule",
  "mnemonic": {"word":"WORD","breakdown":["W - meaning","O - meaning"]},
  "ddx": [{"name":"Condition","distinguishing":"key feature"}],
  "subtype_concept": [{"name":"Subtype","key_difference":"what makes it distinct"}],
  "scorer_280": [
    {"if_you_see":["clue1","clue2","clue3"],"then_answer":"option text","confidence":"95% on boards","reasoning":"why these clues = this answer"}
  ],
  "similar_concepts": [
    {"name":"Condition","why_confused":"reason students confuse it","key_difference":"the discriminating finding","trap_level":"HIGH|MEDIUM|LOW","distinguishing_features":["buzz1","buzz2"],"boards_tip":"sharp tip"}
  ],
  "tutor_questions": [{"question":"q","options":["A","B","C","D"],"answer_index":0,"explanation":"why"}]
}
Generate one scorer_280 pattern PER answer option. Make 5-8 similar_concepts and 3-5 tutor_questions.`;

function onImgFile(e) { const f = e.target.files[0]; if (f) loadImg(f); }
function dzOver(e) { e.preventDefault(); document.getElementById('dz').classList.add('over'); }
function dzLeave(e) { e.preventDefault(); document.getElementById('dz').classList.remove('over'); }
function dzDrop(e) { e.preventDefault(); document.getElementById('dz').classList.remove('over'); const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) loadImg(f); }
function loadImg(f) {
  imgMime = f.type;
  const r = new FileReader();
  r.onload = ev => {
    imgB64 = ev.target.result.split(',')[1];
    document.getElementById('dzimg').src = ev.target.result;
    document.getElementById('dz-def').style.display = 'none';
    document.getElementById('dz-prev').style.display = 'flex';
    document.getElementById('dz').classList.add('has');
  };
  r.readAsDataURL(f);
}
function rmImg(e) {
  if (e) e.stopPropagation();
  imgB64 = null; imgMime = null;
  const img = document.getElementById('dzimg'); if (img) img.src = '';
  const file = document.getElementById('imgfile'); if (file) file.value = '';
  const def = document.getElementById('dz-def'); if (def) def.style.display = 'block';
  const prev = document.getElementById('dz-prev'); if (prev) prev.style.display = 'none';
  const dz = document.getElementById('dz'); if (dz) dz.classList.remove('has');
}
function clearAll() {
  document.getElementById('qinput').value = '';
  rmImg();
  document.getElementById('az-result').style.display = 'none';
  document.getElementById('az-ph').style.display = 'flex';
  document.getElementById('az-err').classList.remove('show');
  analysis = null; resetChat();
}

async function analyzerRun() {
  const qt = document.getElementById('qinput').value.trim();
  if (!qt && !imgB64) return showError('az-err', 'Paste a question or upload a screenshot.');
  if (!anyKey()) return showError('az-err', 'Add an API key at the top first.');
  hideError('az-err');

  const btn = document.getElementById('az-btn');
  btn.disabled = true; btn.textContent = 'Analyzing…';
  document.getElementById('az-result').style.display = 'none';
  document.getElementById('az-ph').style.display = 'none';
  showSpin('az-spin', 'Analyzing your question…');

  try {
    let qtext = qt;
    if (imgB64) {
      const t = document.querySelector('#az-spin .spin-txt'); if (t) t.textContent = 'Reading screenshot…';
      const extracted = await smartVision(imgB64, imgMime, 'You are reading a USMLE medical exam question from an image. Extract and transcribe ALL text exactly as it appears — full stem, lab values, all answer choices A-E. Return only the extracted text.');
      qtext = (qt ? qt + '\n\n' : '') + extracted;
      const t2 = document.querySelector('#az-spin .spin-txt'); if (t2) t2.textContent = 'Analyzing question…';
    }
    const raw = await smartCall([{ role: 'system', content: ANALYZER_SYS }, { role: 'user', content: qtext }], true, { maxTokens: 5000 });
    const d = parseJSON(raw);
    analysis = d; analysis.qtext = qtext.slice(0, 200);
    renderAnalyzer(d);
    setupChat(d);
  } catch (err) {
    showError('az-err', err.message);
  } finally {
    btn.disabled = false; btn.textContent = '⚡ Analyze';
    hideSpin('az-spin');
  }
}

function renderAnalyzer(d) {
  let h = `<div class="tabs">
    <button class="tab on" onclick="azShowTab('bd',this)">🔍 Breakdown</button>
    <button class="tab" onclick="azShowTab('sc',this)">🎯 280 Scorer</button>
    <button class="tab" onclick="azShowTab('sim',this)">🔀 Similar</button>
    <button class="tab" onclick="azShowTab('mn',this)">🧩 Mnemonic</button>
    <button class="tab" onclick="azShowTab('tq',this)">🧑‍🏫 Quiz</button>
    <button class="tab" onclick="azShowTab('ar',this)">🔁 Active Recall</button>
  </div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">
    <button onclick="magicAction('eli5')" class="btn-mini" style="background:var(--yellow-bg);border:1px solid rgba(251,209,75,.3);color:var(--yellow);font-weight:600">🧒 ELI5</button>
    <button onclick="magicAction('anki')" class="btn-mini" style="background:var(--teal-bg);border:1px solid rgba(45,212,191,.3);color:var(--teal);font-weight:600">📇 Anki Card</button>
    <button onclick="magicAction('oneliner')" class="btn-mini" style="background:var(--green-bg);border:1px solid rgba(74,222,128,.3);color:var(--green);font-weight:600">⚡ 1-Line Summary</button>
    <button onclick="magicAction('pimp')" class="btn-mini" style="background:var(--pink-bg);border:1px solid rgba(244,114,182,.3);color:var(--pink);font-weight:600">🩺 PIMP Me</button>
    <button onclick="magicAction('harder')" class="btn-mini" style="background:var(--accent-bg);border:1px solid rgba(124,111,224,.3);color:var(--accent2);font-weight:600">🔥 Harder</button>
    <button onclick="magicAction('patient')" class="btn-mini" style="background:var(--orange-bg);border:1px solid rgba(251,146,60,.3);color:var(--orange);font-weight:600">👨‍⚕️ Patient</button>
  </div>`;

  // BREAKDOWN
  h += `<div class="tc on" id="tc-bd">`;
  h += card('var(--red-bg)', '🪤', 'var(--red)', 'Trap Detector', `<div class="box-red">${esc(d.trap_detector || '')}</div>`);
  h += card('var(--red-bg)', '😈', 'var(--red)', 'Trap They Want You To Pick', `<div class="box-red">${esc(d.trap_they_want || '')}</div>`);
  if (d.options?.length) {
    let o = '';
    d.options.forEach(x => { o += `<div class="opt-item"><div class="opt-badge ${x.correct ? 'ok' : 'no'}">${x.correct ? '✓' : '✗'}</div><div><div class="opt-name">${esc(x.letter ? x.letter + ') ' : '')}${esc(x.name || '')}</div><div class="opt-line">${esc(x.oneliner || '')}</div></div></div>`; });
    h += card('var(--accent-bg)', '📋', 'var(--accent2)', 'Option Breakdown', o);
  }
  h += card('var(--green-bg)', '🎯', 'var(--green)', 'Teaching Point', `<div class="box-green">${esc(d.teaching_point || '')}</div>`);
  h += card('var(--green-bg)', '⚡', 'var(--green)', 'Cheat Code', `<div class="box-green">${esc(d.cheat_code || '')}</div>`);
  h += card('var(--pink-bg)', '💡', 'var(--pink)', 'Axiom', `<div class="box-pink">${esc(d.axiom || '')}</div>`);
  if (d.ddx?.length) { let x = ''; d.ddx.forEach(r => { x += `<div class="ddx-row"><div class="ddx-name">${esc(r.name || '')}</div><div class="ddx-desc">${esc(r.distinguishing || '')}</div></div>`; }); h += card('var(--teal-bg)', '🩺', 'var(--teal)', 'Differential', x); }
  if (d.subtype_concept?.length) { let x = ''; d.subtype_concept.forEach(r => { x += `<div class="sub-row"><div class="sub-name">${esc(r.name || '')}</div><div class="sub-desc">${esc(r.key_difference || '')}</div></div>`; }); h += card('var(--orange-bg)', '🔬', 'var(--orange)', 'Subtypes', x); }
  h += `</div>`;

  // 280 Scorer
  h += `<div class="tc" id="tc-sc">`;
  (d.scorer_280 || []).forEach((s, i) => {
    h += `<div class="sc-card"><div class="sc-head"><span class="sc-badge">PATTERN #${i + 1}</span><span class="sc-conf">${esc(s.confidence || '')}</span></div><div class="sc-body"><div class="sc-if">If you see →</div><div class="sc-clues">${(s.if_you_see || []).map((c, j) => `<span class="sc-clue">${esc(c)}</span>${j < (s.if_you_see.length - 1) ? '<span class="sc-plus">+</span>' : ''}`).join('')}<span class="sc-arr">→</span><span class="sc-ans">✓ ${esc(s.then_answer || '')}</span></div><div class="sc-why">${esc(s.reasoning || '')}</div></div></div>`;
  });
  h += `</div>`;

  // Similar
  h += `<div class="tc" id="tc-sim"><div class="card"><div class="card-head"><div class="card-icon" style="background:var(--blue-bg)">🔀</div><div class="card-title" style="color:var(--blue)">Concepts That Will Trick You</div></div>`;
  (d.similar_concepts || []).forEach(s => {
    const tc = s.trap_level === 'HIGH' ? 'var(--red)' : s.trap_level === 'MEDIUM' ? 'var(--yellow)' : 'var(--green)';
    const feats = (s.distinguishing_features || []).map(f => `<span style="font-size:11px;padding:2px 7px;background:var(--blue-bg);border:1px solid rgba(96,165,250,.2);border-radius:4px;color:var(--blue)">${esc(f)}</span>`).join('');
    h += `<div class="sim-card"><div class="sim-name">${esc(s.name || '')}<span class="sim-tbadge" style="color:${tc};border:1px solid ${tc};background:${tc}15">${esc(s.trap_level || '')}</span></div><div class="sim-why">⚠️ ${esc(s.why_confused || '')}</div><div class="sim-diff"><b>Key diff:</b> ${esc(s.key_difference || '')}</div>${feats ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px">${feats}</div>` : ''}${s.boards_tip ? `<div style="font-size:11px;color:var(--green);margin-top:6px">💡 ${esc(s.boards_tip)}</div>` : ''}</div>`;
  });
  h += `</div></div>`;

  // Mnemonic
  h += `<div class="tc" id="tc-mn">`;
  if (d.mnemonic) {
    const rows = (d.mnemonic.breakdown || []).map(line => {
      const idx = line.indexOf(' - ');
      if (idx > -1) { const l = line.substring(0, idx).trim(), m = line.substring(idx + 3); return `<div class="mnrow"><div class="mnletter">${esc(l)}</div><div class="mnmeaning"><b>${esc(l)}</b> — ${esc(m)}</div></div>`; }
      return `<div class="mnrow"><div class="mnmeaning">${esc(line)}</div></div>`;
    }).join('');
    h += `<div class="card" style="padding:0;overflow:hidden"><div class="mncard"><div class="mnhead"><div class="mnword">${esc(d.mnemonic.word || '')}</div><div class="mnsub">High-yield mnemonic</div></div><div class="mnbody">${rows}</div></div></div>`;
  }
  h += `</div>`;

  // Quiz
  h += `<div class="tc" id="tc-tq"><div class="card"><div class="card-head"><div class="card-icon" style="background:var(--accent-bg)">🧑‍🏫</div><div class="card-title" style="color:var(--accent2)">Tutor Quiz</div></div>`;
  (d.tutor_questions || []).forEach((q, qi) => {
    const opts = (q.options || []).map((o, oi) => `<button class="tq-opt" onclick="checkTQ(${qi},${oi},${q.answer_index},'${escAttr(q.explanation)}')">${esc(o)}</button>`).join('');
    h += `<div class="tq-card"><div class="tq-label">Q${qi + 1} of ${d.tutor_questions.length}</div><div class="tq-q">${esc(q.question || '')}</div><div class="tq-opts" id="tqo-${qi}">${opts}</div><div class="tq-exp" id="tqe-${qi}"></div></div>`;
  });
  h += `</div></div>`;

  // Active Recall
  h += `<div class="tc" id="tc-ar"><div class="card"><div class="card-head"><div class="card-icon" style="background:var(--pink-bg)">🔁</div><div class="card-title" style="color:var(--pink)">Active Recall</div></div><div id="arcontent"><div style="text-align:center;padding:8px 0 14px"><div style="font-size:13px;color:var(--muted);margin-bottom:12px;line-height:1.6">Generate Step 1, 2 & 3 lead-in questions on this topic.</div><button class="ar-genbtn" id="argenbtn" onclick="genAR()">⚡ Generate Active Recall</button></div></div></div></div>`;

  const el = document.getElementById('az-result');
  el.innerHTML = h; el.style.display = 'block';
}

function card(ibg, icon, tc, title, content) {
  return `<div class="card"><div class="card-head"><div class="card-icon" style="background:${ibg}">${icon}</div><div class="card-title" style="color:${tc}">${title}</div></div>${content}</div>`;
}
function azShowTab(id, btn) {
  document.querySelectorAll('#az-result .tc').forEach(t => t.classList.remove('on'));
  document.querySelectorAll('#az-result .tab').forEach(b => b.classList.remove('on'));
  document.getElementById('tc-' + id).classList.add('on'); btn.classList.add('on');
}
function checkTQ(qi, sel, correct, exp) {
  document.querySelectorAll(`#tqo-${qi} .tq-opt`).forEach((b, i) => { b.disabled = true; if (i === correct) b.classList.add('ok'); else if (i === sel && sel !== correct) b.classList.add('no'); });
  const e = document.getElementById(`tqe-${qi}`); e.style.display = 'block'; e.textContent = (sel === correct ? '✓ Correct! ' : '✗ Wrong. ') + exp;
}

async function genAR() {
  const btn = document.getElementById('argenbtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Generating…'; }
  const topic = analysis?.teaching_point || analysis?.qtext || 'this medical topic';
  const prompt = `Generate active-recall questions for: ${topic}\n\nReturn ONLY JSON:
{"illness_script":"2-sentence summary","step1":[{"question":"step1 angle","answer":"answer","trap":"trap"}],"step2":[...],"step3":[...],"all_steps":[...]}
4 questions per array. Board-focused.`;
  try {
    const raw = await smartCall([{ role: 'system', content: 'USMLE question writer. JSON only.' }, { role: 'user', content: prompt }], true, { maxTokens: 4000 });
    const ar = parseJSON(raw);
    renderAR(ar);
  } catch (err) {
    document.getElementById('arcontent').innerHTML = `<div style="color:var(--red);font-size:13px;padding:12px">${esc(err.message)}</div><button class="ar-genbtn" onclick="genAR()">Retry</button>`;
  }
}
function renderAR(ar) {
  const total = (ar.step1?.length || 0) + (ar.step2?.length || 0) + (ar.step3?.length || 0) + (ar.all_steps?.length || 0);
  window._arTotal = total; window._arDone = 0;
  let h = `<div class="ar-script"><div class="ar-script-label">📋 Illness Script</div><div class="ar-script-text">${esc(ar.illness_script || '')}</div></div>`;
  h += `<div class="ar-prow"><div class="ar-pbar-wrap"><div class="ar-pbar" id="arpbar"></div></div><div class="ar-ptxt" id="arptxt">0 / ${total} revealed</div></div>`;
  h += `<div class="ar-stabs">
    <button class="ar-stab tall on" onclick="showAR('all',this)">⭐ All (${ar.all_steps?.length || 0})</button>
    <button class="ar-stab ts1" onclick="showAR('s1',this)">Step 1 (${ar.step1?.length || 0})</button>
    <button class="ar-stab ts2" onclick="showAR('s2',this)">Step 2 (${ar.step2?.length || 0})</button>
    <button class="ar-stab ts3" onclick="showAR('s3',this)">Step 3 (${ar.step3?.length || 0})</button>
  </div>`;
  h += `<div class="ar-sec on" id="ars-all">${buildARQs(ar.all_steps || [], 'sa')}</div>`;
  h += `<div class="ar-sec" id="ars-s1">${buildARQs(ar.step1 || [], 's1')}</div>`;
  h += `<div class="ar-sec" id="ars-s2">${buildARQs(ar.step2 || [], 's2')}</div>`;
  h += `<div class="ar-sec" id="ars-s3">${buildARQs(ar.step3 || [], 's3')}</div>`;
  document.getElementById('arcontent').innerHTML = h;
}
function buildARQs(qs, cls) {
  if (!qs.length) return `<div style="color:var(--muted);font-size:13px;text-align:center;padding:12px">None</div>`;
  return qs.map((q, i) => {
    const uid = `arq-${cls}-${i}`;
    return `<div class="ar-qcard" id="${uid}"><div class="ar-qhead" onclick="toggleAR('${uid}')"><div class="ar-qnum ${cls}">${i + 1}</div><div class="ar-qtxt">${esc(q.question || '')}</div><div class="ar-chev">▼</div></div><div class="ar-qbody"><div class="ar-ans-label">Answer</div><div class="ar-ans">${esc(q.answer || '')}</div>${q.trap ? `<div class="ar-trap">⚠️ Trap: ${esc(q.trap)}</div>` : ''}</div></div>`;
  }).join('');
}
function toggleAR(uid) {
  const c = document.getElementById(uid);
  const wasOpen = c.classList.contains('open');
  c.classList.toggle('open');
  if (!wasOpen) {
    window._arDone = (window._arDone || 0) + 1;
    const pct = Math.min(100, Math.round(window._arDone / window._arTotal * 100));
    const pb = document.getElementById('arpbar'); const pt = document.getElementById('arptxt');
    if (pb) pb.style.width = pct + '%'; if (pt) pt.textContent = `${window._arDone} / ${window._arTotal} revealed`;
  }
}
function showAR(id, btn) {
  document.querySelectorAll('.ar-sec').forEach(s => s.classList.remove('on'));
  document.querySelectorAll('.ar-stab').forEach(b => b.classList.remove('on'));
  document.getElementById('ars-' + id).classList.add('on'); btn.classList.add('on');
}

// CHAT
function setupChat(d) {
  resetChat();
  addMsg('ai', 'Question analyzed! Ask me anything or switch to Tutor mode 🎯');
  const suggs = ['Why is this the answer and not the most common wrong choice?', 'How would the vignette change to make a different answer correct?', 'Give me a one-line summary I can drop in Anki', 'What are the must-know facts for boards on this topic?'];
  document.getElementById('suggbox').style.display = 'block';
  document.getElementById('sugglist').innerHTML = suggs.map(q => `<button class="suggbtn" onclick="sendSugg('${escAttr(q)}')">${esc(q)}</button>`).join('');
}
function setMode(m) {
  chatMode = m;
  document.getElementById('mfree').classList.toggle('on', m === 'free');
  document.getElementById('mtutor').classList.toggle('on', m === 'tutor');
  if (m === 'tutor' && analysis) { addMsg('sys', 'Tutor mode ON 🩺'); addMsg('ai', `What ONE finding in the stem clinched the diagnosis?`); }
}
function resetChat() { chatHist = []; document.getElementById('msgs').innerHTML = '<div class="msg sys">Analyze a question to start 🎯</div>'; document.getElementById('suggbox').style.display = 'none'; }
function addMsg(type, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + type;
  if (type === 'ai') {
    let html = (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/^[-•] (.+)/gm, '<span style="display:block;padding-left:8px">• $1</span>')
      .replace(/\n/g, '<br>');
    el.innerHTML = html;
  } else el.textContent = text;
  const msgs = document.getElementById('msgs');
  msgs.appendChild(el);
  msgs.scrollTop = 99999;
}
function sendSugg(q) { document.getElementById('ctxt').value = q; sendChat(); }
async function sendChat() {
  const inp = document.getElementById('ctxt');
  const text = inp.value.trim(); if (!text) return; inp.value = ''; addMsg('user', text);
  const ctx = analysis
    ? `You are an elite USMLE tutor. Teaching point: ${analysis.teaching_point || ''}. Cheat code: ${analysis.cheat_code || ''}. Key trap: ${analysis.trap_detector || ''}. Answer concisely. Use **bold** for key terms. Under 150 words unless asked for detail.`
    : 'You are an elite USMLE tutor. Answer concisely. Use **bold** for key terms.';
  chatHist.push({ role: 'user', content: text });
  try {
    const raw = await smartCall([{ role: 'system', content: ctx }, ...chatHist.slice(-10)], false, { maxTokens: 1500 });
    chatHist.push({ role: 'assistant', content: raw });
    addMsg('ai', raw);
  } catch (err) { addMsg('ai', 'Error: ' + err.message); }
}

const MAGIC_PROMPTS = {
  eli5: 'Explain the core concept like I am 5. One simple analogy. Under 80 words. Memorable.',
  anki: 'Make 3 Anki cards on this concept. Format:\nQ: ...\nA: ...\nBoard-focused.',
  oneliner: 'Give ONE sentence I need to know to crush this on exam day. Sharp & memorable.',
  pimp: 'You are an attending pimping me. Ask 5 rapid-fire pimp questions, each harder. Numbered list only.',
  harder: 'Rewrite this question significantly harder — add a twist. Then give the answer.',
  patient: 'Explain to a patient in compassionate non-medical language. Under 100 words.'
};
async function magicAction(type) {
  if (!analysis) return;
  const prompt = MAGIC_PROMPTS[type];
  const ctx = `Topic: ${analysis.teaching_point || analysis.qtext || 'this topic'}. Cheat code: ${analysis.cheat_code || ''}`;
  const labels = { eli5: '🧒 ELI5', anki: '📇 Anki', oneliner: '⚡ One-Liner', pimp: '🩺 PIMP', harder: '🔥 Harder', patient: '👨‍⚕️ Patient' };
  addMsg('user', labels[type]);
  try {
    const raw = await smartCall([{ role: 'system', content: 'Elite USMLE tutor. Sharp, clinical, memorable.' }, { role: 'user', content: ctx + '\n\n' + prompt }], false, { maxTokens: 1500 });
    chatHist.push({ role: 'assistant', content: raw });
    addMsg('ai', raw);
  } catch (err) { addMsg('ai', 'Error: ' + err.message); }
}

/* =========================================================
   INIT
   ========================================================= */
function init() {
  loadKey();
  applyTheme();
  document.documentElement.style.setProperty('font-size', fontSize + 'px');
  // Restore module
  const saved = localStorage.getItem('ub_module');
  if (saved && document.getElementById('mod-' + saved)) switchModule(saved);
  // Render compressor list
  renderCompressor();
  // Restore weak-spot panel anchor
  if (document.getElementById('buz-weak-anchor')) renderBuzzerWeak();
  // Setup PDF.js worker
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
}
document.addEventListener('DOMContentLoaded', init);
