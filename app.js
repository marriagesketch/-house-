/* ============================================================
   住まい すり合わせ – app.js（自動ペア判定方式）
   ------------------------------------------------------------
   家族紹介（familyintroduction/app.js）と同じ自動ペア判定方式を採用。
   ・ユーザーは暗号キーの入力も共有リンクの送付も一切行わない。
   ・サーバーに送るのは ownerHash（LINE userIdのSHA-256）だけ。
   ・この用途専用のGASが毎回 Partners中央API に ownerHash を
     問い合わせ、「現在の真剣交際パートナー」と「ペア専用の暗号鍵
     材料(pairKey)」を自動的に取得し、fetchPairの応答に含めて返す。
   ・pairKeyの生値はユーザーには一切表示せず、ブラウザのメモリ上で
     AES鍵の導出にのみ使う（自分／お相手双方の回答の暗号化・復号のため）。
   ・家族紹介と同様、住まいの希望はお互いが「それぞれ自分の希望」を
     回答するコンテンツのため、プレビューは「自分」と「お相手」の
     2つを切り替えて表示する。お相手のページは閲覧専用（編集不可）。
   ・「送信する」を押すまでは、自分の回答はこの端末の中だけに
     保存され、お相手には届かない（サーバーに行が存在しない＝
     未送信として扱われる）。
   ============================================================ */

const LIFF_ID = "2010312230-0FcbsxfS";

/* ▼▼▼ この住まいアプリ用に新しくデプロイしたGAS Web AppのURLをここに設定してください ▼▼▼ */
const GAS_ENDPOINT = "https://script.google.com/macros/s/AKfycbwq_7A9X1dvZu0FyN7F-7XuBcxj_csvP68-OtTXChuE6nGw4Ov0fqO6tpZVXcElTJn8/exec";

/* ▼▼▼ パートナー登録（真剣交際パートナー機能）のLIFF URL ▼▼▼ */
const PARTNER_REGISTRATION_URL = "https://liff.line.me/2010312230-xUsYz0UB";

const STORAGE_KEY = "house_suriawase_draft_v1";

/* ============================================================
   Q4 の5段階評価
   （Q4自体の項目リストはHTML側の <select id="q4_○○"> から動的に
   拾うため、ここでは持たない。HTML側で項目を増減してもこのファイルの
   修正は不要）
   ============================================================ */
const LEVELS = [
  "必須",
  "できれば満たしてほしい",
  "現在の住まいは満たしているがなくてもよい",
  "こだわらない",
  "満たさない方がよい",
];

const Q3_CHECK_NAMES = ["q3_layout", "q3_walk", "q3_age", "q3_size", "q3_struct"];
const Q3_TITLES = {
  q3_layout: "間取りタイプ", q3_walk: "駅からの徒歩分数", q3_age: "築年数",
  q3_size: "専有面積", q3_struct: "構造",
};

/* ============================================================
   ユーティリティ
   ============================================================ */
function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------
   スクショ抑止用ウォーターマーク
   ------------------------------------------------------------
   スクリーンショットの撮影自体は検知・ブロックできないため、
   「撮られても誰が・いつ見た画面かが写り込む」ようにし、
   無断転載・拡散への心理的な抑止力として機能させる。
   お相手の回答を閲覧している間のみ表示する。
   ------------------------------------------------------------ */
function buildWatermarkSVG(lines) {
  const tileW = 240, tileH = 140, lineHeight = 16;
  const startY = tileH / 2 - ((lines.length - 1) * lineHeight) / 2;
  const textEls = lines.map((line, i) => {
    const y = startY + i * lineHeight;
    return `<text x="0" y="${y}" font-size="12" font-family="sans-serif" ` +
           `fill="rgba(0,0,0,0.1)" transform="rotate(-28 ${tileW / 2} ${tileH / 2})">${escapeHTML(line)}</text>`;
  }).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${tileH}">${textEls}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function showScreenshotWatermark(viewerHash) {
  const el = document.getElementById("screenshotWatermark");
  if (!el) return;
  const stamp = new Date().toLocaleString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  el.style.backgroundImage = `url("${buildWatermarkSVG(["スクショ・転載禁止", `${viewerHash.slice(0, 8)}  ${stamp}`])}")`;
  el.classList.add("show");
}
function hideScreenshotWatermark() {
  const el = document.getElementById("screenshotWatermark");
  if (el) el.classList.remove("show");
}

/* ============================================================
   Base64URL 変換ユーティリティ（暗号文の符号化に使用）
   ============================================================ */
function bufToBase64Url(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
function base64UrlToBuf(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad    = padded.length % 4;
  const fixed  = pad ? padded + "=".repeat(4 - pad) : padded;
  const binary = atob(fixed);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/* ============================================================
   SHA-256ハッシュ（LINE UserIDのハッシュ化。生IDはサーバーに送らない）
   ============================================================ */
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* ============================================================
   暗号鍵材料（pairKey）からのAES鍵導出
   ・pairKeyの生値はfetchPairの応答で自動的に受け取る。
     ユーザーが目にしたり入力したりすることはない。
   ・他アプリ（家族紹介・プロポーズプラン等）とpairKeyの値自体は
     共通でも、導出に使うプレフィックスをアプリごとに変えることで、
     アプリをまたいで同じ鍵が再利用されないようにしている。
   ============================================================ */
async function deriveAesKey(pairKey) {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("house-suriawase-cipher:" + pairKey));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/* ============================================================
   AES-GCM 暗号化ユーティリティ
   ============================================================ */
async function encryptJSON(obj, key) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(JSON.stringify(obj));
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  const combined = new Uint8Array(iv.length + cipherBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(cipherBuf), iv.length);
  return bufToBase64Url(combined.buffer);
}
async function decryptJSON(base64, key) {
  const combined = new Uint8Array(base64UrlToBuf(base64));
  const iv   = combined.slice(0, 12);
  const data = combined.slice(12);
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

/* ------------------------------------------------------------
   LINEユーザーIDの取得
   ------------------------------------------------------------ */
function getLineUserId() {
  const idToken = liff.getDecodedIDToken();
  if (!idToken || !idToken.sub) {
    throw new Error("ID token is not available (sub claim missing)");
  }
  return idToken.sub;
}

/* ============================================================
   Q4（HTMLに直接書かれた <select id="q4_○○"> 群を使う）
   ============================================================ */
function getQ4Selects() {
  return document.querySelectorAll('select[id^="q4_"]');
}

function initQ4() {
  getQ4Selects().forEach(sel =>
    sel.addEventListener("change", () => { sel.classList.remove("unanswered"); updateQ4Counter(); }));
  updateQ4Counter();
}

function updateQ4Counter() {
  const counter = document.getElementById("q4Counter");
  if (!counter) return;
  const counts = {}; LEVELS.forEach(l => (counts[l] = 0));
  let unanswered = 0;
  getQ4Selects().forEach(sel => {
    if (!sel.value) unanswered++; else counts[sel.value]++;
  });
  const short = ["必須", "できれば", "現状OK・なくても可", "こだわらない", "避けたい"];
  counter.innerHTML =
    LEVELS.map((l, i) => `${short[i]} <b>${counts[l]}</b>`).join(" ／ ") +
    ` ／ 未回答 <b>${unanswered}</b>`;
}

/* ============================================================
   フォーム値の収集・復元
   ============================================================ */
const getChecked = (name) =>
  Array.from(document.querySelectorAll(`input[name="${name}"]:checked`)).map(el => el.value);

function collectFormData() {
  const q4 = {};
  getQ4Selects().forEach(sel => { q4[sel.id.slice(3)] = sel.value; }); // "q4_" の3文字を除去

  const data = {
    q1_self:    document.getElementById("q1_self").value,
    q1_partner: document.getElementById("q1_partner").value,
    q2:         document.getElementById("q2").value,
    q4,
    q5:         document.getElementById("q5").value,
  };
  Q3_CHECK_NAMES.forEach(name => { data[name] = getChecked(name); });
  return data;
}

function restoreFormData(data) {
  if (!data) return;
  ["q1_self", "q1_partner", "q2", "q5"].forEach(id => {
    const el = document.getElementById(id);
    if (el && data[id] !== undefined) el.value = data[id];
  });
  Q3_CHECK_NAMES.forEach(name => {
    const vals = data[name];
    if (!Array.isArray(vals)) return;
    document.querySelectorAll(`input[name="${name}"]`).forEach(el => { el.checked = vals.includes(el.value); });
  });
  if (data.q4) {
    getQ4Selects().forEach(sel => {
      const item = sel.id.slice(3);
      if (data.q4[item]) sel.value = data.q4[item];
    });
  }
  updateQ4Counter();
}

function isFormEmpty(data) {
  if (data.q1_self.trim() || data.q1_partner.trim() || data.q2.trim() || data.q5.trim()) return false;
  if (Q3_CHECK_NAMES.some(n => data[n].length > 0)) return false;
  if (Object.values(data.q4).some(v => v)) return false;
  return true;
}

/* ============================================================
   バリデーション
   ============================================================ */
function validate(data) {
  const errors = [];
  if (!data.q1_self.trim())    errors.push("Q1: 自分が出せる額を入力してください。");
  if (!data.q1_partner.trim()) errors.push("Q1: お相手が出してくれると仮定した場合の予算金額を入力してください。");
  if (!data.q2.trim())         errors.push("Q2: エリアを入力してください。");
  Q3_CHECK_NAMES.forEach(n => {
    if (data[n].length === 0)  errors.push(`Q3: ${Q3_TITLES[n]}を1つ以上選択してください。`);
  });

  let first = null, count = 0;
  getQ4Selects().forEach(sel => {
    if (!sel.value) { sel.classList.add("unanswered"); count++; if (!first) first = sel; }
  });
  if (count > 0) {
    errors.push(`Q4: 未回答の項目が${count}件あります（赤枠の項目）。`);
    setTimeout(() => first.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  }
  return errors;
}

/* ============================================================
   統計用データ（Analyticsシート）：平文で送るのは集計に必要な項目のみ
   Q4は「q4_項目名」＝回答 の形で送り、GAS側で列を自動追加する
   ============================================================ */
function buildAnalyticsPayload(data) {
  const p = {
    q1_self: data.q1_self || "", q1_partner: data.q1_partner || "", q2: data.q2 || "",
    q3_layout: data.q3_layout.join("、"),
    q3_walk: data.q3_walk.join("、"), q3_age: data.q3_age.join("、"),
    q3_size: data.q3_size.join("、"), q3_struct: data.q3_struct.join("、"),
    q5: data.q5 || "",
  };
  Object.keys(data.q4 || {}).forEach(item => { p["q4_" + item] = data.q4[item] || ""; });
  return p;
}

/* ============================================================
   下書き保存／復元（この端末の中だけ。お相手には届かない）
   ============================================================ */
function saveDraft() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collectFormData()));
    flashSaved();
  } catch (e) { console.warn("draft save failed", e); }
}
function flashSaved() {
  const b = document.getElementById("saveStatus"); if (!b) return;
  b.classList.add("just-saved"); setTimeout(() => b.classList.remove("just-saved"), 400);
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return false;
    const data = JSON.parse(raw);
    restoreFormData(data);
    return !isFormEmpty(data);
  } catch (e) { console.warn("draft load failed", e); return false; }
}

/* ============================================================
   ペア状態（パートナー登録確認・自分／お相手の回答）
   ============================================================ */
const AppState = {
  ownerHash: null,
  aesKey: null,
  partnerDisplayName: "",
  ownSubmittedAt: null,     // 自分が最後に送信した日時（未送信ならnull）
  partnerCipherText: null,  // お相手の暗号化データ（未送信ならnull）
  partnerUpdatedAt: null,
};

async function fetchPair(ownerHash) {
  const url = `${GAS_ENDPOINT}?action=fetchPair&ownerHash=${encodeURIComponent(ownerHash)}`;
  const resp = await fetch(url, { method: "GET" });
  return resp.json();
}

async function submitOwnData() {
  const data = collectFormData();
  const cipherText = await encryptJSON(data, AppState.aesKey);
  const analytics  = buildAnalyticsPayload(data);
  const resp = await fetch(GAS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // preflight回避のため text/plain を使用
    body: JSON.stringify({ action: "submit", ownerHash: AppState.ownerHash, cipherText, analytics }),
  });
  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "(本文を取得できませんでした)");
    console.error(`submit failed: HTTP ${resp.status} ${resp.statusText}`, bodyText);
    throw new Error(`http_${resp.status}`);
  }
  const result = await resp.json();
  if (!result.ok) throw new Error(result.reason || "submit_failed");
  AppState.ownSubmittedAt = result.updatedAt || new Date().toISOString();
  return result;
}

/* ============================================================
   状態表示（パートナー確認中・エラーなど）
   ============================================================ */
function showAppState(title, text, isLoading = false) {
  document.getElementById("app").style.display = "none";
  document.getElementById("partnerRequired").style.display = "none";
  const pv = document.getElementById("publicView");
  pv.style.display = "block";
  pv.innerHTML = `
    <div class="state-card">
      ${isLoading ? `
        <div class="state-spinner">
          <img src="https://developers.line.biz/media/line-mini-app/LINE_spinner_light.svg" class="spinner-light" alt="読み込み中">
          <img src="https://developers.line.biz/media/line-mini-app/LINE_spinner_dark.svg" class="spinner-dark" alt="読み込み中">
        </div>
      ` : ""}
      <p class="state-title">${escapeHTML(title)}</p>
      <p class="state-text">${escapeHTML(text)}</p>
    </div>
  `;
}

function showPartnerRequired() {
  document.getElementById("app").style.display = "none";
  document.getElementById("publicView").style.display = "none";
  document.getElementById("partnerRequired").style.display = "block";
}

function showApp() {
  document.getElementById("publicView").style.display = "none";
  document.getElementById("partnerRequired").style.display = "none";
  document.getElementById("app").style.display = "";
}

/* ============================================================
   パートナー登録確認（自動ペア判定）
   ============================================================ */
async function initPairing() {
  showAppState("読み込み中…", "パートナー登録の状況を確認しています。少々お待ちください。", true);

  const ownerHash = await sha256Hex(getLineUserId());
  AppState.ownerHash = ownerHash;

  let result;
  try {
    result = await fetchPair(ownerHash);
  } catch (e) {
    console.error("fetchPair failed", e);
    showAppState("読み込みに失敗しました", "時間をおいてもう一度開き直してください。");
    return false;
  }

  if (!result.ok) {
    if (result.reason === "no_partner" || result.reason === "partner_ended") {
      showPartnerRequired();
    } else {
      showAppState("読み込みに失敗しました", "時間をおいてもう一度開き直してください。");
    }
    return false;
  }

  AppState.aesKey             = await deriveAesKey(result.pairKey);
  AppState.partnerDisplayName = result.partnerDisplayName || "";
  AppState.ownSubmittedAt     = result.own ? result.own.updatedAt : null;
  AppState.partnerCipherText  = result.partner ? result.partner.cipherText : null;
  AppState.partnerUpdatedAt   = result.partner ? result.partner.updatedAt : null;

  const partnerBtn = document.getElementById("partnerTabBtn");
  if (partnerBtn) partnerBtn.textContent = AppState.partnerDisplayName ? `${AppState.partnerDisplayName}さん` : "お相手";

  showApp();
  return true;
}

/* ペア情報だけを取り直す（画面遷移はせず、お相手の最新状況だけ更新） */
async function refetchPair() {
  let result;
  try {
    result = await fetchPair(AppState.ownerHash);
  } catch (e) {
    console.error("refetchPair failed", e);
    alert("お相手の状況を取得できませんでした。通信環境を確認してもう一度お試しください。");
    return false;
  }
  if (!result.ok) {
    showPartnerRequired(); // 取得中に交際終了などがあった場合は案内画面に戻す
    return false;
  }
  AppState.partnerDisplayName = result.partnerDisplayName || "";
  AppState.partnerCipherText  = result.partner ? result.partner.cipherText : null;
  AppState.partnerUpdatedAt   = result.partner ? result.partner.updatedAt : null;
  const partnerBtn = document.getElementById("partnerTabBtn");
  if (partnerBtn) partnerBtn.textContent = AppState.partnerDisplayName ? `${AppState.partnerDisplayName}さん` : "お相手";
  return true;
}

/* ============================================================
   表示用 HTML ビルダー（自分／お相手 共通のQ&A表示）
   ============================================================ */
function formatDateLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function buildQARowsHTML(data) {
  const r = (v) => (v && String(v).trim()) ? escapeHTML(v).replace(/\n/g, "<br>") : "未回答";
  const list = (arr) => (Array.isArray(arr) && arr.length) ? arr.map(escapeHTML).join("、") : "未回答";

  const rows = [
    { q: "Q1 予算はいくらで考えていますか？",
      html: `自分が出せる額：<br>${r(data.q1_self)}<br><br>お相手がいくらでも出してくれると仮定した場合の予算金額：<br>${r(data.q1_partner)}` },
    { q: "Q2 エリアはどのあたりを考えていますか？", html: r(data.q2) },
    { q: "Q3 許容範囲",
      html: Q3_CHECK_NAMES.map(n => `<strong>${Q3_TITLES[n]}</strong><br>${list(data[n])}`).join("<br><br>") },
  ];

  const q4 = data.q4 || {};
  const q4Items = Object.keys(q4); // collectFormData時のDOM順（＝HTML記載順）で入っている
  LEVELS.forEach(level => {
    const items = q4Items.filter(i => q4[i] === level);
    rows.push({
      q: `Q4 【${level}】（${items.length}件）`,
      html: items.length ? items.map(i => `・${escapeHTML(i)}`).join("<br>") : "なし",
    });
  });

  rows.push({ q: "Q5 ほかに希望条件があれば記載してください。", html: r(data.q5) });

  return rows.map(({ q, html }) => `
    <div class="view-item">
      <p class="view-question">${escapeHTML(q)}</p>
      <p class="view-answer">${html}</p>
    </div>`).join("");
}

/* ----- 自分のプレビュー（編集中の内容をそのまま表示。編集はできない＝閲覧専用の表示） ----- */
function renderOwnPreview() {
  const container = document.getElementById("previewContent");
  container.innerHTML = buildQARowsHTML(collectFormData());
}

/* ----- お相手のプレビュー（まだ未送信なら案内のみ。常に閲覧専用） ----- */
async function renderPartnerPreview() {
  const container = document.getElementById("previewContent");
  const name = AppState.partnerDisplayName || "お相手";

  if (!AppState.partnerCipherText) {
    container.innerHTML = `
      <div class="preview-empty">
        ${escapeHTML(name)}さんはまだ回答を送信していません。<br>
        送信されると、ここに表示されます。
      </div>
      <button type="button" class="partner-refresh-btn" id="partnerRefreshBtn">最新の状況を取得する</button>
    `;
  } else {
    let data;
    try {
      data = await decryptJSON(AppState.partnerCipherText, AppState.aesKey);
    } catch (e) {
      console.error("decrypt partner data failed", e);
      container.innerHTML = `<div class="preview-empty">お相手のデータの復号に失敗しました。時間をおいてもう一度お試しください。</div>`;
      return;
    }
    const dateLabel = formatDateLabel(AppState.partnerUpdatedAt);
    container.innerHTML = `
      <div class="view-header">
        <p class="view-label">回答内容</p>
        <p class="view-name">${escapeHTML(name)} さんの回答</p>
        ${dateLabel ? `<p class="view-name" style="font-size:12px;font-weight:400;color:#888;margin-top:6px;">送信日：${escapeHTML(dateLabel)}</p>` : ""}
      </div>
      ${buildQARowsHTML(data)}
      <button type="button" class="partner-refresh-btn" id="partnerRefreshBtn">最新の状況を取得する</button>
    `;
  }

  const refreshBtn = document.getElementById("partnerRefreshBtn");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      refreshBtn.textContent = "取得中…";
      const ok = await refetchPair();
      if (ok && currentPreviewPerson === "partner") await renderPartnerPreview();
      refreshBtn.disabled = false;
      refreshBtn.textContent = "最新の状況を取得する";
    });
  }
}

/* ============================================================
   プレビュー：自分／お相手 切り替え
   ============================================================ */
let currentPreviewPerson = "own";

async function switchPreviewPerson(person) {
  currentPreviewPerson = person;
  document.querySelectorAll(".preview-person-switcher .sub-switch-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.person === person);
  });

  const ownSubmittedAtEl = document.getElementById("ownSubmittedAt");
  const sendBtn = document.getElementById("sendBtn");

  if (person === "own") {
    hideScreenshotWatermark();
    if (sendBtn) sendBtn.classList.remove("hidden");
    renderOwnPreview();
    if (ownSubmittedAtEl) {
      ownSubmittedAtEl.textContent = AppState.ownSubmittedAt
        ? `お相手への送信日時：${formatDateLabel(AppState.ownSubmittedAt)}`
        : "まだお相手に送信していません。「送信する」を押すと届きます。";
      ownSubmittedAtEl.classList.remove("hidden");
    }
  } else {
    if (sendBtn) sendBtn.classList.add("hidden");
    if (ownSubmittedAtEl) ownSubmittedAtEl.classList.add("hidden");
    await renderPartnerPreview();
    showScreenshotWatermark(AppState.ownerHash);
  }
}

/* ============================================================
   タブ切替
   ============================================================ */
function switchTab(tab) {
  ["input", "preview", "settings"].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle("hidden", t !== tab);
  });
  document.querySelectorAll(".bottom-nav .nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  const titles = { preview: "プレビュー", settings: "設定" };
  document.getElementById("appBarTitle").textContent = titles[tab] || "住まい すり合わせ";

  if (tab === "preview") {
    switchPreviewPerson(currentPreviewPerson);
  } else {
    hideScreenshotWatermark();
  }
}

/* ============================================================
   イベント登録
   ============================================================ */
function bindEvents() {
  let saveTimer = null;
  document.getElementById("tab-input").addEventListener("input", () => {
    clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 500);
  });
  document.getElementById("tab-input").addEventListener("change", () => {
    clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 500);
  });

  document.querySelectorAll(".bottom-nav .nav-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  document.querySelectorAll(".preview-person-switcher .sub-switch-btn").forEach(btn => {
    btn.addEventListener("click", () => switchPreviewPerson(btn.dataset.person));
  });

  /* ----- 送信ボタン：お相手へ直接送信（ペアとして登録済みのお相手にのみ届く） ----- */
  document.getElementById("sendBtn").addEventListener("click", async () => {
    const data = collectFormData();
    const errors = validate(data);
    if (errors.length > 0) {
      switchTab("input");
      setTimeout(() => alert("以下の項目を入力・選択してください。\n\n" + errors.join("\n")), 50);
      return;
    }

    const name = AppState.partnerDisplayName || "お相手";
    if (!confirm(`入力内容を${name}さんに送信しますか？\n送信すると、これまでの内容が上書きされます。`)) return;

    const sendBtn = document.getElementById("sendBtn");
    sendBtn.disabled = true;
    const originalLabel = sendBtn.textContent;
    sendBtn.textContent = "送信中…";

    try {
      await submitOwnData();
      alert("送信しました。");
      if (currentPreviewPerson === "own") switchPreviewPerson("own");
    } catch (e) {
      console.error("submit error", e);
      alert("送信に失敗しました。通信環境を確認してもう一度お試しください。");
    } finally {
      sendBtn.disabled = false;
      sendBtn.textContent = originalLabel;
    }
  });

  document.getElementById("resetBtn").addEventListener("click", () => {
    if (!confirm("入力内容を削除して最初から作成しますか？この操作は取り消せません。\n（すでにお相手に送信済みの内容は、この操作では削除されません）")) return;
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    location.reload();
  });
}

/* ============================================================
   友だち追加チェック（裏で実行・失敗しても続行）
   ============================================================ */
async function checkFriendship() {
  try {
    const friendship = await liff.getFriendship();
    if (!friendship.friendFlag) {
      try { await liff.requestFriendship(); }
      catch (error) { console.warn("友だち追加リクエスト失敗（ユーザーがキャンセルした可能性があります）:", error); }
    }
  } catch (error) {
    console.warn("友だち確認をスキップ:", error);
  }
}

/* ============================================================
   メイン処理
   ============================================================ */
(async () => {
  try {
    await liff.init({ liffId: LIFF_ID });
  } catch (e) {
    console.error("LIFF init failed", e);
    alert("LIFFの初期化に失敗しました。");
    return;
  }

  if (!liff.isLoggedIn()) { liff.login(); return; }

  /* LIFF初期化・ログイン後に友だち確認（未追加ならダイアログで追加を促す）
     通信を伴うため画面構築をブロックしないよう、裏側で実行する
     （fire-and-forget）。 */
  checkFriendship();

  /* パートナー登録の確認（未登録・交際終了なら案内を表示して終了） */
  const paired = await initPairing();
  if (!paired) return;

  const hadDraft = loadDraft();
  initQ4();
  bindEvents();

  const startBtn  = document.getElementById("startBtn");
  const resumeBtn = document.getElementById("resumeBtn");
  if (hadDraft) { resumeBtn.classList.remove("hidden"); startBtn.textContent = "新しく作成する"; }

  function goToMain() {
    document.getElementById("screen-top").classList.add("hidden");
    document.getElementById("screen-main").classList.remove("hidden");
    switchTab("input");
  }

  startBtn.addEventListener("click", () => {
    if (hadDraft && !confirm("これまでの下書きを削除して、新しく作成しますか？\n（すでにお相手に送信済みの内容は、この操作では削除されません）")) return;
    if (hadDraft) {
      document.querySelectorAll('#tab-input input[type="text"], #tab-input textarea').forEach(el => (el.value = ""));
      document.querySelectorAll('#tab-input input[type="checkbox"]').forEach(el => (el.checked = false));
      getQ4Selects().forEach(el => { el.value = ""; el.classList.remove("unanswered"); });
      updateQ4Counter();
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    }
    goToMain();
  });
  resumeBtn.addEventListener("click", goToMain);
})();
