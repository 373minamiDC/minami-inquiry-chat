/**
 * ===== GAS 修正箇所 =====
 * handleKnowledge_ 関数を以下に差し替えてください。
 *
 * 変更点：q パラメータが空のとき、全件を返すようにしました。
 * これにより Workers 側でキャッシュ＋スコアリングが正しく動作します。
 */

function handleKnowledge_(e) {
  const qRaw = String((e && e.parameter && e.parameter.q) || "").trim();
  const limit = Math.max(1, Math.min(parseInt((e && e.parameter && e.parameter.limit) || "50", 10) || 50, 200));

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_KNOWLEDGE);
  if (!sh) return json_({ ok: true, items: [] });

  const values = sh.getDataRange().getValues();
  if (values.length <= 1) return json_({ ok: true, items: [] });

  const header = values[0].map(h => String(h || "").trim());
  const headerLower = header.map(h => h.toLowerCase());

  const idxTitle = headerLower.indexOf("doc_title");
  const idxChunk = headerLower.indexOf("chunk_id");

  let idxText = headerLower.indexOf("text");
  if (idxText === -1) idxText = headerLower.indexOf("TEXT".toLowerCase());
  if (idxText === -1) idxText = headerLower.indexOf("Text".toLowerCase());

  if (idxText === -1) {
    return json_({ ok: true, items: [] });
  }

  // ★修正点：q が空なら全件返す（Workers 側でスコアリングする）
  const q = normText_(qRaw);
  const tokens = tokenize_(q);

  if (!tokens.length) {
    // 全件返却
    const allItems = [];
    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      const titleRaw = (idxTitle >= 0) ? String(row[idxTitle] || "") : "";
      const chunkRaw = (idxChunk >= 0) ? String(row[idxChunk] || "") : "";
      const textRaw  = String(row[idxText] || "");
      if (!textRaw) continue;
      allItems.push({ doc_title: titleRaw, chunk_id: chunkRaw, text: textRaw });
    }
    return json_({ ok: true, items: allItems.slice(0, limit) });
  }

  // q がある場合は従来どおりスコアリングして返す
  const scored = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];

    const titleRaw = (idxTitle >= 0) ? String(row[idxTitle] || "") : "";
    const chunkRaw = (idxChunk >= 0) ? String(row[idxChunk] || "") : "";
    const textRaw  = String(row[idxText] || "");
    if (!textRaw) continue;

    const title = normText_(titleRaw);
    const text  = normText_(textRaw);

    const score = scoreText_(title, text, tokens, q);
    if (score > 0) {
      scored.push({
        score,
        doc_title: titleRaw,
        chunk_id: chunkRaw,
        text: textRaw
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const items = scored.slice(0, limit).map(x => ({
    doc_title: x.doc_title,
    chunk_id: x.chunk_id,
    text: x.text
  }));

  return json_({ ok: true, items });
}
