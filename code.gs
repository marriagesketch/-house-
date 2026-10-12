/* ============================================================
   住まい すり合わせ – GAS バックエンド (Code.gs)
   ------------------------------------------------------------
   ・シート「Shares」    : 自分の回答（暗号化済み・ownerHash一意）
   ・シート「Analytics」 : 統計集計用に必要な項目のみを平文で保存
   ------------------------------------------------------------
   共有方式（自動ペア判定方式・家族紹介／プロポーズプランと同方式）:
   ・共有リンク（id＋復号鍵）を送り合う方式はやめ、
     真剣交際パートナー機能連携（Partners中央API）による
     自動ペア判定方式を採用。
   ・ユーザーは own（自分）の回答を自分のLINEアカウント
     （ownerHashで識別）に紐づけて保存するだけでよい。リンクの
     発行・送付は一切不要。
   ・閲覧時は毎回 Partners中央API に ownerHash を問い合わせ、
     「現在の真剣交際パートナー」と「ペア専用の暗号鍵材料(pairKey)」
     を自動的に取得する。pairKeyから導出したAES鍵で、自分の
     回答とお相手の回答の両方を復号できる。
   ・パートナー登録が無い（または交際終了済みの）場合は、
     fetchPairがエラーを返す。クライアント側（app.js）はこれを
     見て「パートナー登録が必要です」という案内を表示する。
   ・pairKey の生値はユーザーには一切表示されず、ブラウザの
     メモリ上でAES鍵の導出にのみ使われる。
   ・自分の回答は「送信する」ボタンを押すまでお相手には見えない
     （行が存在しない＝未送信として扱う）。送信後は、押すたびに
     同じ行を上書きする（最新の内容が常にお相手に届く）。
   ------------------------------------------------------------
   デプロイ方法:
   1. 新しいスプレッドシートを作成し、「拡張機能 > Apps Script」で
      このコードを貼り付ける。
   2. シート名「Shares」を作成し、1行目に見出し
      （ownerHash, cipherText, schemaVersion, createdAt, updatedAt）
      を入れておく。シート名「Analytics」は空のままでよい
      （初回送信時に見出しとQ4の項目列が自動作成される）。
   3. SPREADSHEET_ID を書き換える。
   4. 「デプロイ > 新しいデプロイ」→ 種類「ウェブアプリ」
      - 実行するユーザー: 自分
      - アクセスできるユーザー: 全員
      でデプロイし、発行された /exec URL を app.js の
      GAS_ENDPOINT に設定する。
   ============================================================ */

var SPREADSHEET_ID  = '1nL6nMZyMPt1fHtXb6ZworDNjwEtKK3x8Y3v10iK8jxA';   // ← 要設定
var SHARES_SHEET    = 'Shares';
var ANALYTICS_SHEET = 'Analytics';
var SCHEMA_VERSION  = 1;

// Shares シートの列番号（1-indexed）
var COL = {
  OWNER_HASH: 1, CIPHER_TEXT: 2, SCHEMA_VERSION: 3, CREATED_AT: 4, UPDATED_AT: 5
};

// Analytics シートの先頭固定列（以降のQ1〜Q5列は見出し名で自動管理）
var ANALYTICS_BASE_HEADERS = ['ownerHash', 'createdAt', 'updatedAt'];
var ACOL = { OWNER_HASH: 1, CREATED_AT: 2, UPDATED_AT: 3 };

var DATA_START_ROW = 2; // 1行目=見出し, 2行目以降がデータ

/* ------------------------------------------------------------
   真剣交際パートナー機能連携（Partners中央API）
   ・status アクションのレスポンスには、家族紹介／プロポーズプランと
     同じ方式で使う pairKey（ペア専用の暗号鍵材料）と
     partnerDisplayName（お相手がパートナー登録時に設定した表示名）が
     含まれている前提です。
   ------------------------------------------------------------ */
var PARTNERS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzqT-qmVRh_jI04stlgYiWCypqWHjWkGv-0pNGkpvUt3c8FGQzQG_FBF7eWeb3frcDk/exec'; // ← Partners用GASの/exec URL
var INTERNAL_SECRET    = PropertiesService.getScriptProperties().getProperty('INTERNAL_SECRET') || '';
var PARTNER_STATUS_CACHE_SECONDS = 900;

/* 指定ownerHashの現在の真剣交際ステータスをPartners APIに問い合わせる。
   ・ active: true  → 現在のパートナー。partnerHash・pairKey・
     partnerDisplayName が有効。
   ・ everPartnered: true（かつ active:false）→ 過去に交際していたが
     現在はパートナー不在（交際終了後など）。
   ・ 両方 false → パートナー登録が一度も行われていない。
   結果は900秒（15分）キャッシュし、Partners API不通時はエラー扱いにする
   （パートナー不在として誤って他人に見せるより、読み込みエラーとして
   安全側に倒す）。 */
function getPartnerStatus(ownerHash) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'partner_' + ownerHash;
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var result = { ok: false, active: false, everPartnered: false, partnerHash: '', pairKey: '', partnerDisplayName: '' };
  try {
    var url = PARTNERS_ENDPOINT + '?action=status'
      + '&ownerHash=' + encodeURIComponent(ownerHash)
      + '&secret=' + encodeURIComponent(INTERNAL_SECRET);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var body = JSON.parse(res.getContentText());
    if (body.ok) {
      result = {
        ok: true,
        active: !!body.active,
        everPartnered: !!body.everPartnered,
        partnerHash: body.partnerHash || '',
        pairKey: body.pairKey || '',
        partnerDisplayName: body.partnerDisplayName || ''
      };
    }
  } catch (err) {
    Logger.log('getPartnerStatus failed: ' + err);
  }
  cache.put(cacheKey, JSON.stringify(result), result.ok ? PARTNER_STATUS_CACHE_SECONDS : 30);
  return result;
}

/* ------------------------------------------------------------
   エントリポイント
   ------------------------------------------------------------ */
function doGet(e) {
  try {
    if (e.parameter.action === 'fetchPair') {
      return handleFetchPair(e.parameter.ownerHash);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'submit') {
      return handleSubmit(body);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getSpreadsheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}

function getSharesSheet() {
  return getSpreadsheet().getSheetByName(SHARES_SHEET);
}

/* ------------------------------------------------------------
   自分のデータを探す（ownerHash一意キー）
   ------------------------------------------------------------ */
function findRowByOwnerHash(sheet, ownerHash) {
  if (!ownerHash) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var hashes = sheet.getRange(DATA_START_ROW, COL.OWNER_HASH, lastRow - DATA_START_ROW + 1, 1).getValues();
  for (var i = 0; i < hashes.length; i++) {
    if (hashes[i][0] === ownerHash) return DATA_START_ROW + i;
  }
  return null;
}

function readShareRow(sheet, rowIndex) {
  if (!rowIndex) return null;
  var row = sheet.getRange(rowIndex, 1, 1, COL.UPDATED_AT).getValues()[0];
  return {
    cipherText: row[COL.CIPHER_TEXT - 1],
    updatedAt:  row[COL.UPDATED_AT - 1]
  };
}

/* ------------------------------------------------------------
   送信（＝自分の行を作成／上書き）
   ・この行が存在する＝お相手が閲覧可能な「送信済み」の状態。
   ・送信するたびに同じ行の中身だけを最新化する（履歴は持たない）。
   ・Analyticsシートにも、集計用の平文データを同じタイミングで保存する。
   ------------------------------------------------------------ */
function handleSubmit(body) {
  var ownerHash  = body.ownerHash;
  var cipherText = body.cipherText;
  var analytics  = body.analytics || {};

  if (!ownerHash || !cipherText) {
    return jsonResponse({ ok: false, reason: 'invalid_params' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = getSpreadsheet();
    var sharesSheet    = ss.getSheetByName(SHARES_SHEET);
    var analyticsSheet = ss.getSheetByName(ANALYTICS_SHEET);
    var now = new Date();

    var rowIndex = findRowByOwnerHash(sharesSheet, ownerHash);
    if (rowIndex) {
      sharesSheet.getRange(rowIndex, COL.CIPHER_TEXT).setValue(cipherText);
      sharesSheet.getRange(rowIndex, COL.UPDATED_AT).setValue(now);
    } else {
      sharesSheet.appendRow([ownerHash, cipherText, SCHEMA_VERSION, now, now]);
    }

    upsertAnalyticsRow(analyticsSheet, ownerHash, now, analytics);

    return jsonResponse({ ok: true, updatedAt: now.toISOString() });
  } finally {
    lock.releaseLock();
  }
}

/* Analyticsシートの見出し行を確認し、無い列（q1_self, q4_エレベーター…）は
   右端に自動追加して、最新の見出し配列を返す。 */
function ensureAnalyticsHeaders(sheet, keys) {
  var lastCol = sheet.getLastColumn();
  var headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];

  if (headers.length === 0 || headers[0] === '') {
    headers = ANALYTICS_BASE_HEADERS.slice();
  }
  var missing = keys.filter(function (k) { return headers.indexOf(k) === -1; });
  if (missing.length > 0) headers = headers.concat(missing);

  if (headers.length !== lastCol || missing.length > 0 || lastCol === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return headers;
}

function findAnalyticsRowByOwnerHash(sheet, ownerHash) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, ACOL.OWNER_HASH).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][ACOL.OWNER_HASH - 1] === ownerHash) return DATA_START_ROW + i;
  }
  return null;
}

function upsertAnalyticsRow(sheet, ownerHash, now, analytics) {
  var headers = ensureAnalyticsHeaders(sheet, Object.keys(analytics));
  var targetRow = findAnalyticsRowByOwnerHash(sheet, ownerHash);

  var createdAt = now;
  if (targetRow) {
    createdAt = sheet.getRange(targetRow, ACOL.CREATED_AT).getValue() || now;
  }

  var base = { 'ownerHash': ownerHash, 'createdAt': createdAt, 'updatedAt': now };
  var row = headers.map(function (h) {
    if (base.hasOwnProperty(h)) return base[h];
    return analytics[h] !== undefined && analytics[h] !== null ? analytics[h] : '';
  });

  if (targetRow) {
    sheet.getRange(targetRow, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
}

/* ------------------------------------------------------------
   ペア情報の取得（自分のデータ・お相手のデータ・ペア鍵材料）
   アクセス制御:
   ・現在、真剣交際中のパートナーがいない場合は拒否
     （reason: 'no_partner' または 'partner_ended'）。
   ・真剣交際中の場合のみ、自分の行とお相手（partnerHash）の行を
     返す。どちらも「行が存在しない＝まだ送信していない」として
     null を返す。
   ------------------------------------------------------------ */
function handleFetchPair(ownerHash) {
  if (!ownerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });

  var partnerInfo = getPartnerStatus(ownerHash);
  if (!partnerInfo.ok) {
    return jsonResponse({ ok: false, reason: 'server_error' });
  }
  if (!partnerInfo.active) {
    return jsonResponse({ ok: false, reason: partnerInfo.everPartnered ? 'partner_ended' : 'no_partner' });
  }
  if (!partnerInfo.pairKey) {
    // Partners APIがpairKeyを返していない（未対応）場合はサーバーエラー扱い
    return jsonResponse({ ok: false, reason: 'server_error' });
  }

  var sheet = getSharesSheet();
  var ownRow     = readShareRow(sheet, findRowByOwnerHash(sheet, ownerHash));
  var partnerRow = readShareRow(sheet, findRowByOwnerHash(sheet, partnerInfo.partnerHash));

  return jsonResponse({
    ok: true,
    pairKey: partnerInfo.pairKey,
    partnerDisplayName: partnerInfo.partnerDisplayName || '',
    own: ownRow ? { cipherText: ownRow.cipherText, updatedAt: ownRow.updatedAt } : null,
    partner: partnerRow ? { cipherText: partnerRow.cipherText, updatedAt: partnerRow.updatedAt } : null
  });
}
