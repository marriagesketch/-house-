/* ============================================================
   家条件のすり合わせ – app.js（自動ペア判定方式）
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
/* 画面の現在の内容を下書き形式で集める */
function currentDraftData() {
  return collectFormData();
}

/* 入力が空（初期状態）かどうか */
function isBlankDraftData(d) {
  if (!d) return true;
  try { return isFormEmpty(d); } catch (_) { return false; }
}

/* フォームの入力をすべて空に戻す */
function clearFormInputs() {
  document.querySelectorAll('#tab-input input[type="text"], #tab-input textarea').forEach(el => (el.value = ""));
  document.querySelectorAll('#tab-input input[type="checkbox"]').forEach(el => (el.checked = false));
  getQ4Selects().forEach(el => { el.value = ""; el.classList.remove("unanswered"); });
  updateQ4Counter();
}

/* 下書きデータを画面に反映する（端末・クラウド共通。いまの入力は置き換える） */
function applyDraftData(data) {
  clearFormInputs();
  restoreFormData(data);
}

function saveDraft() {
  try {
    writeLocalDraft(currentDraftData());
    flashSaved();
  } catch (e) { console.warn("draft save failed", e); }
}
function flashSaved() {
  const b = document.getElementById("saveStatus"); if (!b) return;
  b.classList.add("just-saved"); setTimeout(() => b.classList.remove("just-saved"), 400);
}
function loadDraft() {
  try {
    const local = readLocalDraft(); if (!local) return false;
    restoreFormData(local.data);
    return !isBlankDraftData(local.data);
  } catch (e) { console.warn("draft load failed", e); return false; }
}
/* ============================================================
   下書きの保存：二段構え
   ① 自動保存 … 入力のたびに端末（localStorage）へ保存
   ② 「下書き保存」ボタン（プレビュー画面上部）… 端末 ＋ クラウド（GAS）へ保存
   端末のデータが消えても、クラウド側から自動復元する。
   クラウド側は「LINEユーザーID由来の鍵」で暗号化してから送るため、
   サーバー側では内容を読めない。
   ※ここで保存する下書きは「自分だけの下書き」であり、お相手には届かない
     （お相手に届くのは「送信する」を押した内容だけ）。
   ============================================================ */
// 「フォームクリア」した時刻。これ以前のクラウド下書きは自動復元しない（意図的な削除を尊重するため）
const DRAFT_CLEARED_AT_KEY = "house_suriawase_draft_cleared_at";
// この端末が最後に把握した（保存した／読み込んだ／確認して見送った）クラウド下書きの版（保存時刻）
const DRAFT_SYNCED_AT_KEY = "house_suriawase_draft_cloud_synced_at";
// クラウド下書きの暗号鍵導出用（LINEユーザーIDと組み合わせる）。変更すると過去のクラウド下書きは復号できなくなる
const DRAFT_CRYPTO_SALT = "house_suriawase_draft_key_v1:";

/* ----- 端末（localStorage） ----- */
function readLocalDraft() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return null;
    const parsed = JSON.parse(raw);
    const { savedAt, ...data } = parsed;
    return { data, savedAt: Number(savedAt) || 0 }; // 旧形式は savedAt なし → 0
  } catch (e) { console.warn("local draft read failed", e); return null; }
}
function writeLocalDraft(data, savedAt = Date.now()) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...data, savedAt })); return true; }
  catch (e) { console.warn("local draft write failed", e); return false; }
}
function getDraftClearedAt() {
  try { return Number(localStorage.getItem(DRAFT_CLEARED_AT_KEY)) || 0; } catch (_) { return 0; }
}
function setDraftClearedAt(ts) {
  try { localStorage.setItem(DRAFT_CLEARED_AT_KEY, String(ts)); } catch (_) {}
}
/* この端末が最後に把握したクラウド下書きの「版」。
   端末ごとの時計のずれに左右されないよう、時刻の大小ではなく
   「別の版かどうか（＝別の端末などで更新されたか）」の判定に使う。 */
function getCloudSyncedAt() {
  try { return Number(localStorage.getItem(DRAFT_SYNCED_AT_KEY)) || 0; } catch (_) { return 0; }
}
function setCloudSyncedAt(ts) {
  try { localStorage.setItem(DRAFT_SYNCED_AT_KEY, String(ts)); } catch (_) {}
}

/* ----- クラウド（GAS） ----- */
function fetchWithTimeout(url, options = {}, ms = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// 鍵は「ソルト＋LINEユーザーID」のSHA-256。サーバーが持つのはユーザーIDのハッシュ（ownerHash）だけで、
// この鍵は導出できない。パートナー登録の状態（pairKey）には依存しない。
async function getDraftCryptoKey(userId) {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(DRAFT_CRYPTO_SALT + userId));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function saveCloudDraft(data, savedAt = Date.now()) {
  const userId     = getLineUserId();
  const ownerHash  = await sha256Hex(userId);
  const key        = await getDraftCryptoKey(userId);
  const cipherText = await encryptJSON(data, key);

  const resp = await fetchWithTimeout(GAS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // preflight回避
    body: JSON.stringify({ action: "saveDraft", ownerHash, cipherText, savedAt, schemaVersion: 1 }),
  });
  const result = await resp.json();
  if (!result.ok) throw new Error(result.reason || "save_draft_failed");
  setCloudSyncedAt(savedAt); // この端末が保存した版 ＝ 把握済み
  return savedAt;
}

async function loadCloudDraft() {
  const userId    = getLineUserId();
  const ownerHash = await sha256Hex(userId);
  const key       = await getDraftCryptoKey(userId);

  const url  = `${GAS_ENDPOINT}?action=loadDraft&ownerHash=${encodeURIComponent(ownerHash)}`;
  const resp = await fetchWithTimeout(url, { method: "GET" });
  const result = await resp.json();
  if (!result.ok) {
    if (result.reason === "not_found") return null;
    throw new Error(result.reason || "load_draft_failed");
  }
  const data = await decryptJSON(result.cipherText, key);
  return { data, savedAt: Number(result.savedAt) || 0 };
}

/* ----- 起動時：クラウドの下書きを確認して必要なら復元（画面表示はブロックしない） ----- */
async function syncCloudDraft(onRestored) {
  let cloud;
  try {
    cloud = await loadCloudDraft();
  } catch (e) { console.warn("cloud draft load skipped:", e); return; }
  if (!cloud || isBlankDraftData(cloud.data)) return;
  if (cloud.savedAt <= getDraftClearedAt()) return; // クリア済み

  const current = currentDraftData();
  const restore = () => {
    applyDraftData(cloud.data);
    writeLocalDraft(cloud.data, cloud.savedAt);
    if (typeof onRestored === "function") onRestored();
  };

  // 端末側が空（端末のデータが消えた／新しい端末）→ 自動で復元
  if (isBlankDraftData(current)) { restore(); setCloudSyncedAt(cloud.savedAt); return; }

  // 端末側にも入力あり。
  // この端末が最後に把握した版と違う（＝別の端末などで更新された）かつ、内容も違う場合だけ確認する
  if (cloud.savedAt === getCloudSyncedAt()) return; // 把握済みの版
  const norm = d => JSON.stringify(d);
  if (norm(cloud.data) === norm(current)) { setCloudSyncedAt(cloud.savedAt); return; }
  const when = cloud.savedAt ? new Date(cloud.savedAt).toLocaleString("ja-JP") : "";
  if (confirm("クラウドに、別の端末などで保存された下書きがあります" + (when ? "（" + when + "）" : "") +
              "。読み込みますか？\n（読み込むと、いま画面にある入力内容は置き換わります）")) {
    restore();
  }
  setCloudSyncedAt(cloud.savedAt); // 読み込んだ場合も、見送った場合も「確認済み」にする
}

/* ----- プレビュー画面上部の「下書き保存」「フォームクリア」ボタン ----- */
function setupDraftButtons() {
  const draftBtn = document.getElementById("cloudDraftBtn");
  if (draftBtn) {
    draftBtn.addEventListener("click", async () => {
      const data = currentDraftData();
      if (isBlankDraftData(data)) { alert("入力内容がまだありません。"); return; }

      const savedAt = Date.now();
      const localOk = writeLocalDraft(data, savedAt);

      const originalLabel = draftBtn.textContent;
      draftBtn.disabled = true; draftBtn.textContent = "保存中…";
      try {
        await saveCloudDraft(data, savedAt);
        alert(localOk
          ? "下書きを保存しました。\n（この端末とクラウドの両方に保存されています）\n※お相手には届いていません。"
          : "クラウドに下書きを保存しました。\n（この端末への保存は失敗しました）\n※お相手には届いていません。");
      } catch (e) {
        console.warn("cloud draft save failed:", e);
        alert(localOk
          ? "この端末には保存しましたが、クラウドへの保存に失敗しました。\n通信環境を確認して、もう一度お試しください。"
          : "下書きの保存に失敗しました。通信環境を確認して、もう一度お試しください。");
      } finally {
        draftBtn.disabled = false; draftBtn.textContent = originalLabel;
      }
    });
  }

  const resetBtn = document.getElementById("resetBtn");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (!confirm("入力内容を削除して最初から作成しますか？この操作は取り消せません。\n（すでにお相手に送信済みの内容は、この操作では削除されません）")) return;
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      setDraftClearedAt(Date.now()); // 意図的な削除。これ以前のクラウド下書きは自動復元しない
      location.reload();
    });
  }
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

/* GASの起動待ち（コールドスタート）を、本番の通信より前に済ませておくための軽い呼び出し。
   結果は使わず、失敗しても何もしない。 */
function warmUpGas() {
  try {
    fetch(`${GAS_ENDPOINT}?action=ping`, { method: "GET" }).catch(() => {});
  } catch (_) {}
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
  const draftActions = document.getElementById("draftActions"); // 下書き保存／フォームクリア（自分のプレビューのみ表示）

  if (person === "own") {
    hideScreenshotWatermark();
    if (sendBtn) sendBtn.classList.remove("hidden");
    if (draftActions) draftActions.classList.remove("hidden");
    renderOwnPreview();
    if (ownSubmittedAtEl) {
      ownSubmittedAtEl.textContent = AppState.ownSubmittedAt
        ? `お相手への送信日時：${formatDateLabel(AppState.ownSubmittedAt)}`
        : "まだお相手に送信していません。「送信する」を押すと届きます。";
      ownSubmittedAtEl.classList.remove("hidden");
    }
  } else {
    if (sendBtn) sendBtn.classList.add("hidden");
    if (draftActions) draftActions.classList.add("hidden");
    if (ownSubmittedAtEl) ownSubmittedAtEl.classList.add("hidden");
    await renderPartnerPreview();
    showScreenshotWatermark(AppState.ownerHash);
  }
}

/* ============================================================
   タブ切替
   ============================================================ */
function switchTab(tab) {
  ["input", "preview"].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle("hidden", t !== tab);
  });
  document.querySelectorAll(".bottom-nav .nav-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  const titles = { preview: "プレビュー" };
  document.getElementById("appBarTitle").textContent = titles[tab] || "家条件のすり合わせ";

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

    warmUpGas(); // 確認ダイアログを見ている間に、GASを先に起こしておく
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

  /* 「下書き保存」「フォームクリア」ボタンは setupDraftButtons() で登録 */
  setupDraftButtons();
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
  warmUpGas(); // LIFFの初期化と並行して、GASを先に起こしておく
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

  let hadDraft = loadDraft();
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
      clearFormInputs();
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      setDraftClearedAt(Date.now()); // 意図的な削除。これ以前のクラウド下書きは自動復元しない
    }
    goToMain();
  });
  resumeBtn.addEventListener("click", goToMain);

  /* クラウドの下書きを確認（裏で実行。画面表示は止めない） */
  syncCloudDraft(() => {
    hadDraft = true;
    resumeBtn.classList.remove("hidden");
    startBtn.textContent = "新しく作成する";
  });
})();
