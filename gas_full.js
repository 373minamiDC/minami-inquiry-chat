/**
 * みなみ歯科医院 問い合わせBOT — GAS 完全版
 *
 * このファイルを GAS スクリプトエディタに丸ごと貼り付けてデプロイしてください。
 *
 * 機能:
 *   doGet  → action=faq      : FAQ シートから全件取得
 *          → action=knowledge : KNOWLEDGE シートから取得（q 空なら全件）
 *   doPost → ログ保存（LOGS シートに追記）
 *
 * スプレッドシートのシート名:
 *   FAQ       : 列 q / a / k / enabled
 *   KNOWLEDGE : 列 doc_title / chunk_id / text
 *   LOGS      : 自動作成
 */

/* ======================================================================
 *  定数
 * ====================================================================== */
var SHEET_FAQ       = "FAQ";
var SHEET_KNOWLEDGE = "KNOWLEDGE";
var SHEET_LOGS      = "LOGS";

/* ======================================================================
 *  エントリポイント
 * ====================================================================== */

function doGet(e) {
  var action = String((e && e.parameter && e.parameter.action) || "").toLowerCase();
  if (action === "faq")       return handleFaq_(e);
  if (action === "knowledge") return handleKnowledge_(e);
  return json_({ ok: false, error: "unknown action: " + action });
}

function doPost(e) {
  var action = String((e && e.parameter && e.parameter.action) || "").toLowerCase();
  if (action === "add_faq") return handleAddFaq_(e);
  return handleLog_(e);
}

/* ======================================================================
 *  FAQ ハンドラ
 *  シート列: q / a / k / enabled
 *  返却: { ok: true, items: [{ q, a, k, enabled }, ...] }
 * ====================================================================== */

function handleFaq_(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_FAQ);
  if (!sh) return json_({ ok: true, items: [] });

  var values = sh.getDataRange().getValues();
  if (values.length <= 1) return json_({ ok: true, items: [] });

  var header = values[0].map(function(h) { return String(h || "").trim().toLowerCase(); });
  var idxQ       = header.indexOf("q");
  var idxA       = header.indexOf("a");
  var idxK       = header.indexOf("k");
  var idxEnabled = header.indexOf("enabled");

  if (idxQ === -1 || idxA === -1) return json_({ ok: true, items: [] });

  var items = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    var enabled = (idxEnabled >= 0) ? String(row[idxEnabled] || "").trim().toUpperCase() : "TRUE";
    if (enabled === "FALSE" || enabled === "0" || enabled === "NO") continue;

    var q = String(row[idxQ] || "").trim();
    var a = String(row[idxA] || "").trim();
    if (!q || !a) continue;

    var k = (idxK >= 0) ? String(row[idxK] || "").trim() : "";

    items.push({ q: q, a: a, k: k, enabled: true });
  }

  return json_({ ok: true, items: items });
}

/* ======================================================================
 *  Knowledge ハンドラ
 *  シート列: doc_title / chunk_id / text
 *  q パラメータ空 → 全件返却（Workers 側でスコアリング）
 *  q パラメータあり → GAS 側でスコアリングして返却
 *  返却: { ok: true, items: [{ doc_title, chunk_id, text }, ...] }
 * ====================================================================== */

function handleKnowledge_(e) {
  var qRaw = String((e && e.parameter && e.parameter.q) || "").trim();
  var limit = Math.max(1, Math.min(parseInt((e && e.parameter && e.parameter.limit) || "50", 10) || 50, 200));

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_KNOWLEDGE);
  if (!sh) return json_({ ok: true, items: [] });

  var values = sh.getDataRange().getValues();
  if (values.length <= 1) return json_({ ok: true, items: [] });

  var header = values[0].map(function(h) { return String(h || "").trim(); });
  var headerLower = header.map(function(h) { return h.toLowerCase(); });

  var idxTitle = headerLower.indexOf("doc_title");
  var idxChunk = headerLower.indexOf("chunk_id");

  var idxText = headerLower.indexOf("text");

  if (idxText === -1) {
    return json_({ ok: true, items: [] });
  }

  // q が空なら全件返す（Workers 側でスコアリングする）
  var q = normText_(qRaw);
  var tokens = tokenize_(q);

  if (!tokens.length) {
    var allItems = [];
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      var titleRaw = (idxTitle >= 0) ? String(row[idxTitle] || "") : "";
      var chunkRaw = (idxChunk >= 0) ? String(row[idxChunk] || "") : "";
      var textRaw  = String(row[idxText] || "");
      if (!textRaw) continue;
      allItems.push({ doc_title: titleRaw, chunk_id: chunkRaw, text: textRaw });
    }
    return json_({ ok: true, items: allItems.slice(0, limit) });
  }

  // q がある場合はスコアリングして返す
  var scored = [];

  for (var i = 1; i < values.length; i++) {
    var row = values[i];

    var titleRaw = (idxTitle >= 0) ? String(row[idxTitle] || "") : "";
    var chunkRaw = (idxChunk >= 0) ? String(row[idxChunk] || "") : "";
    var textRaw  = String(row[idxText] || "");
    if (!textRaw) continue;

    var title = normText_(titleRaw);
    var text  = normText_(textRaw);

    var score = scoreText_(title, text, tokens, q);
    if (score > 0) {
      scored.push({
        score: score,
        doc_title: titleRaw,
        chunk_id: chunkRaw,
        text: textRaw
      });
    }
  }

  scored.sort(function(a, b) { return b.score - a.score; });

  var items = scored.slice(0, limit).map(function(x) {
    return { doc_title: x.doc_title, chunk_id: x.chunk_id, text: x.text };
  });

  return json_({ ok: true, items: items });
}

/* ======================================================================
 *  FAQ 追加ハンドラ（doPost から呼ばれる）
 *  POST ?action=add_faq&token=xxx  body: { q, a, k, enabled }
 *  または body: { items: [{ q, a, k, enabled }, ...] } で複数追加
 * ====================================================================== */

function handleAddFaq_(e) {
  try {
    var token = String((e && e.parameter && e.parameter.token) || "").trim();
    if (!token) return json_({ ok: false, error: "missing token" });

    var body = JSON.parse(e.postData.contents);
    var items = Array.isArray(body.items) ? body.items : [body];

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEET_FAQ);
    if (!sh) return json_({ ok: false, error: "FAQ sheet not found" });

    var added = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var q = String(it.q || "").trim();
      var a = String(it.a || "").trim();
      var k = String(it.k || "").trim();
      var enabled = (it.enabled === false) ? "FALSE" : "TRUE";
      if (!q || !a) continue;
      sh.appendRow([q, a, k, enabled]);
      added++;
    }

    return json_({ ok: true, added: added });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

/* ======================================================================
 *  ログ保存ハンドラ（doPost から呼ばれる）
 *  Workers から POST で送られるログを LOGS シートに追記
 * ====================================================================== */

function handleLog_(e) {
  try {
    var token = String((e && e.parameter && e.parameter.token) || "").trim();
    if (!token) return json_({ ok: false, error: "missing token" });

    var body = JSON.parse(e.postData.contents);

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(SHEET_LOGS);

    if (!sh) {
      sh = ss.insertSheet(SHEET_LOGS);
      sh.appendRow([
        "timestamp", "session_id", "patient_name", "patient_dob",
        "user_message", "ai_reply", "user_agent", "page_url"
      ]);
    }

    sh.appendRow([
      new Date().toISOString(),
      body.session_id || "",
      body.name || (body.patient && body.patient.name) || "",
      body.dob || (body.patient && body.patient.dob) || "",
      body.user_text || body.user_message || "",
      body.assistant_text || body.ai_reply || "",
      body.user_agent || "",
      body.page_url || ""
    ]);

    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

/* ======================================================================
 *  ユーティリティ関数
 * ====================================================================== */

/** JSON レスポンスを返す */
function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** テキスト正規化（小文字化・全角→半角・記号除去） */
function normText_(s) {
  s = String(s || "").toLowerCase();
  // 全角英数 → 半角
  s = s.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
  // 全角カナ → 半角カナ はスキップ（日本語はそのまま）
  // スペース・記号を正規化
  s = s.replace(/[\s　]+/g, " ").trim();
  return s;
}

/** トークン分割（スペース区切り、短すぎるものは除外） */
function tokenize_(s) {
  return String(s || "").split(/[\s　]+/).filter(function(t) {
    return t.length >= 1;
  });
}

/** テキストスコアリング（title と text に対してトークンマッチ） */
function scoreText_(title, text, tokens, fullQuery) {
  var hay = (title + " " + text).toLowerCase();
  var score = 0;

  // 全文一致
  if (fullQuery && hay.indexOf(fullQuery) >= 0) {
    score += 20;
  }

  // 個別トークン
  for (var i = 0; i < tokens.length; i++) {
    if (hay.indexOf(tokens[i]) >= 0) {
      score += 5;
    }
  }

  return score;
}
