/* ============================================================
   家族紹介フォーム – app.js（自動ペア判定方式）
   ------------------------------------------------------------
   プロポーズプラン（propose/app.js）と同じ自動ペア判定方式を採用。
   ・ユーザーは暗号キーの入力も共有リンクの送付も一切行わない。
   ・サーバーに送るのは ownerHash（LINE userIdのSHA-256）だけ。
   ・familyintroduction用GASが毎回 Partners中央API に ownerHash を
     問い合わせ、「現在の真剣交際パートナー」と「ペア専用の暗号鍵
     材料(pairKey)」を自動的に取得し、fetchPairの応答に含めて返す。
   ・pairKeyの生値はユーザーには一切表示せず、ブラウザのメモリ上で
     AES鍵の導出にのみ使う（自分／お相手双方の家族紹介データの
     暗号化・復号のため）。
   ・プロポーズプランと違い、家族紹介はお互いが「それぞれ自分の
     家族」を紹介するコンテンツのため、プレビューは「自分」と
     「お相手」の2つを切り替えて表示する。お相手のページは
     閲覧専用（編集不可）。
   ・「送信する」を押すまでは、自分のデータはこの端末の中だけに
     保存され、お相手には届かない（サーバーに行が存在しない＝
     未送信として扱われる）。
   ============================================================ */

const LIFF_ID = "2010606364-4Z0ugW4X";

/* ▼▼▼ 家族紹介用に新しくデプロイしたGAS Web AppのURLをここに設定してください ▼▼▼ */
const GAS_ENDPOINT = "ここに家族紹介用GASのデプロイURLを設定してください";

/* ▼▼▼ パートナー登録（真剣交際パートナー機能）のLIFF URL ▼▼▼ */
const PARTNER_REGISTRATION_URL = "https://liff.line.me/2010312230-xUsYz0UB";

const STORAGE_KEY = "family_intro_draft_v1";

const RELATION_LIST = ["父","母","兄","姉","弟","妹","祖父","祖母","おじ","おば","その他"];

const EDUCATION_LIST = [
  "中学校卒","高校卒","高専卒","専門学校卒","短期大学卒","大学卒","大学院卒","その他",
];

const TALK_TYPE_LIST = [
  "おしゃべりなタイプ",
  "こちらから話を振れば答えてくれるタイプ",
  "寡黙なタイプ",
];

/* ============================================================
   ユーティリティ
   ============================================================ */
function generateId(){
  return Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}
function escapeHTML(str){
  return String(str)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;")
    .replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

/* ------------------------------------------------------------
   スクショ抑止用ウォーターマーク
   ------------------------------------------------------------
   スクリーンショットの撮影自体は検知・ブロックできないため、
   「撮られても誰が・いつ見た画面かが写り込む」ようにし、
   無断転載・拡散への心理的な抑止力として機能させる。
   お相手の家族紹介を閲覧している間のみ表示する。
   ------------------------------------------------------------ */
function buildWatermarkSVG(lines){
  const tileW = 240, tileH = 140;
  const lineHeight = 16;
  const startY = tileH / 2 - ((lines.length - 1) * lineHeight) / 2;

  const textEls = lines.map((line, i) => {
    const y = startY + i * lineHeight;
    return `<text x="0" y="${y}" font-size="12" font-family="sans-serif" ` +
           `fill="rgba(0,0,0,0.1)" transform="rotate(-28 ${tileW / 2} ${tileH / 2})">${escapeHTML(line)}</text>`;
  }).join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${tileW}" height="${tileH}">${textEls}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function showScreenshotWatermark(viewerHash){
  const el = document.getElementById("screenshotWatermark");
  if(!el) return;
  const stamp = new Date().toLocaleString("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const lines = [
    "スクショ・転載禁止",
    `${viewerHash.slice(0, 8)}  ${stamp}`,
  ];
  el.style.backgroundImage = `url("${buildWatermarkSVG(lines)}")`;
  el.classList.add("show");
}
function hideScreenshotWatermark(){
  const el = document.getElementById("screenshotWatermark");
  if(el) el.classList.remove("show");
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
   ・他アプリ（プロポーズプラン等）とpairKeyの値自体は共通でも、
     導出に使うプレフィックスをアプリごとに変えることで、
     アプリをまたいで同じ鍵が再利用されないようにしている。
   ============================================================ */
async function deriveAesKey(pairKey) {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("family-intro-cipher:" + pairKey));
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
   データモデル
   ============================================================ */
let createdAt = null;

function createFamilyData(o={}){
  return Object.assign({
    relation:"", relationName:"", birthdate:"", age:"", hometown:"",
    education:"", schoolName:"", currentJob:"", jobHistory:"",
    personality:"", hobby:"", favoriteFood:"", talkType:"",
  }, o);
}

/* ============================================================
   カード描画
   ============================================================ */
function renderFamilyCard(data){
  const tpl  = document.getElementById("familyCardTemplate");
  const node = tpl.content.firstElementChild.cloneNode(true);

  const relSel = node.querySelector(".family-relation");
  relSel.innerHTML =
    `<option value="" disabled ${data.relation?"":"selected"}>続柄を選択</option>` +
    RELATION_LIST.map(r=>`<option value="${escapeHTML(r)}" ${r===data.relation?"selected":""}>${escapeHTML(r)}</option>`).join("");

  const otherF = node.querySelector(".other-relation-field");
  otherF.classList.toggle("hidden", data.relation !== "その他");

  const eduSel = node.querySelector(".family-education");
  eduSel.innerHTML =
    `<option value="" disabled ${data.education?"":"selected"}>選択してください</option>` +
    EDUCATION_LIST.map(e=>`<option value="${escapeHTML(e)}" ${e===data.education?"selected":""}>${escapeHTML(e)}</option>`).join("");

  const talkSel = node.querySelector(".family-talkType");
  talkSel.innerHTML =
    `<option value="" disabled ${data.talkType?"":"selected"}>選択してください</option>` +
    TALK_TYPE_LIST.map(t=>`<option value="${escapeHTML(t)}" ${t===data.talkType?"selected":""}>${escapeHTML(t)}</option>`).join("");

  const fm = {
    ".family-relationName":"relationName",
    ".family-birthdate":"birthdate",
    ".family-age":"age",
    ".family-hometown":"hometown",
    ".family-schoolName":"schoolName",
    ".family-currentJob":"currentJob",
    ".family-jobHistory":"jobHistory",
    ".family-personality":"personality",
    ".family-hobby":"hobby",
    ".family-favoriteFood":"favoriteFood",
  };
  Object.keys(fm).forEach(sel=>{
    const el = node.querySelector(sel);
    if(el) el.value = data[fm[sel]] || "";
  });

  node.dataset.id = data.id || generateId();
  return node;
}

function collectFamilyCard(node){
  const relSel  = node.querySelector(".family-relation");
  const eduSel  = node.querySelector(".family-education");
  const talkSel = node.querySelector(".family-talkType");
  return createFamilyData({
    id: node.dataset.id,
    relation: relSel.value || "",
    relationName: node.querySelector(".family-relationName").value.trim(),
    birthdate: node.querySelector(".family-birthdate").value,
    age: node.querySelector(".family-age").value.trim(),
    hometown: node.querySelector(".family-hometown").value.trim(),
    education: eduSel.value || "",
    schoolName: node.querySelector(".family-schoolName").value.trim(),
    currentJob: node.querySelector(".family-currentJob").value.trim(),
    jobHistory: node.querySelector(".family-jobHistory").value.trim(),
    personality: node.querySelector(".family-personality").value.trim(),
    hobby: node.querySelector(".family-hobby").value.trim(),
    favoriteFood: node.querySelector(".family-favoriteFood").value.trim(),
    talkType: talkSel.value || "",
  });
}

function collectAllFamilyData(){
  return Array.from(document.querySelectorAll("#familyList .family-card")).map(collectFamilyCard);
}

/* ============================================================
   並び替え・削除・追加ボタンの有効/無効更新
   ============================================================ */
function refreshFamilyMoveButtons(){
  const cards = document.querySelectorAll("#familyList .family-card");
  cards.forEach((card,i)=>{
    card.querySelector(".move-up").disabled   = (i === 0);
    card.querySelector(".move-down").disabled = (i === cards.length - 1);
  });
}

function relationDisplay(data){
  return data.relation === "その他"
    ? (data.relationName || "その他")
    : (data.relation || "続柄未設定");
}

/* ============================================================
   カード内イベント（削除・移動・その他続柄表示切替）
   ============================================================ */
function bindFamilyCardEvents(node){
  node.querySelector(".delete-card").addEventListener("click", ()=>{
    if(!confirm("このカードを削除しますか？")) return;
    node.remove();
    refreshFamilyMoveButtons();
    saveDraft();
  });

  node.querySelector(".move-up").addEventListener("click", ()=>{
    const prev = node.previousElementSibling;
    if(prev) node.parentElement.insertBefore(node, prev);
    refreshFamilyMoveButtons();
    saveDraft();
  });
  node.querySelector(".move-down").addEventListener("click", ()=>{
    const next = node.nextElementSibling;
    if(next) node.parentElement.insertBefore(next, node);
    refreshFamilyMoveButtons();
    saveDraft();
  });

  node.querySelector(".family-relation").addEventListener("change", (e)=>{
    node.querySelector(".other-relation-field").classList.toggle("hidden", e.target.value !== "その他");
    saveDraft();
  });
}

function addFamilyCard(data={}){
  const node = renderFamilyCard(createFamilyData(data));
  document.getElementById("familyList").appendChild(node);
  bindFamilyCardEvents(node);
  refreshFamilyMoveButtons();
  return node;
}

/* ============================================================
   下書き保存／復元（この端末の中だけ。お相手には届かない）
   ============================================================ */
function saveDraft(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      list: collectAllFamilyData(),
      createdAt,
    }));
    flashSaved();
  }catch(e){ console.warn("draft save failed", e); }
}
function flashSaved(){
  const b = document.getElementById("saveStatus"); if(!b) return;
  b.classList.add("just-saved"); setTimeout(()=>b.classList.remove("just-saved"), 400);
}
function loadDraft(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY); if(!raw) return false;
    const data = JSON.parse(raw);
    createdAt = data.createdAt || null;
    (data.list||[]).forEach(item=>addFamilyCard(item));
    return (data.list && data.list.length > 0);
  }catch(e){ console.warn("draft load failed", e); return false; }
}

/* ============================================================
   送信データの収集
   ============================================================ */
function collectSubmitData(){
  return {
    list: collectAllFamilyData(),
    createdAt: createdAt || "",
  };
}

/* ============================================================
   ペア状態（パートナー登録確認・自分／お相手の家族紹介データ）
   ============================================================ */
const AppState = {
  ownerHash: null,
  aesKey: null,
  partnerDisplayName: "",
  ownSubmittedAt: null,   // 自分が最後に送信した日時（未送信ならnull）
  partnerCipherText: null, // お相手の暗号化データ（未送信ならnull）
  partnerUpdatedAt: null,
};

async function fetchPair(ownerHash){
  const url = `${GAS_ENDPOINT}?action=fetchPair&ownerHash=${encodeURIComponent(ownerHash)}`;
  const resp = await fetch(url, { method: "GET" });
  return resp.json();
}

async function submitOwnData(){
  const data = collectSubmitData();
  const cipherText = await encryptJSON(data, AppState.aesKey);
  const resp = await fetch(GAS_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // preflight回避のため text/plain を使用
    body: JSON.stringify({ action: "submit", ownerHash: AppState.ownerHash, cipherText }),
  });
  if(!resp.ok){
    const bodyText = await resp.text().catch(()=>"(本文を取得できませんでした)");
    console.error(`submit failed: HTTP ${resp.status} ${resp.statusText}`, bodyText);
    throw new Error(`http_${resp.status}`);
  }
  const result = await resp.json();
  if(!result.ok) throw new Error(result.reason || "submit_failed");
  AppState.ownSubmittedAt = result.updatedAt || new Date().toISOString();
  return result;
}

/* ============================================================
   状態表示（パートナー確認中・エラーなど）
   ============================================================ */
function showAppState(title, text, isLoading = false){
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

function showPartnerRequired(){
  document.getElementById("app").style.display = "none";
  document.getElementById("publicView").style.display = "none";
  document.getElementById("partnerRequired").style.display = "block";
}

function showApp(){
  document.getElementById("publicView").style.display = "none";
  document.getElementById("partnerRequired").style.display = "none";
  document.getElementById("app").style.display = "";
}

/* ============================================================
   パートナー登録確認（自動ペア判定）
   ============================================================ */
async function initPairing(){
  showAppState("読み込み中…", "パートナー登録の状況を確認しています。少々お待ちください。", true);

  const ownerHash = await sha256Hex(getLineUserId());
  AppState.ownerHash = ownerHash;

  let result;
  try{
    result = await fetchPair(ownerHash);
  }catch(e){
    console.error("fetchPair failed", e);
    showAppState("読み込みに失敗しました", "時間をおいてもう一度開き直してください。");
    return false;
  }

  if(!result.ok){
    if(result.reason === "no_partner" || result.reason === "partner_ended"){
      showPartnerRequired();
    }else{
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
  if(partnerBtn) partnerBtn.textContent = AppState.partnerDisplayName ? `${AppState.partnerDisplayName}さん` : "お相手";

  showApp();
  return true;
}

/* ペア情報だけを取り直す（画面遷移はせず、お相手の最新状況だけ更新） */
async function refetchPair(){
  let result;
  try{
    result = await fetchPair(AppState.ownerHash);
  }catch(e){
    console.error("refetchPair failed", e);
    alert("お相手の状況を取得できませんでした。通信環境を確認してもう一度お試しください。");
    return false;
  }
  if(!result.ok){
    // 取得中に交際終了などがあった場合は案内画面に戻す
    showPartnerRequired();
    return false;
  }
  AppState.partnerDisplayName = result.partnerDisplayName || "";
  AppState.partnerCipherText  = result.partner ? result.partner.cipherText : null;
  AppState.partnerUpdatedAt   = result.partner ? result.partner.updatedAt : null;
  const partnerBtn = document.getElementById("partnerTabBtn");
  if(partnerBtn) partnerBtn.textContent = AppState.partnerDisplayName ? `${AppState.partnerDisplayName}さん` : "お相手";
  return true;
}

/* ============================================================
   表示用 HTML ビルダー
   ============================================================ */
function decoFlourishSVG(){
  return `<svg viewBox="0 0 160 28" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 14 C32 3,50 25,76 13 S122 1,154 14" fill="none" stroke="#f4b8c5" stroke-width="2" stroke-linecap="round"/>
    <circle cx="24" cy="9" r="2.6" fill="#f48ca0"/><circle cx="58" cy="19" r="2.6" fill="#f48ca0"/>
    <circle cx="96" cy="8" r="2.6" fill="#f48ca0"/><circle cx="132" cy="18" r="2.6" fill="#f48ca0"/>
  </svg>`;
}

function formatDateLabel(iso){
  if(!iso) return "";
  const d = new Date(iso);
  if(isNaN(d.getTime())) return "";
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,"0")}/${String(d.getDate()).padStart(2,"0")}`;
}

function fieldRow(label, value){
  if(!value) return "";
  return `<div class="field-row"><span class="field-row-label">${escapeHTML(label)}</span><span class="field-row-value">${escapeHTML(value).replace(/\n/g,"<br>")}</span></div>`;
}

function buildFamilyListHTML(list){
  if(!list || list.length === 0){
    return `<div class="family-preview-empty">まだ家族カードが登録されていません。<br>「入力」タブから追加してください。</div>`;
  }
  return `<div class="family-preview-list">` + list.map(d=>{
    const birthAge = [d.birthdate ? d.birthdate.replace(/-/g,"/") : "", d.age ? `${d.age}歳` : ""].filter(Boolean).join("　");
    const eduLine  = [d.education, d.schoolName].filter(Boolean).join("　");
    return `
      <div class="family-preview-card">
        <div class="family-preview-heading">
          <span class="family-relation-badge">${escapeHTML(relationDisplay(d))}</span>
        </div>
        ${fieldRow("生年月日・年齢", birthAge)}
        ${fieldRow("出身", d.hometown)}
        ${fieldRow("最終学歴", eduLine)}
        ${fieldRow("現職", d.currentJob)}
        ${fieldRow("職歴", d.jobHistory)}
        ${fieldRow("性格", d.personality)}
        ${fieldRow("趣味", d.hobby)}
        ${fieldRow("好きな食べ物", d.favoriteFood)}
        ${fieldRow("話すタイプ", d.talkType)}
      </div>`;
  }).join("") + `</div>`;
}

/* ============================================================
   プレビュー 共通の描画（自分／お相手どちらも使う）
   ============================================================ */
function renderFamilyContent(container, list, opts={}){
  const { headingName="", dateIso="" } = opts;
  const dateLabel = formatDateLabel(dateIso||"");

  container.innerHTML = `
    <div class="family-view-header">
      <div class="family-view-header-deco">${decoFlourishSVG()}</div>
      <p class="family-view-title">${escapeHTML(headingName)}家族紹介</p>
      <p class="family-view-sub">FAMILY INTRODUCTION</p>
      ${dateLabel ? `<p class="family-view-date">作成日：${escapeHTML(dateLabel)}</p>` : ""}
    </div>
    ${buildFamilyListHTML(list)}
  `;
}

/* ----- 自分のプレビュー（編集中の内容をそのまま表示） ----- */
function renderOwnPreview(){
  renderFamilyContent(document.getElementById("previewContent"), collectAllFamilyData(), { headingName:"", dateIso: createdAt });
}

/* ----- お相手のプレビュー（まだ未送信なら案内のみ） ----- */
async function renderPartnerPreview(){
  const container = document.getElementById("previewContent");
  const name = AppState.partnerDisplayName || "お相手";

  if(!AppState.partnerCipherText){
    container.innerHTML = `
      <div class="family-preview-empty">
        ${escapeHTML(name)}さんはまだ家族紹介を送信していません。<br>
        送信されると、ここに表示されます。
      </div>
      <button type="button" class="partner-refresh-btn" id="partnerRefreshBtn">最新の状況を取得する</button>
    `;
  }else{
    let data;
    try{
      data = await decryptJSON(AppState.partnerCipherText, AppState.aesKey);
    }catch(e){
      console.error("decrypt partner data failed", e);
      container.innerHTML = `<div class="family-preview-empty">お相手のデータの復号に失敗しました。時間をおいてもう一度お試しください。</div>`;
      return;
    }
    renderFamilyContent(container, data.list||[], { headingName: `${name}さんの`, dateIso: data.createdAt });
    const html = container.innerHTML;
    container.innerHTML = html + `<button type="button" class="partner-refresh-btn" id="partnerRefreshBtn">最新の状況を取得する</button>`;
  }

  const refreshBtn = document.getElementById("partnerRefreshBtn");
  if(refreshBtn){
    refreshBtn.addEventListener("click", async ()=>{
      refreshBtn.disabled = true;
      refreshBtn.textContent = "取得中…";
      const ok = await refetchPair();
      if(ok && currentPreviewPerson === "partner") await renderPartnerPreview();
      refreshBtn.disabled = false;
      refreshBtn.textContent = "最新の状況を取得する";
    });
  }
}

/* ============================================================
   プレビュー：自分／お相手 切り替え
   ============================================================ */
let currentPreviewPerson = "own";

async function switchPreviewPerson(person){
  currentPreviewPerson = person;
  document.querySelectorAll(".preview-person-switcher .sub-switch-btn").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.person === person);
  });

  const ownSubmittedAtEl = document.getElementById("ownSubmittedAt");

  if(person === "own"){
    hideScreenshotWatermark();
    renderOwnPreview();
    if(ownSubmittedAtEl){
      if(AppState.ownSubmittedAt){
        ownSubmittedAtEl.textContent = `お相手への送信日時：${formatDateLabel(AppState.ownSubmittedAt)}`;
        ownSubmittedAtEl.classList.remove("hidden");
      }else{
        ownSubmittedAtEl.textContent = "まだお相手に送信していません。「送信する」を押すと届きます。";
        ownSubmittedAtEl.classList.remove("hidden");
      }
    }
  }else{
    if(ownSubmittedAtEl) ownSubmittedAtEl.classList.add("hidden");
    await renderPartnerPreview();
    showScreenshotWatermark(AppState.ownerHash);
  }
}

function renderFamilyPreview(){
  switchPreviewPerson(currentPreviewPerson);
}

/* ============================================================
   タブ切替
   ============================================================ */
function switchTab(tab){
  ["input","preview","settings"].forEach(t=>{
    document.getElementById(`tab-${t}`).classList.toggle("hidden", t !== tab);
  });
  document.querySelectorAll(".bottom-nav .nav-btn").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.tab === tab);
  });
  const titles = { preview:"プレビュー", settings:"設定" };
  document.getElementById("appBarTitle").textContent = titles[tab] || "家族紹介";

  if(tab === "preview"){
    if(!createdAt){ createdAt = new Date().toISOString(); saveDraft(); }
    switchPreviewPerson(currentPreviewPerson);
  }else{
    hideScreenshotWatermark();
  }
}

/* ============================================================
   イベント登録
   ============================================================ */
function bindEvents(){
  document.getElementById("addFamilyBtn").addEventListener("click", ()=>{
    addFamilyCard();
    saveDraft();
  });

  let saveTimer = null;
  document.getElementById("tab-input").addEventListener("input", ()=>{
    clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 500);
  });
  document.getElementById("tab-input").addEventListener("change", ()=>{
    clearTimeout(saveTimer); saveTimer = setTimeout(saveDraft, 500);
  });

  document.querySelectorAll(".bottom-nav .nav-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>switchTab(btn.dataset.tab));
  });
  document.getElementById("backToInputBtn").addEventListener("click", ()=>switchTab("input"));

  document.querySelectorAll(".preview-person-switcher .sub-switch-btn").forEach(btn=>{
    btn.addEventListener("click", ()=>switchPreviewPerson(btn.dataset.person));
  });

  /* ----- 送信ボタン：お相手へ直接送信（宛先選択は不要。登録済みのお相手にのみ届く） ----- */
  document.getElementById("sendBtn").addEventListener("click", async ()=>{
    const name = AppState.partnerDisplayName || "お相手";
    if(!confirm(`入力中の家族紹介を${name}さんに送信しますか？\n送信すると、これまでの内容が上書きされます。`)) return;

    const sendBtn = document.getElementById("sendBtn");
    sendBtn.disabled = true;
    const originalLabel = sendBtn.textContent;
    sendBtn.textContent = "送信中…";

    try{
      await submitOwnData();
      alert("送信しました。");
      if(currentPreviewPerson === "own") switchPreviewPerson("own");
    }catch(e){
      console.error("submit error", e);
      alert("送信に失敗しました。通信環境を確認してもう一度お試しください。");
    }finally{
      sendBtn.disabled = false;
      sendBtn.textContent = originalLabel;
    }
  });

  document.getElementById("resetFamilyBtn").addEventListener("click", ()=>{
    if(!confirm("入力内容を削除して最初から作成しますか？この操作は取り消せません。\n（すでにお相手に送信済みの内容は、この操作では削除されません）")) return;
    try{ localStorage.removeItem(STORAGE_KEY); }catch(_){}
    location.reload();
  });
}

/* ============================================================
   友だち追加チェック
   ============================================================ */
async function checkFriendship(){
  try{
    const friendship = await liff.getFriendship();
    if(!friendship.friendFlag){
      try{
        await liff.requestFriendship();
      }catch(error){
        console.warn("友だち追加リクエスト失敗（ユーザーがキャンセルした可能性があります）:", error);
      }
    }
  }catch(error){
    console.warn("友だち確認をスキップ:", error);
  }
}

/* ============================================================
   メイン処理
   ============================================================ */
(async()=>{
  try{ await liff.init({ liffId: LIFF_ID }); }
  catch(e){ console.error("LIFF init failed", e); alert("LIFFの初期化に失敗しました。"); return; }

  if(!liff.isLoggedIn()){ liff.login(); return; }

  /* LIFF初期化・ログイン後に友だち確認（未追加ならダイアログで追加を促す）
     通信を伴うため画面構築をブロックしないよう、裏側で実行する
     （fire-and-forget）。 */
  checkFriendship();

  /* パートナー登録の確認（未登録・交際終了なら案内を表示して終了） */
  const paired = await initPairing();
  if(!paired) return;

  const hadDraft = loadDraft();

  bindEvents();

  const startBtn  = document.getElementById("startBtn");
  const resumeBtn = document.getElementById("resumeBtn");
  if(hadDraft){ resumeBtn.classList.remove("hidden"); startBtn.textContent = "新しく作成する"; }

  function goToMain(){
    document.getElementById("screen-top").classList.add("hidden");
    document.getElementById("screen-main").classList.remove("hidden");
    switchTab("input");
  }

  startBtn.addEventListener("click", ()=>{
    if(hadDraft && !confirm("これまでの下書きを削除して、新しく作成しますか？\n（すでにお相手に送信済みの内容は、この操作では削除されません）")) return;
    if(hadDraft){
      document.getElementById("familyList").innerHTML = "";
      createdAt = null;
      try{ localStorage.removeItem(STORAGE_KEY); }catch(_){}
    }
    goToMain();
  });
  resumeBtn.addEventListener("click", goToMain);
})();
