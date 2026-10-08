/* ============================================================
   家族紹介 – GAS バックエンド (Code.gs)
   スプレッドシートID: 18EsNFzS77rYcL1jGiGJ-JtOCCcyDGO1dVh9FSCUJjg4
   ------------------------------------------------------------
   ・シート「Shares」のみ作成（Analyticsシートは作成しない）
   ------------------------------------------------------------
   共有方式（自動ペア判定方式・プロポーズプランと同方式）:
   ・従来の「共有リンク（id＋復号鍵）を送る」方式はやめ、
     真剣交際パートナー機能連携（Partners中央API）による
     自動ペア判定方式に変更。
   ・ユーザーは own（自分）の家族紹介データを自分のLINEアカウント
     （ownerHashで識別）に紐づけて保存するだけでよい。リンクの
     発行・送付は一切不要。
   ・閲覧時は毎回 Partners中央API に ownerHash を問い合わせ、
     「現在の真剣交際パートナー」と「ペア専用の暗号鍵材料(pairKey)」
     を自動的に取得する。pairKeyから導出したAES鍵で、自分の
     データと相手のデータの両方を復号できる。
   ・パートナー登録が無い（または交際終了済みの）場合は、
     fetchPairがエラーを返す。クライアント側（app.js）はこれを
     見て「パートナー登録が必要です」という案内を表示する。
   ・pairKey の生値はユーザーには一切表示されず、ブラウザの
     メモリ上でAES鍵の導出にのみ使われる。
   ・自分のデータは「送信する」ボタンを押すまでお相手には見えない
     （行が存在しない＝未送信として扱う）。送信後は、押すたびに
     同じ行を上書きする（最新の内容が常にお相手に届く）。
   ------------------------------------------------------------
   デプロイ方法:
   1. スプレッドシートを開き「拡張機能 > Apps Script」でこのコードを貼り付ける。
   2. シート名「Shares」で、1行目に見出し（OWNER_HASH, CIPHER_TEXT,
      SCHEMA_VERSION, CREATED_AT, UPDATED_AT）を作成しておく。
      ※旧バージョン（共有リンク方式）からの移行の場合は、列構成が
        変わるため、新しいシートとして作り直すことを推奨します。
   3. 「デプロイ > 新しいデプロイ」→ 種類「ウェブアプリ」
      - 実行するユーザー: 自分
      - アクセスできるユーザー: 全員
      でデプロイする（すでに発行済みの /exec URL を app.js の
      GAS_ENDPOINT に設定済み）。
   ============================================================ */

var SPREADSHEET_ID = '18EsNFzS77rYcL1jGiGJ-JtOCCcyDGO1dVh9FSCUJjg4';
var SHEET_NAME      = 'Shares';
var SCHEMA_VERSION  = 1;

// シートの列番号（1-indexed）
var COL = {
  OWNER_HASH: 1, CIPHER_TEXT: 2, SCHEMA_VERSION: 3, CREATED_AT: 4, UPDATED_AT: 5
};

var DATA_START_ROW = 2; // 1行目=見出し, 2行目以降がデータ

/* ------------------------------------------------------------
   真剣交際パートナー機能連携（Partners中央API）
   ・このアプリにはAnalyticsシートが無いため、fetchPair側の
     アクセス制御のみ対応する（Analytics同期は不要）。
   ・status アクションのレスポンスには、他アプリ（selfintroduction等）
     で使われている active / everPartnered / partnerHash に加えて、
     プロポーズプランと同じ方式で使う pairKey（ペア専用の暗号鍵材料）と
     partnerDisplayName（お相手がパートナー登録時に設定した表示名）が
     含まれている前提です。もしPartners中央API側がまだこれらの
     フィールドを返していない場合は、Partners側（別デプロイのコード）
     を先に拡張してください。
   ------------------------------------------------------------ */
var PARTNERS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzqT-qmVRh_jI04stlgYiWCypqWHjWkGv-0pNGkpvUt3c8FGQzQG_FBF7eWeb3frcDk/exec'; // ← Partners用GASの/exec URLを設定
var INTERNAL_SECRET    = PropertiesService.getScriptProperties().getProperty('INTERNAL_SECRET') || '';

/* 指定ownerHashの現在の真剣交際ステータスをPartners APIに問い合わせる。
   ・ active: true  → 現在のパートナー。partnerHash・pairKey・
     partnerDisplayName が有効。
   ・ everPartnered: true（かつ active:false）→ 過去に交際していたが
     現在はパートナー不在（交際終了後など）。
   ・ 両方 false → パートナー登録が一度も行われていない。
   結果は900秒（15分）キャッシュし、Partners API不通時はエラー扱いにする
   （このアプリの性質上、パートナー不在として誤って他人に見せるより、
   　読み込みエラーとして安全側に倒す）。 */
var PARTNER_STATUS_CACHE_SECONDS = 900;

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
  // 問い合わせ自体に失敗した場合（result.ok === false）は、誤って
  // 「パートナー不在」として扱われないよう、短めのTTLのみキャッシュする。
  cache.put(cacheKey, JSON.stringify(result), result.ok ? PARTNER_STATUS_CACHE_SECONDS : 30);
  return result;
}


/* ------------------------------------------------------------
   エントリポイント
   ------------------------------------------------------------ */
function doGet(e) {
  try {
    var action = e.parameter.action;
    if (action === 'fetchPair') {
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

function getSheet() {
  return SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName(SHEET_NAME);
}


/* ------------------------------------------------------------
   自分のデータを探す／保存する（ownerHash一意キー）
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

function readRow(sheet, rowIndex) {
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
   ------------------------------------------------------------ */
function handleSubmit(body) {
  var ownerHash  = body.ownerHash;
  var cipherText = body.cipherText;

  if (!ownerHash || !cipherText) {
    return jsonResponse({ ok: false, reason: 'invalid_params' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSheet();
    var now = new Date();
    var rowIndex = findRowByOwnerHash(sheet, ownerHash);

    if (rowIndex) {
      sheet.getRange(rowIndex, COL.CIPHER_TEXT).setValue(cipherText);
      sheet.getRange(rowIndex, COL.UPDATED_AT).setValue(now);
    } else {
      sheet.appendRow([ownerHash, cipherText, SCHEMA_VERSION, now, now]);
    }

    return jsonResponse({ ok: true, updatedAt: now.toISOString() });
  } finally {
    lock.releaseLock();
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

  var sheet = getSheet();
  var ownRow     = readRow(sheet, findRowByOwnerHash(sheet, ownerHash));
  var partnerRow = readRow(sheet, findRowByOwnerHash(sheet, partnerInfo.partnerHash));

  return jsonResponse({
    ok: true,
    pairKey: partnerInfo.pairKey,
    partnerDisplayName: partnerInfo.partnerDisplayName || '',
    own: ownRow ? { cipherText: ownRow.cipherText, updatedAt: ownRow.updatedAt } : null,
    partner: partnerRow ? { cipherText: partnerRow.cipherText, updatedAt: partnerRow.updatedAt } : null
  });
}
