/* ============================================================
   住まい すり合わせ – GAS バックエンド (Code.gs)
   ------------------------------------------------------------
   ・Shares    シート : 共有用の暗号化済み回答（本人／初回閲覧者のみ復号可）
   ・Analytics シート : 統計集計に必要な項目のみを平文で保存
   ------------------------------------------------------------
   セットアップ:
   1. 新しいスプレッドシートを作成し、「Shares」「Analytics」の2シートを作る
      （1行目は見出し行。Sharesは下記COL順、Analyticsは空でOK＝初回送信時に
        見出しが自動作成され、Q4の項目列も自動で追加される）。
   2. SPREADSHEET_ID を書き換える。
   3. 「デプロイ > 新しいデプロイ > ウェブアプリ」
      （実行ユーザー: 自分／アクセスできるユーザー: 全員）→ /exec URL を
      app.js の GAS_ENDPOINT に設定する。
   Sharesシート見出し例:
   id, cipherText, encryptedKey, ownerHash, viewerHash, status, schemaVersion,
   createdAt, updatedAt, firstViewedAt, lastViewedAt, viewCount
   ============================================================ */

var SPREADSHEET_ID  = 'YOUR_SPREADSHEET_ID';   // ← 要設定
var SHARES_SHEET    = 'Shares';
var ANALYTICS_SHEET = 'Analytics';
var SCHEMA_VERSION  = 1;

// Shares シートの列番号（1-indexed）
var COL = {
  ID: 1, CIPHER_TEXT: 2, ENCRYPTED_KEY: 3, OWNER_HASH: 4, VIEWER_HASH: 5,
  STATUS: 6, SCHEMA_VERSION: 7, CREATED_AT: 8, UPDATED_AT: 9,
  FIRST_VIEWED_AT: 10, LAST_VIEWED_AT: 11, VIEW_COUNT: 12
};

// Analytics シートの先頭固定列（以降のQ1〜Q4列は見出し名で自動管理）
var ANALYTICS_BASE_HEADERS = [
  'id', 'ownerHash', 'viewerHash', 'createdAt',
  'serious_relationship_status', 'partner_hash',
  'serious_relationship_started_at', 'serious_relationship_ended_at'
];
var ACOL = {
  ID: 1, OWNER_HASH: 2, VIEWER_HASH: 3, CREATED_AT: 4,
  SERIOUS_RELATIONSHIP_STATUS: 5, PARTNER_HASH: 6,
  SERIOUS_RELATIONSHIP_STARTED_AT: 7, SERIOUS_RELATIONSHIP_ENDED_AT: 8
};

var DATA_START_ROW = 2; // 1行目=見出し, 2行目以降がデータ

/* ------------------------------------------------------------
   真剣交際パートナー機能連携（Partners中央API）
   ------------------------------------------------------------ */
var PARTNERS_ENDPOINT = 'https://script.google.com/macros/s/AKfycbzqT-qmVRh_jI04stlgYiWCypqWHjWkGv-0pNGkpvUt3c8FGQzQG_FBF7eWeb3frcDk/exec';
var INTERNAL_SECRET   = PropertiesService.getScriptProperties().getProperty('INTERNAL_SECRET') || '';
var PARTNER_STATUS_CACHE_SECONDS = 900;

/* 真剣交際ステータスを問い合わせる（15分キャッシュ／API不通時は従来ロジックにフォールバック）
   ・active        → viewerHash が partnerHash と一致する場合のみ閲覧許可
   ・everPartnered → 過去に交際歴あり・現在不在。本人以外には見せない
   ・両方false     → 「初回閲覧者固定」ロジック */
function getPartnerStatus(ownerHash) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'partner_' + ownerHash;
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  var result = { active: false, everPartnered: false, partnerHash: '' };
  try {
    var url = PARTNERS_ENDPOINT + '?action=status'
      + '&ownerHash=' + encodeURIComponent(ownerHash)
      + '&secret=' + encodeURIComponent(INTERNAL_SECRET);
    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var body = JSON.parse(res.getContentText());
    if (body.ok) {
      result = {
        active: !!body.active,
        everPartnered: !!body.everPartnered,
        partnerHash: body.partnerHash || ''
      };
    }
  } catch (err) {
    Logger.log('getPartnerStatus failed: ' + err);
  }
  cache.put(cacheKey, JSON.stringify(result), PARTNER_STATUS_CACHE_SECONDS);
  return result;
}

/* ------------------------------------------------------------
   エントリポイント
   ------------------------------------------------------------ */
function doGet(e) {
  try {
    if (e.parameter.action === 'view') {
      return handleView(e.parameter.id, e.parameter.viewerHash);
    }
    return jsonResponse({ ok: false, reason: 'invalid_action' });
  } catch (err) {
    return jsonResponse({ ok: false, reason: 'server_error', message: String(err) });
  }
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.action === 'share') return handleShare(body);
    if (body.action === 'syncPartnerStatus') return handleSyncPartnerStatus(body);
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

/* ------------------------------------------------------------
   共有登録（回答の保存）
   ・cipherText はクライアント側でAES-GCM暗号化済み。復号鍵は受け取らない。
   ・Analytics: 同じ ownerHash は完全上書き（1人1行）。交際ステータス列は保持。
   ・Shares: 同じ ownerHash の「まだ誰にも開かれていない行」だけ上書き。
     開かれた行は履歴として残し、新しい行を追加する。
   ------------------------------------------------------------ */
function handleShare(body) {
  var id         = body.id;
  var cipherText = body.cipherText;
  var ownerHash  = body.ownerHash;
  var analytics  = body.analytics || {};

  if (!id || !cipherText || !ownerHash) {
    return jsonResponse({ ok: false, reason: 'invalid_params' });
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = getSpreadsheet();
    var sharesSheet    = ss.getSheetByName(SHARES_SHEET);
    var analyticsSheet = ss.getSheetByName(ANALYTICS_SHEET);
    var now = new Date();

    var shareRow = [id, cipherText, '', ownerHash, '', 'active', SCHEMA_VERSION, now, now, '', '', 0];
    upsertUnviewedShareRow(sharesSheet, ownerHash, shareRow);

    upsertAnalyticsRow(analyticsSheet, ownerHash, id, now, analytics);

    return jsonResponse({ ok: true, id: id });
  } finally {
    lock.releaseLock();
  }
}

function upsertUnviewedShareRow(sheet, ownerHash, rowValues) {
  var lastRow = sheet.getLastRow();
  var targetRow = null;
  if (lastRow >= DATA_START_ROW) {
    var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, COL.VIEWER_HASH).getValues();
    for (var i = 0; i < values.length; i++) {
      if (values[i][COL.OWNER_HASH - 1] === ownerHash && !values[i][COL.VIEWER_HASH - 1]) {
        targetRow = DATA_START_ROW + i;
        break;
      }
    }
  }
  if (targetRow) {
    sheet.getRange(targetRow, 1, 1, rowValues.length).setValues([rowValues]);
  } else {
    sheet.appendRow(rowValues);
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

function upsertAnalyticsRow(sheet, ownerHash, id, now, analytics) {
  var headers = ensureAnalyticsHeaders(sheet, Object.keys(analytics));
  var targetRow = findAnalyticsRowByOwnerHash(sheet, ownerHash);

  // 既存行がある場合、交際ステータス関連の列（5〜8列目）は保持する
  var keep = ['', '', '', ''];
  if (targetRow) {
    keep = sheet.getRange(targetRow, ACOL.SERIOUS_RELATIONSHIP_STATUS, 1, 4).getValues()[0];
  }

  var base = {
    'id': id, 'ownerHash': ownerHash, 'viewerHash': '', 'createdAt': now,
    'serious_relationship_status': keep[0], 'partner_hash': keep[1],
    'serious_relationship_started_at': keep[2], 'serious_relationship_ended_at': keep[3]
  };

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
   閲覧（共有リンクを開いたとき）
   ・本人 → 常に許可
   ・交際中 → パートナーのみ許可／交際歴あり・現在不在 → 本人のみ
   ・それ以外 → 初回閲覧者を登録し、以降はその人のみ許可
   ------------------------------------------------------------ */
function handleView(id, viewerHash) {
  if (!id) return jsonResponse({ ok: false, reason: 'invalid_params' });
  if (!viewerHash) return jsonResponse({ ok: false, reason: 'login_required' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSpreadsheet().getSheetByName(SHARES_SHEET);
    var rowIndex = findRowById(sheet, id);
    if (!rowIndex) return jsonResponse({ ok: false, reason: 'not_found' });

    var row = sheet.getRange(rowIndex, 1, 1, COL.VIEW_COUNT).getValues()[0];
    var cipherText         = row[COL.CIPHER_TEXT - 1];
    var ownerHash          = row[COL.OWNER_HASH - 1];
    var existingViewerHash = row[COL.VIEWER_HASH - 1];
    var status             = row[COL.STATUS - 1];

    if (status !== 'active') {
      return jsonResponse({ ok: false, reason: status || 'not_found' });
    }

    var now = new Date();
    var allowed = false;
    var partnerInfo = getPartnerStatus(ownerHash);

    if (viewerHash === ownerHash) {
      allowed = true;
    } else if (partnerInfo.active) {
      allowed = (viewerHash === partnerInfo.partnerHash);
    } else if (partnerInfo.everPartnered) {
      allowed = false;
    } else if (!existingViewerHash) {
      allowed = true;
      sheet.getRange(rowIndex, COL.VIEWER_HASH).setValue(viewerHash);
      sheet.getRange(rowIndex, COL.FIRST_VIEWED_AT).setValue(now);
      updateAnalyticsViewerHash(id, viewerHash);
    } else if (existingViewerHash === viewerHash) {
      allowed = true;
    }

    if (!allowed) {
      return jsonResponse({
        ok: false,
        reason: (partnerInfo.active || partnerInfo.everPartnered) ? 'partner_locked' : 'forbidden'
      });
    }

    sheet.getRange(rowIndex, COL.LAST_VIEWED_AT).setValue(now);
    var viewCountCell = sheet.getRange(rowIndex, COL.VIEW_COUNT);
    viewCountCell.setValue((Number(viewCountCell.getValue()) || 0) + 1);

    return jsonResponse({ ok: true, cipherText: cipherText });
  } finally {
    lock.releaseLock();
  }
}

function updateAnalyticsViewerHash(id, viewerHash) {
  var sheet = getSpreadsheet().getSheetByName(ANALYTICS_SHEET);
  var rowIndex = findRowById(sheet, id);
  if (rowIndex) sheet.getRange(rowIndex, ACOL.VIEWER_HASH).setValue(viewerHash);
}

/* ------------------------------------------------------------
   Partners APIからの真剣交際ステータス同期
   ------------------------------------------------------------ */
function handleSyncPartnerStatus(body) {
  if (!INTERNAL_SECRET || body.secret !== INTERNAL_SECRET) {
    return jsonResponse({ ok: false, reason: 'forbidden' });
  }
  var ownerHash = body.ownerHash;
  if (!ownerHash) return jsonResponse({ ok: false, reason: 'invalid_params' });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = getSpreadsheet().getSheetByName(ANALYTICS_SHEET);
    var rowIndex = findAnalyticsRowByOwnerHash(sheet, ownerHash);
    if (!rowIndex) return jsonResponse({ ok: true, skipped: true });

    sheet.getRange(rowIndex, ACOL.SERIOUS_RELATIONSHIP_STATUS).setValue(body.status || '');
    sheet.getRange(rowIndex, ACOL.PARTNER_HASH).setValue(body.partnerHash || '');
    sheet.getRange(rowIndex, ACOL.SERIOUS_RELATIONSHIP_STARTED_AT).setValue(body.startedAt || '');
    sheet.getRange(rowIndex, ACOL.SERIOUS_RELATIONSHIP_ENDED_AT).setValue(body.endedAt || '');
    return jsonResponse({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------
   検索ヘルパー
   ------------------------------------------------------------ */
function findAnalyticsRowByOwnerHash(sheet, ownerHash) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var values = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, ACOL.OWNER_HASH).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][ACOL.OWNER_HASH - 1] === ownerHash) return DATA_START_ROW + i;
  }
  return null;
}

function findRowById(sheet, id) {
  var lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return null;
  var ids = sheet.getRange(DATA_START_ROW, 1, lastRow - DATA_START_ROW + 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (ids[i][0] === id) return DATA_START_ROW + i;
  }
  return null;
}
