/* ============================================================
   住まい すり合わせ – app.js
   ------------------------------------------------------------
   共有リンクは「id（短いランダムID）＋復号鍵（URLのフラグメント）」
   のみで構成される。回答本体は暗号化されたうえで GAS 経由で
   スプレッドシートに保存され、復号鍵はサーバーに送信されない
   （URLの # 以降はブラウザからサーバーへ送信されないため）。
   ============================================================ */

// ▼▼▼ 要設定 ▼▼▼
const LIFF_ID      = "YOUR_LIFF_ID";          // この住まいアプリ用に発行したLIFF ID
const GAS_ENDPOINT = "YOUR_GAS_EXEC_URL";     // デプロイ済みGAS Web AppのURL
// ▲▲▲▲▲▲▲▲▲▲▲▲

const DRAFT_KEY = "konkatsu_suriawase_house_draft";
const PENDING_SHARED_VIEW_KEY = "konkatsu_suriawase_house_pending_shared_view";
const SHARETARGETPICKER_IMAGE_URL = "https://marriagesketch.github.io/-house-/sharetargetpicker.jpg";

/* ============================================================
   Q4 要件定義
   ============================================================ */
const LEVELS = [
  "必須",
  "できれば満たしてほしい",
  "現在の住まいは満たしているがなくてもよい",
  "こだわらない",
  "満たさない方がよい",
];

const Q4_GROUPS = [
  { title: "建物設備", items: [
    "駐車場あり（駐車場2台以上、敷地内駐車場）", "駐輪場あり", "バイク置場あり", "エレベーター",
    "宅配ボックス", "敷地内ゴミ置場", "バルコニー付（ルーフバルコニー付）", "専用庭",
    "都市ガス", "プロパンガス", "バリアフリー", "ごみ出し24時間OK", "免震構造" ] },
  { title: "位置", items: ["2階以上", "最上階", "角部屋", "南向き"] },
  { title: "セキュリティ", items: [
    "オートロック", "管理人有り", "TVモニタ付きインタホン", "防犯カメラ", "セキュリティ会社加入済" ] },
  { title: "キッチン", items: [
    "ガスコンロ対応", "IHコンロ", "コンロ2口以上", "オール電化", "システムキッチン",
    "カウンターキッチン", "食器洗い乾燥機", "ディスポーザー", "冷蔵庫付き" ] },
  { title: "バス・トイレ", items: [
    "バス・トイレ別", "温水洗浄便座", "浴室乾燥機", "追い焚き風呂", "独立洗面台" ] },
  { title: "テレビ・通信", items: ["インターネット無料", "BSアンテナ", "CSアンテナ", "ケーブルテレビ"] },
  { title: "冷暖房", items: ["エアコン付き", "床暖房付き"] },
  { title: "収納", items: [
    "床下収納", "シューズボックス", "トランクルーム", "ウォークインクローゼット", "全居室収納" ] },
  { title: "その他室内設備", items: [
    "室内洗濯機置場", "洗面所独立", "全居室フローリング", "メゾネット", "ロフト", "防音室" ] },
  { title: "入居条件・その他特徴", items: ["ペット相談可", "楽器相談可", "フロントサービス"] },
];
const Q4_ALL_ITEMS = Q4_GROUPS.flatMap(g => g.items);

const Q3_CHECK_NAMES = ["q3_walk", "q3_age", "q3_size", "q3_struct"];
const Q3_TITLES = {
  q3_walk: "駅からの徒歩分数", q3_age: "築年数", q3_size: "専有面積", q3_struct: "構造",
};

/* ============================================================
   共通ユーティリティ
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

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* AES-GCM 暗号化（鍵はURLフラグメントにのみ含め、サーバーには渡さない） */
async function generateShareKey() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = await crypto.subtle.exportKey("raw", key);
  return { key, base64: bufToBase64Url(raw) };
}

async function importShareKey(base64) {
  return crypto.subtle.importKey("raw", base64UrlToBuf(base64), { name: "AES-GCM" }, false, ["decrypt"]);
}

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
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: combined.slice(0, 12) }, key, combined.slice(12));
  return JSON.parse(new TextDecoder().decode(plainBuf));
}

/* LINEユーザーID取得（IDトークンのデコードのみ。追加通信なし） */
function getLineUserId() {
  const idToken = liff.getDecodedIDToken();
  if (!idToken || !idToken.sub) throw new Error("ID token is not available (sub claim missing)");
  return idToken.sub;
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fallbackUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/* ============================================================
   Q4 フォーム生成・カウンター
   ============================================================ */
function buildQ4() {
  const container = document.getElementById("q4Container");
  const options = `<option value="">選択してください</option>` +
    LEVELS.map(l => `<option value="${escapeHTML(l)}">${escapeHTML(l)}</option>`).join("");

  container.innerHTML = Q4_GROUPS.map(g => `
    <div class="group-title">${escapeHTML(g.title)}</div>
    ${g.items.map(item => `
      <div class="item-row">
        <span class="item-name">${escapeHTML(item)}</span>
        <select class="level-select" data-item="${escapeHTML(item)}">${options}</select>
      </div>`).join("")}
  `).join("");

  container.querySelectorAll(".level-select").forEach(sel =>
    sel.addEventListener("change", () => { sel.classList.remove("unanswered"); updateQ4Counter(); }));
  updateQ4Counter();
}

function updateQ4Counter() {
  const counts = {}; LEVELS.forEach(l => (counts[l] = 0));
  let unanswered = 0;
  document.querySelectorAll(".level-select").forEach(sel => {
    if (!sel.value) unanswered++; else counts[sel.value]++;
  });
  const short = ["必須", "できれば", "現状OK・なくても可", "こだわらない", "避けたい"];
  document.getElementById("q4Counter").innerHTML =
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
  document.querySelectorAll(".level-select").forEach(sel => { q4[sel.dataset.item] = sel.value; });
  return {
    q1_self:    document.getElementById("q1_self").value,
    q1_partner: document.getElementById("q1_partner").value,
    q2:         document.getElementById("q2").value,
    q3_layout:  document.getElementById("q3_layout").value,
    q3_walk:    getChecked("q3_walk"),
    q3_age:     getChecked("q3_age"),
    q3_size:    getChecked("q3_size"),
    q3_struct:  getChecked("q3_struct"),
    q4,
  };
}

function restoreFormData(data) {
  if (!data) return;
  ["q1_self", "q1_partner", "q2"].forEach(id => {
    if (data[id] !== undefined) document.getElementById(id).value = data[id];
  });
  if (data.q3_layout) document.getElementById("q3_layout").value = data.q3_layout;
  Q3_CHECK_NAMES.forEach(name => {
    const vals = data[name];
    if (!Array.isArray(vals)) return;
    document.querySelectorAll(`input[name="${name}"]`).forEach(el => { el.checked = vals.includes(el.value); });
  });
  if (data.q4) {
    document.querySelectorAll(".level-select").forEach(sel => {
      if (data.q4[sel.dataset.item]) sel.value = data.q4[sel.dataset.item];
    });
  }
  updateQ4Counter();
}

/* ============================================================
   バリデーション
   ============================================================ */
function validate(data) {
  const errors = [];
  if (!data.q1_self.trim())    errors.push("Q1: 自分が出せる額を入力してください。");
  if (!data.q1_partner.trim()) errors.push("Q1: お相手が出してくれると仮定した場合の予算金額を入力してください。");
  if (!data.q2.trim())         errors.push("Q2: エリアを入力してください。");
  if (!data.q3_layout)         errors.push("Q3: 間取りタイプを選択してください。");
  Q3_CHECK_NAMES.forEach(n => {
    if (data[n].length === 0)  errors.push(`Q3: ${Q3_TITLES[n]}を1つ以上選択してください。`);
  });

  let first = null, count = 0;
  document.querySelectorAll(".level-select").forEach(sel => {
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
    q3_layout: data.q3_layout || "",
    q3_walk: data.q3_walk.join("、"), q3_age: data.q3_age.join("、"),
    q3_size: data.q3_size.join("、"), q3_struct: data.q3_struct.join("、"),
  };
  Q4_ALL_ITEMS.forEach(item => { p["q4_" + item] = (data.q4 && data.q4[item]) || ""; });
  return p;
}

/* ============================================================
   状態表示・ビューモード
   ============================================================ */
function hideFormElements() {
  const f = document.getElementById("formArea");
  if (f) f.style.display = "none";
  const m = document.getElementById("shareModal");
  if (m) m.style.display = "none";
}

function getViewContainer() {
  let c = document.getElementById("viewMode");
  if (!c) {
    c = document.createElement("div");
    c.id = "viewMode";
    document.querySelector(".container").prepend(c);
  }
  c.style.display = "block";
  return c;
}

function showStateCard(title, text, isLoading = false) {
  hideFormElements();
  getViewContainer().innerHTML = `
    <div class="view-header state-card">
      ${isLoading ? `
        <div class="state-spinner">
          <img src="https://developers.line.biz/media/line-mini-app/LINE_spinner_light.svg" class="spinner-light" alt="読み込み中">
          <img src="https://developers.line.biz/media/line-mini-app/LINE_spinner_dark.svg" class="spinner-dark" alt="読み込み中">
        </div>` : ""}
      <p class="view-label">${escapeHTML(title)}</p>
      <p class="state-text">${escapeHTML(text)}</p>
    </div>`;
}

function renderViewMode(data, options = {}) {
  const { selfPreview = false, onShare = null } = options;
  const r = (v) => (v && String(v).trim()) ? escapeHTML(v).replace(/\n/g, "<br>") : "未回答";
  const list = (arr) => (Array.isArray(arr) && arr.length) ? arr.map(escapeHTML).join("、") : "未回答";

  const rows = [
    { q: "Q1 予算はいくらで考えていますか？",
      html: `自分が出せる額：<br>${r(data.q1_self)}<br><br>お相手がいくらでも出してくれると仮定した場合の予算金額：<br>${r(data.q1_partner)}` },
    { q: "Q2 エリアはどのあたりを考えていますか？", html: r(data.q2) },
    { q: "Q3 許容範囲",
      html: [
        `<strong>間取りタイプ</strong><br>${r(data.q3_layout)}`,
        ...Q3_CHECK_NAMES.map(n => `<strong>${Q3_TITLES[n]}</strong><br>${list(data[n])}`),
      ].join("<br><br>") },
  ];

  const q4 = data.q4 || {};
  LEVELS.forEach(level => {
    const items = Q4_ALL_ITEMS.filter(i => q4[i] === level);
    rows.push({
      q: `Q4 【${level}】（${items.length}件）`,
      html: items.length ? items.map(i => `・${escapeHTML(i)}`).join("<br>") : "なし",
    });
  });

  hideFormElements();
  const formURL = location.href.split("?")[0].split("#")[0];

  const descEl = document.querySelector(".form-header .form-description");
  if (descEl) {
    descEl.innerHTML =
      "回答を共有してお互いのことを知りましょう。<br>" +
      "回答内容だけじゃなく、なぜそう思ってるのか、この場合はどう変わるかなども質問し合ってみましょう。";
  }

  getViewContainer().innerHTML = `
    ${selfPreview ? `
    <div class="cta-card share-confirm-card">
      <div class="cta-content" style="text-align:center;">
        <h3 class="cta-title">この内容を共有します</h3>
        <p class="cta-text">内容を確認したら、共有先を選んでください。</p>
        <button type="button" id="goShareBtn" class="cta-button">共有先を選ぶ <span class="cta-arrow">›</span></button>
      </div>
    </div>` : `
    <div class="view-header">
      <p class="view-label">回答内容</p>
      ${data._shareName ? `<p class="view-name">${escapeHTML(data._shareName)} さんの回答</p>` : ""}
    </div>`}

    ${rows.map(({ q, html }) => `
      <div class="view-item">
        <p class="view-question">${escapeHTML(q)}</p>
        <p class="view-answer">${html}</p>
      </div>`).join("")}

    ${!selfPreview ? `
    <div class="cta-card">
      <img src="shareimage.webp" class="cta-image-left" alt="">
      <div class="cta-content">
        <h3 class="cta-title">あなたの希望も共有してみませんか？</h3>
        <p class="cta-text">
          同居前の住まいの希望のすり合わせは、<br>
          お互いを知る大切なきっかけになります。<br>
          あなたの考えをアンケートで伝えてみましょう。
        </p>
        <button type="button" id="ctaButton" class="cta-button" data-href="${formURL}">
          私も回答する <span class="cta-arrow">›</span>
        </button>
      </div>
    </div>` : ""}
  `;

  if (selfPreview) {
    const b = document.getElementById("goShareBtn");
    if (b && typeof onShare === "function") b.addEventListener("click", onShare);
    return;
  }
  const cta = document.getElementById("ctaButton");
  if (cta) cta.addEventListener("click", () => {
    if (confirm("住まい すり合わせフォームを開く")) window.location.href = cta.dataset.href;
  });
}

/* ============================================================
   共有リンクを開いたときの処理
   ============================================================ */
async function handleSharedView(id) {
  showStateCard("読み込み中…", "回答内容を確認しています。少々お待ちください。", true);

  const keyBase64 = location.hash ? location.hash.slice(1) : "";
  if (!keyBase64) {
    showStateCard("リンクが不完全です",
      "共有リンクが途中で切れているか、正しくコピーされていない可能性があります。共有した相手にもう一度リンクを送ってもらってください。");
    return;
  }

  if (!liff.isLoggedIn()) {
    try { sessionStorage.setItem(PENDING_SHARED_VIEW_KEY, location.href); } catch (_) {}
    liff.login();
    return;
  }

  let key;
  try { key = await importShareKey(keyBase64); }
  catch (e) {
    console.error("key import error", e);
    showStateCard("リンクが正しくありません", "共有リンクが壊れている可能性があります。");
    return;
  }

  let viewerHash;
  try { viewerHash = await sha256Hex(getLineUserId()); }
  catch (e) {
    console.error("get user id error", e);
    showStateCard("エラー",
      "LINEアカウント情報の確認に失敗しました。時間をおいてもう一度お試しください。（詳細: " + (e && e.message ? e.message : String(e)) + "）");
    return;
  }

  let result;
  try {
    const url = `${GAS_ENDPOINT}?action=view&id=${encodeURIComponent(id)}&viewerHash=${encodeURIComponent(viewerHash)}`;
    result = await (await fetch(url, { method: "GET" })).json();
  } catch (e) {
    console.error("fetch view error", e);
    showStateCard("通信エラー", "回答内容を取得できませんでした。通信環境を確認してもう一度お試しください。");
    return;
  }

  if (!result.ok) {
    const r = result.reason;
    if (r === "forbidden" || r === "partner_locked") {
      showStateCard("閲覧できません", "このリンクは最初に開いた方専用です。転送されたリンクは、その方以外は閲覧できない仕組みになっています。");
    } else if (r === "revoked" || r === "expired" || r === "deleted") {
      showStateCard("リンクが無効です", "このリンクはすでに無効になっています。最新の共有リンクを送ってもらってください。");
    } else if (r === "not_found") {
      showStateCard("リンクが見つかりません", "このリンクは存在しないか、削除された可能性があります。");
    } else {
      showStateCard("エラー", "回答内容を取得できませんでした。時間をおいて再度お試しください。");
    }
    return;
  }

  let data;
  try { data = await decryptJSON(result.cipherText, key); }
  catch (e) {
    console.error("decrypt error", e);
    showStateCard("復号に失敗しました", "リンクの一部が正しくない可能性があります。共有した相手にもう一度リンクを送ってもらってください。");
    return;
  }

  renderViewMode(data);
  showScreenshotWatermark(viewerHash);
}

/* ============================================================
   スクショ抑止用ウォーターマーク
   撮影自体は防げないため、「誰が・いつ閲覧した画面か」が写り込む
   ようにして無断転載への心理的抑止力とする。
   ============================================================ */
function buildWatermarkSVG(lines) {
  const tileW = 240, tileH = 140, lineHeight = 16;
  const startY = tileH / 2 - ((lines.length - 1) * lineHeight) / 2;
  const textEls = lines.map((line, i) =>
    `<text x="0" y="${startY + i * lineHeight}" font-size="12" font-family="sans-serif" ` +
    `fill="rgba(0,0,0,0.1)" transform="rotate(-28 ${tileW / 2} ${tileH / 2})">${escapeHTML(line)}</text>`
  ).join("");
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

/* ============================================================
   共有（Flexメッセージ／シェアターゲットピッカー）
   ============================================================ */
function buildShareFlexMessage(shareName, shareURL) {
  const nameLine = shareName ? `${shareName}さんの回答が届きました` : "回答が届きました";
  return {
    type: "flex",
    altText: `住まい すり合わせ - ${nameLine}`,
    contents: {
      type: "bubble",
      hero: { type: "image", url: SHARETARGETPICKER_IMAGE_URL, size: "full", aspectRatio: "3:2", aspectMode: "cover" },
      body: {
        type: "box", layout: "vertical", spacing: "md", paddingAll: "20px",
        contents: [
          { type: "text", text: "住まい すり合わせ", size: "xs", weight: "bold", color: "#d96c7d" },
          { type: "text", text: nameLine, size: "lg", weight: "bold", wrap: true, margin: "sm" },
          { type: "text", text: "ボタンから回答内容を確認できます。", size: "sm", color: "#888888", wrap: true, margin: "md" },
        ],
      },
      footer: {
        type: "box", layout: "vertical", spacing: "sm", paddingAll: "20px",
        contents: [{
          type: "button", style: "primary", height: "sm", color: "#f48ca0",
          action: { type: "uri", label: "回答をみる", uri: shareURL },
        }],
      },
    },
  };
}

async function shareToOthers(flexMessage, fallbackLineSchemeURL) {
  if (liff.isApiAvailable("shareTargetPicker")) {
    try {
      await liff.shareTargetPicker([flexMessage], { isMultiple: true });
      return;
    } catch (e) {
      console.warn("shareTargetPicker failed, falling back to URL scheme:", e);
    }
  }
  if (liff.isInClient()) window.location.href = fallbackLineSchemeURL;
  else window.open(fallbackLineSchemeURL, "_blank");
}

async function handleShare(data, shareName) {
  data._shareName = shareName;

  const ownerHash = await sha256Hex(getLineUserId());
  const id = crypto.randomUUID ? crypto.randomUUID() : fallbackUUID();
  const { key, base64: keyBase64 } = await generateShareKey();
  const cipherText = await encryptJSON(data, key);
  const analytics  = buildAnalyticsPayload(data);

  const resp = await fetch(GAS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // preflight回避
    body: JSON.stringify({ action: "share", id, cipherText, ownerHash, analytics, schemaVersion: 1 }),
  });
  const result = await resp.json();
  if (!result.ok) throw new Error(result.reason || "share_failed");

  const base     = location.href.split("?")[0].split("#")[0];
  const shareURL = `${base}?id=${id}#${keyBase64}`;
  const previewMsg = shareName
    ? `${shareName}さんの住まい すり合わせの回答が届きました。\n回答をみる→${shareURL}`
    : `住まい すり合わせの回答が届きました。\n回答をみる→${shareURL}`;
  const flexMessage = buildShareFlexMessage(shareName, shareURL);

  renderViewMode(data, {
    selfPreview: true,
    onShare: () => {
      const lineShareURL = `https://line.me/R/msg/text/?${encodeURIComponent(previewMsg)}`;
      shareToOthers(flexMessage, lineShareURL);
    },
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ============================================================
   友だち追加チェック（裏で実行・失敗しても続行）
   ============================================================ */
async function checkFriendship() {
  try {
    const friendship = await liff.getFriendship();
    if (!friendship.friendFlag) {
      try { await liff.requestFriendship(); }
      catch (error) { console.warn("友だち追加リクエスト失敗:", error); }
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

  /* 共有リンク判定（ログイン往復でURLが崩れた場合はsessionStorageから復元） */
  let sharedId = new URLSearchParams(location.search).get("id");
  if (!sharedId) {
    try {
      const pending = sessionStorage.getItem(PENDING_SHARED_VIEW_KEY);
      if (pending) {
        const pendingURL = new URL(pending);
        const pendingId = new URLSearchParams(pendingURL.search).get("id");
        if (pendingId) {
          sharedId = pendingId;
          const restoredHash = location.hash || pendingURL.hash;
          history.replaceState(null, "", location.pathname + pendingURL.search + restoredHash);
        }
      }
    } catch (_) {}
  }
  try { sessionStorage.removeItem(PENDING_SHARED_VIEW_KEY); } catch (_) {}

  if (sharedId) { await handleSharedView(sharedId); return; }

  if (!liff.isLoggedIn()) { liff.login(); return; }

  checkFriendship();
  buildQ4();

  /* 下書き復元 */
  try {
    const saved = localStorage.getItem(DRAFT_KEY);
    if (saved) restoreFormData(JSON.parse(saved));
  } catch (_) {}

  /* 下書き保存 */
  document.getElementById("draftBtn").addEventListener("click", () => {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(collectFormData()));
      alert("下書きを保存しました。");
    } catch (_) {
      alert("下書きの保存に失敗しました。");
    }
  });

  /* フォームクリア */
  document.getElementById("clearBtn").addEventListener("click", () => {
    if (!confirm("入力内容をすべてクリアしますか？")) return;
    ["q1_self", "q1_partner", "q2"].forEach(id => (document.getElementById(id).value = ""));
    document.getElementById("q3_layout").value = "";
    document.querySelectorAll('input[type="checkbox"]').forEach(el => (el.checked = false));
    document.querySelectorAll(".level-select").forEach(el => { el.value = ""; el.classList.remove("unanswered"); });
    updateQ4Counter();
    try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
  });

  /* 送信 */
  document.getElementById("submitBtn").addEventListener("click", () => {
    const data = collectFormData();
    const errors = validate(data);
    if (errors.length > 0) {
      alert("以下の項目を入力・選択してください。\n\n" + errors.join("\n"));
      return;
    }
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch (_) {}
    const modal = document.getElementById("shareModal");
    modal.classList.remove("hidden");
    modal.classList.add("show");
    document.getElementById("submitBtn").disabled = true;
  });

  /* 共有ボタン */
  const shareBtn = document.getElementById("shareBtn");
  shareBtn.addEventListener("click", async () => {
    const shareName = (document.getElementById("shareName").value || "").trim();
    shareBtn.disabled = true;
    const originalLabel = shareBtn.textContent;
    shareBtn.textContent = "送信中…";
    try {
      await handleShare(collectFormData(), shareName);
      const modal = document.getElementById("shareModal");
      modal.classList.remove("show");
      modal.classList.add("hidden");
    } catch (e) {
      console.error("share error", e);
      alert("共有の準備に失敗しました。通信環境を確認してもう一度お試しください。");
      document.getElementById("submitBtn").disabled = false;
    } finally {
      shareBtn.disabled = false;
      shareBtn.textContent = originalLabel;
    }
  });

  /* モーダル外クリックで閉じる */
  document.getElementById("shareModal").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.classList.remove("show");
      e.currentTarget.classList.add("hidden");
      document.getElementById("submitBtn").disabled = false;
    }
  });
})();
