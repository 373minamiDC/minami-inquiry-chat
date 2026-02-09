/**
 * minami-inquiry-ai Worker（統合版）
 * FAQ フロー（ステップ分岐）＋ Knowledge（GAS連携）＋ OpenAI 汎用回答
 *
 * ===== 必要な環境変数（Cloudflare Workers Settings）=====
 * OPENAI_API_KEY        : OpenAI API Key
 * OPENAI_MODEL          : 例 "gpt-4o-mini"（未設定なら gpt-4o-mini）
 *
 * GAS_FAQ_URL           : FAQ用 GAS Web App URL（例: https://script.google.com/.../exec?action=faq）
 * GAS_KNOWLEDGE_URL     : Knowledge用 GAS Web App URL（例: https://script.google.com/.../exec?action=knowledge）
 * GAS_LOG_URL           : ログ保存用 GAS Web App URL（例: https://script.google.com/.../exec）
 * GAS_TOKEN             : ログ保存用トークン
 *
 * ALLOWED_ORIGINS       : 許可するオリジン（カンマ区切り。例: "https://373minamidc.github.io"）
 */

export default {
  async fetch(request, env) {
    /* ---------- CORS ---------- */
    const ALLOWED_ORIGINS = parseAllowedOrigins(env);
    const originRaw = request.headers.get("Origin");
    const origin = originRaw ? originRaw.toLowerCase() : null;

    const isBrowser = origin !== null;
    const isAllowedBrowserOrigin = !isBrowser
      ? true
      : (origin !== "null" && ALLOWED_ORIGINS.has(origin));

    if (isBrowser && !isAllowedBrowserOrigin) {
      return new Response("Forbidden", { status: 403 });
    }

    const cors = {
      "Access-Control-Allow-Origin": isBrowser ? originRaw : "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers: cors });
    }

    /* ---------- ルーティング ---------- */
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");

    if (path === "/ping") return new Response("pong", { headers: cors });
    if (path !== "/api/chat") return new Response("Not Found", { status: 404, headers: cors });
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: cors });

    /* ---------- リクエスト解析 ---------- */
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400, cors); }

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const trimmed = messages
      .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-14)
      .map(m => ({ role: m.role, content: m.content.slice(0, 1000) }));

    const lastUserTextRaw = [...trimmed].reverse().find(m => m.role === "user")?.content || "";
    const lastUserText = normalizeUserInput(lastUserTextRaw);
    const lastUserLower = lastUserText.toLowerCase();

    if (!lastUserText) {
      return json({ reply: "ご用件を入力してください。", source: "system", faq_flow: null, suggest_end: false }, 200, cors);
    }

    /* ---------- メタ情報（ログ用）---------- */
    const sessionId = safeStr(body.session_id, 120);
    const patientName = safeStr(body.patient?.name, 80);
    const patientDob = safeStr(body.patient?.dob, 20);
    const userAgent = safeStr(body.user_agent, 200) || safeStr(request.headers.get("User-Agent"), 200);
    const pageUrl = safeStr(body.page_url, 300);

    /* ---------- FAQ 取得（キャッシュ付き）---------- */
    let faqItems = [];
    try {
      const faq = await fetchFaq(env);
      faqItems = Array.isArray(faq?.items) ? faq.items : [];
    } catch {
      faqItems = [];
    }

    // enabled フィルタ
    faqItems = faqItems.filter(it => {
      const en = it?.enabled;
      if (en === undefined || en === null || en === "") return true;
      const s = String(en).trim().toLowerCase();
      return (s === "true" || s === "1" || s === "yes" || s === "on");
    });

    /* ---------- フロー状態（フロントから受け取る）---------- */
    let flow = normalizeFlow(body.faq_flow);

    // 「リセット/最初から」でフロー解除
    if (containsResetWord(lastUserLower)) {
      flow = null;
    }

    /* ---------- FAQ 候補を先に拾う ---------- */
    const pickedFaq = pickRelevantFaq(faqItems, lastUserText, 5);
    const topFaq = pickedFaq[0];

    // 別の FAQ が強くヒット → 途中フローを捨てる
    if (flow?.key && topFaq && topFaq.score >= 10 && String(topFaq.q || "") !== String(flow.key || "")) {
      flow = null;
    }

    /* ==========================================================
     *  1) フロー継続
     * ========================================================== */
    if (flow?.key) {
      const item = faqItems.find(it => String(it?.q || "") === flow.key);
      const steps = item ? parseFlowSteps(item.a) : null;

      if (steps && steps.length) {
        const currentStep = steps[Math.max(0, Math.min(flow.step - 1, steps.length - 1))];
        const expect = currentStep?.meta?.expect || "";
        const slot = currentStep?.meta?.slot || "";
        const choice = currentStep?.meta?.choice || "";

        const judged = judgeAnswer(lastUserText, { expect, choice, flowKey: flow.key });

        // 不正解 → 聞き直し
        if (!judged.ok) {
          const repair = buildRepairPrompt(currentStep.text);
          const repairOptions = buildReplyOptions(currentStep);
          await saveLogIfPossible(env, { session_id: sessionId, name: patientName, dob: patientDob, user_text: lastUserTextRaw, assistant_text: repair, user_agent: userAgent, page_url: pageUrl });
          return json({ reply: repair, source: "faq_repair", faq_flow: flow, suggest_end: false, reply_options: repairOptions }, 200, cors);
        }

        // slot 保存
        if (slot) {
          flow.slots = flow.slots && typeof flow.slots === "object" ? flow.slots : {};
          if (!flow.slots[slot] && judged.value) flow.slots[slot] = judged.value;
        }

        // 分岐判定
        const decision = decideFlowReply(flow.key, flow.slots);
        if (decision?.reply) {
          await saveLogIfPossible(env, { session_id: sessionId, name: patientName, dob: patientDob, user_text: lastUserTextRaw, assistant_text: decision.reply, user_agent: userAgent, page_url: pageUrl });
          return json({ reply: decision.reply, source: "faq_flow_decision", faq_flow: null, suggest_end: true }, 200, cors);
        }

        // 次のステップへ
        const advanced = advanceSteps(steps, flow, flow.step + 1);
        await saveLogIfPossible(env, { session_id: sessionId, name: patientName, dob: patientDob, user_text: lastUserTextRaw, assistant_text: advanced.reply, user_agent: userAgent, page_url: pageUrl });
        return json({ reply: advanced.reply, source: "faq_flow", faq_flow: advanced.newFlow, suggest_end: advanced.suggest_end, reply_options: advanced.reply_options || null }, 200, cors);
      } else {
        flow = null;
      }
    }

    /* ==========================================================
     *  2) FAQ 新規マッチ（フロー開始 or 単発回答）
     * ========================================================== */
    if (topFaq && topFaq.score >= 10) {
      const steps = parseFlowSteps(topFaq.a);

      if (steps && steps.length) {
        let newFlow = { key: topFaq.q, step: 1, slots: {} };
        prefillSlotsFromFreeText(newFlow, steps, lastUserText);

        // slot 先読みで結論到達
        const decision0 = decideFlowReply(newFlow.key, newFlow.slots);
        if (decision0?.reply) {
          await saveLogIfPossible(env, { session_id: sessionId, name: patientName, dob: patientDob, user_text: lastUserTextRaw, assistant_text: decision0.reply, user_agent: userAgent, page_url: pageUrl });
          return json({ reply: decision0.reply, source: "faq_flow_decision_start", faq_flow: null, suggest_end: true }, 200, cors);
        }

        const advanced = advanceSteps(steps, newFlow, 1);
        await saveLogIfPossible(env, { session_id: sessionId, name: patientName, dob: patientDob, user_text: lastUserTextRaw, assistant_text: advanced.reply, user_agent: userAgent, page_url: pageUrl });
        return json({ reply: advanced.reply, source: "faq_flow_start", faq_flow: advanced.newFlow, suggest_end: advanced.suggest_end, reply_options: advanced.reply_options || null }, 200, cors);
      }

      // ステップなし → 単発 FAQ 回答
      const reply = normalizeFaqAnswerForReply(topFaq.a);
      await saveLogIfPossible(env, { session_id: sessionId, name: patientName, dob: patientDob, user_text: lastUserTextRaw, assistant_text: reply, user_agent: userAgent, page_url: pageUrl });
      return json({ reply, source: "faq", faq_flow: null, suggest_end: true }, 200, cors);
    }

    /* ==========================================================
     *  3) Knowledge（GAS から検索結果を取得 → OpenAI で要約）
     * ========================================================== */
    const allKnowledge = await fetchAllKnowledge(env);
    const knowledgeHits = pickRelevantKnowledge(allKnowledge, lastUserText, 3);

    if (knowledgeHits.length > 0 && knowledgeHits[0].score >= 12) {
      const context = knowledgeHits
        .map((x, i) => `【資料${i + 1}】${x.doc_title || ""} / ${x.chunk_id || ""}\n${cleanNottaNoise(x.text || "")}`)
        .join("\n\n---\n\n");

      const knowledgeSystem = [
        "あなたは歯科医院の問い合わせ対応アシスタントです。",
        "次のルールを厳守して回答してください。",
        "1) 患者の質問に答える（結論→短い理由→必要なら注意点）。",
        "2) 資料の内容を使って患者に伝わる短い文章に要約する。原文をそのまま貼らない。",
        "3) 医療判断の断定は避け、受診の目安・緊急時の案内を添える。",
        "4) URLはプレーンテキストで出す（HTMLタグは使わない）。",
        "",
        "院の予約案内（必要な場合のみ最後に1回だけ）：",
        "WEB予約: https://v3.apodent.jp/app/entry/1717/minami/",
        "電話: 0798-47-8111（診療時間内のみ対応）",
      ].join("\n");

      const knowledgeUser = [
        "【患者の質問】",
        lastUserText,
        "",
        "【Knowledge（院内資料・会話ログ由来）】",
        context,
        "",
        "この資料の関連部分を要約して、患者にわかりやすく回答してください。",
      ].join("\n");

      try {
        let reply = await callOpenAI(env, [
          { role: "system", content: knowledgeSystem },
          { role: "user", content: knowledgeUser },
        ]);
        reply = cleanReplyText(reply);

        await saveLogIfPossible(env, { session_id: sessionId, name: patientName, dob: patientDob, user_text: lastUserTextRaw, assistant_text: reply, user_agent: userAgent, page_url: pageUrl });
        return json({ reply, source: "knowledge_ai", faq_flow: null, suggest_end: true }, 200, cors);
      } catch {
        // Knowledge AI 失敗 → 通常 OpenAI へフォールバック
      }
    }

    /* ==========================================================
     *  4) 通常 OpenAI（FAQ にも Knowledge にも該当なし）
     * ========================================================== */
    if (!env.OPENAI_API_KEY) return json({ error: "Missing OPENAI_API_KEY" }, 500, cors);

    const faqBlock = pickedFaq.length
      ? `参考FAQ（該当しそうなもの）：\n${pickedFaq.map((it, i) => `- Q${i + 1}: ${sanitizeLine(it.q)}\n  A${i + 1}: ${normalizeFaqAnswerForPrompt(it.a)}`).join("\n")}`
      : "";

    const SYSTEM = `
あなたは歯科医院の「お問い合わせAI」です。患者様の状況整理と、安全な受診案内をします。
このチャットは診断の確定は行いません。断定表現を避け、可能性と受診目安を示します。
緊急性が高い可能性がある場合は、迷わず「受診/お電話」を優先して案内します。

【院内用語ルール】
- 神経の治療 → 抜髄
- 根っこの治療 → 根管治療
- 他の言葉は、感染根管処置、歯周病治療
- 歯周病治療には スケーリング、SRP、歯周ポケット検査
- 大きなレントゲン → パノラマ撮影

【基本】
- 返信は短く、箇条書き中心
- 必要なら確認質問は最大4つまで
- 最後に予約導線（WEB/電話）を簡潔に
- WEB予約URLは必ず https://v3.apodent.jp/app/entry/1717/minami/ を使う
- 電話番号は 0798-47-8111（診療時間内のみ対応） と書く
- 最後に「会話を終了（履歴を消す）」を押す案内を入れる

${faqBlock}
`.trim();

    const openaiMessages = [
      { role: "system", content: SYSTEM },
      ...trimmed,
    ];

    try {
      let reply = await callOpenAI(env, openaiMessages, 320);
      reply = cleanReplyText(reply);

      await saveLogIfPossible(env, { session_id: sessionId, name: patientName, dob: patientDob, user_text: lastUserTextRaw, assistant_text: reply, user_agent: userAgent, page_url: pageUrl });
      return json({ reply, source: "openai", faq_flow: null, suggest_end: true }, 200, cors);
    } catch (e) {
      return json({ error: "OpenAI request failed", detail: String(e) }, 502, cors);
    }
  },
};

/* ======================================================================
 *  CORS ヘルパー
 * ====================================================================== */

function parseAllowedOrigins(env) {
  const raw = String(env.ALLOWED_ORIGINS || "").trim();
  if (!raw) {
    // デフォルト
    return new Set(["https://373minamidc.github.io"]);
  }
  return new Set(raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
}

/* ======================================================================
 *  FAQ Fetch（キャッシュ付き）
 * ====================================================================== */

async function fetchFaq(env) {
  const faqUrl = String(env.GAS_FAQ_URL || env.FAQ_URL || "").trim();
  if (!faqUrl) return { items: [] };

  const cache = caches.default;
  const cacheKey = new Request(faqUrl, { method: "GET" });

  const hit = await cache.match(cacheKey);
  if (hit) return await hit.json();

  const res = await fetch(faqUrl, {
    method: "GET",
    cf: { cacheTtl: 600, cacheEverything: true },
  });

  if (!res.ok) return { items: [] };

  const data = await res.json();

  await cache.put(
    cacheKey,
    new Response(JSON.stringify(data), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=600",
      },
    })
  );

  return data;
}

/* ======================================================================
 *  Knowledge Fetch（全件取得＋キャッシュ → Workers 側でスコアリング）
 * ====================================================================== */

async function fetchAllKnowledge(env) {
  const baseUrl = String(env.GAS_KNOWLEDGE_URL || "").trim();
  if (!baseUrl) return [];

  const cache = caches.default;
  const cacheKey = new Request("https://cache.local/knowledge_cache_v1", { method: "GET" });

  const hit = await cache.match(cacheKey);
  if (hit) {
    try {
      const data = await hit.json();
      if (data && Array.isArray(data.items)) return data.items;
    } catch {}
  }

  try {
    const res = await fetch(baseUrl, { method: "GET" });
    if (!res.ok) return [];
    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];

    await cache.put(
      cacheKey,
      new Response(JSON.stringify({ items }), {
        headers: { "Cache-Control": "max-age=600" },
      })
    );

    return items;
  } catch {
    return [];
  }
}

function pickRelevantKnowledge(items, userText, limit = 3) {
  const t = nfkc(String(userText || "")).toLowerCase().trim();
  if (!t) return [];

  // 正規化（NFKC + スペース・記号を除去）
  const norm = stripSymbols(t);

  const scored = [];
  for (const it of items || []) {
    const title = String(it?.doc_title || it?.title || "").trim();
    const text = String(it?.text || "").trim();
    if (!text) continue;

    const hay = nfkc((title + "\n" + text).toLowerCase());
    const hayNorm = stripSymbols(hay);

    let score = 0;

    // 入力全文が含まれるなら強め
    if (hayNorm.includes(norm)) score += 30;

    // 単語分割でマッチ加点（スペース＋日本語助詞で分割）
    const rough = splitForMatch(nfkc(String(userText || "")).toLowerCase()).slice(0, 10);
    for (const w of rough) {
      const wNorm = stripSymbols(w);
      if (!wNorm || wNorm.length < 2) continue;
      if (hayNorm.includes(wNorm)) score += Math.min(12, 4 + Math.floor(wNorm.length / 2));
    }

    // バイグラム補助マッチ（CJK部首文字の差異を吸収）
    if (score < 12 && norm.length >= 4) {
      const rough2 = splitForMatch(nfkc(String(userText || "")).toLowerCase()).slice(0, 10);
      for (const w of rough2) {
        const wN = stripSymbols(w);
        if (!wN || wN.length < 3) continue;
        const bg = bigramOverlap(wN, hayNorm);
        if (bg >= 0.5) score += Math.round(bg * 20);
      }
    }

    if (score > 0) scored.push({ score, doc_title: title, chunk_id: String(it?.chunk_id || it?.id || ""), text });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** NFKC 正規化（康熙部首を標準文字に変換） */
function nfkc(s) { return String(s || "").normalize("NFKC"); }

/** バイグラム（2文字組）の一致率（0〜1）— 1文字の差異があっても周辺でマッチ */
function bigramOverlap(needle, haystack) {
  if (needle.length < 2 || haystack.length < 2) return 0;
  const bgs = new Set();
  for (let i = 0; i < needle.length - 1; i++) bgs.add(needle[i] + needle[i + 1]);
  let hit = 0;
  for (const bg of bgs) { if (haystack.includes(bg)) hit++; }
  return hit / bgs.size;
}

/** 記号・スペースを除去 */
function stripSymbols(s) {
  return s.replace(/[ 　]/g, "").replace(/[\/／・\.\,，。、!！\?？\-\_\:：「」『』【】\(\)（）\n\r\t]/g, "");
}

/** 日本語対応の単語分割（スペース＋助詞で分割） */
function splitForMatch(text) {
  const s = String(text || "").trim();
  const bySpace = s.split(/[\s　]+/).filter(Boolean);
  const result = [];
  for (const chunk of bySpace) {
    result.push(chunk);
    // 日本語助詞・接続で追加分割
    const parts = chunk.split(/の|を|は|が|に|で|と|も|か|へ|って|ください|について|ですか|です|ます/);
    for (const p of parts) {
      if (p && p.length >= 2) result.push(p);
    }
  }
  return [...new Set(result)];
}

/* ======================================================================
 *  OpenAI Chat Completions 呼び出し
 * ====================================================================== */

async function callOpenAI(env, messages, maxTokens = 600) {
  const apiKey = String(env.OPENAI_API_KEY || "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");

  const model = String(env.OPENAI_MODEL || "gpt-4o-mini").trim();

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages,
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenAI error: ${res.status} ${t}`);
  }

  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || "").trim();
}

/* ======================================================================
 *  FAQ Pick（キーワードマッチ）
 * ====================================================================== */

function pickRelevantFaq(items, userText, limit = 5) {
  const t = (userText || "").toLowerCase();
  if (!t) return [];

  const scored = [];
  for (const it of items || []) {
    const q = String(it?.q || "");
    const a = String(it?.a || "");
    const k = String(it?.k || "");
    if (!q || !a) continue;

    const keys = k.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
    let score = 0;

    for (const kw of keys) {
      if (!kw) continue;
      if (t.includes(kw) || faqStemMatch(t, kw)) score += 10;
    }

    const qLower = q.toLowerCase();
    if (qLower.length >= 4 && (t.includes(qLower) || faqStemMatch(t, qLower))) score += 3;

    if (score > 0) scored.push({ score, q, a });
  }

  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit);
}

/** キーワードの語幹を生成し、ユーザーテキストに含まれるか判定（活用形対応） */
function faqStemMatch(text, keyword) {
  const kw = String(keyword || "").trim();
  if (kw.length < 3) return false;

  // 1文字の動詞語尾を除去して語幹チェック
  const endings1 = ["る", "い", "く", "す", "つ", "ぬ", "ぶ", "む", "う"];
  for (const e of endings1) {
    if (kw.endsWith(e)) {
      const stem = kw.slice(0, -1);
      if (stem.length >= 2 && text.includes(stem)) return true;
    }
  }

  // 2文字以上の語尾を除去して語幹チェック
  const endings2 = ["する", "した", "ない", "たい", "ます", "ました", "ている", "ていた", "れる", "れた"];
  for (const e of endings2) {
    if (kw.endsWith(e) && kw.length > e.length + 1) {
      const stem = kw.slice(0, -e.length);
      if (stem.length >= 2 && text.includes(stem)) return true;
    }
  }

  return false;
}

/* ======================================================================
 *  Flow Steps Parser
 * ====================================================================== */

function parseFlowSteps(a) {
  const text = normalizeFaqAnswerForReply(a);
  const re = /\[\[(step\d+|final)([^\]]*)\]\]/g;
  const matches = [...text.matchAll(re)];
  if (!matches.length) return null;

  const steps = [];
  for (let i = 0; i < matches.length; i++) {
    const tag = matches[i][1];
    const attrRaw = matches[i][2] || "";
    const start = matches[i].index + matches[i][0].length;
    const end = (i + 1 < matches.length) ? matches[i + 1].index : text.length;
    const chunk = text.slice(start, end).trim();
    if (!chunk) continue;

    const meta = parseAttrs(attrRaw);
    steps.push({ tag, text: chunk, meta });
  }
  return steps.length ? steps : null;
}

function parseAttrs(attrRaw) {
  const meta = {};
  const s = String(attrRaw || "").trim();
  if (!s) return meta;

  const parts = s.split(/\s+/).filter(Boolean);
  for (const p of parts) {
    const m = p.match(/^([a-zA-Z_]+)=(.+)$/);
    if (!m) continue;
    meta[m[1].toLowerCase()] = m[2].trim();
  }
  return meta;
}

/* ======================================================================
 *  Flow State
 * ====================================================================== */

function normalizeFlow(flow) {
  if (!flow || typeof flow !== "object") return null;
  const key = typeof flow.key === "string" ? flow.key : "";
  const step = Number.isFinite(flow.step) ? flow.step : parseInt(flow.step, 10);
  const slots = (flow.slots && typeof flow.slots === "object") ? flow.slots : {};
  if (!key || !Number.isFinite(step) || step < 1 || step > 120) return null;
  return { key, step, slots };
}

function containsResetWord(t) {
  return (
    t.includes("リセット") ||
    t.includes("最初から") ||
    t.includes("はじめから") ||
    t.includes("やりなお") ||
    t === "reset"
  );
}

/* ======================================================================
 *  User Input Normalize
 * ====================================================================== */

function normalizeUserInput(text) {
  let s = String(text || "").trim();
  if (!s) return s;
  s = s.replace(/違います|ちがいます|違うです/g, "いいえ");
  s = s.replace(/はいです|そうです|そうだよ/g, "はい");
  s = s.replace(/ありません|なしです/g, "ない");
  return s;
}

/* ======================================================================
 *  Answer Judgement
 * ====================================================================== */

function judgeAnswer(text, { expect = "", choice = "", flowKey = "" } = {}) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, value: "" };

  const e = String(expect || "").toLowerCase();
  const ch = String(choice || "").trim();

  if (!e) return { ok: true, value: t };

  if (e === "yesno") {
    const yn = parseYesNo(t);
    if (!yn) return { ok: false, value: "" };
    return { ok: true, value: yn };
  }

  if (e === "choice") {
    const digit = parseChoiceDigit(t);
    if (digit) {
      if (ch && !String(ch).includes(String(digit))) return { ok: false, value: "" };
      return { ok: true, value: String(digit) };
    }
    const norm = normalizeChoiceBySchema(t, ch, flowKey);
    if (norm) {
      if (ch && !String(ch).includes(norm)) return { ok: false, value: "" };
      return { ok: true, value: norm };
    }
    return { ok: false, value: "" };
  }

  if (e === "tooth") {
    const tooth = parseToothLocation(t);
    if (!tooth) return { ok: false, value: "" };
    return { ok: true, value: tooth };
  }

  if (e === "when") {
    const when = parseWhen(t);
    if (!when) return { ok: false, value: "" };
    return { ok: true, value: when };
  }

  if (e === "free") return { ok: true, value: t };

  return { ok: true, value: t };
}

function normalizeChoiceBySchema(t, choice, flowKey) {
  const s = String(t || "").trim().toLowerCase();
  const ch = String(choice || "");

  /* ---- 歯がグラグラする（4択）---- */
  if (flowKey === "歯がグラグラする") {
    if (s.includes("自分") || s.includes("天然")) return "1";
    if (s.includes("詰め") || s.includes("つめ")) return "2";
    if (s.includes("かぶせ") || s.includes("被せ") || s.includes("クラウン")) return "3";
    if (s.includes("差し歯") || s.includes("さしば")) return "4";
    return "";
  }

  if (ch.includes("3")) {
    if (s.includes("治療した") || s.includes("治療後") || s.includes("詰めた") || s.includes("被せた") ||
        s.includes("インレー") || s.includes("クラウン") || s.includes("レジン") || s.includes("詰め物した")) return "1";
    if (s.includes("治療中") || s.includes("通院中") || s.includes("仮") || s.includes("仮詰め") || s.includes("仮蓋") ||
        s.includes("途中") || s.includes("まだ通って") || s.includes("次回予約")) return "2";
    if (s.includes("わから") || s.includes("不明") || s.includes("どっち") || s.includes("覚えてない") ||
        s.includes("たぶん") || s.includes("多分")) return "3";
    return "";
  }

  return normalizeChoiceJa12(s, flowKey);
}

function normalizeChoiceJa12(s, flowKey) {
  if (s.includes("ある") || s.includes("あり") || s.includes("痛") || s.includes("いた") ||
      s.includes("しみ") || s.includes("染み") || s.includes("ズキ") || s.includes("うず") ||
      s.includes("我慢できない") || s.includes("無理")) return "1";
  if (s.includes("ない") || s.includes("なし") || s.includes("問題ない") || s.includes("大丈夫") ||
      s.includes("平気") || s.includes("特にない") || s.includes("ありません") || s.includes("我慢できる")) return "2";
  return "";
}

function buildRepairPrompt(questionText) {
  return `すみません、確認させてください。\n\n${String(questionText || "").trim()}`;
}

/* ======================================================================
 *  Step Advance（slot 済みはスキップ）
 * ====================================================================== */

function advanceSteps(steps, flow, startFrom) {
  const total = steps.length;
  let idx = Math.max(1, startFrom);

  while (idx <= total) {
    const st = steps[idx - 1];

    if (st.tag === "final") {
      return { reply: st.text, newFlow: null, suggest_end: true, reply_options: null };
    }

    const slot = st?.meta?.slot || "";
    if (slot && flow?.slots && flow.slots[slot]) {
      idx++;
      continue;
    }

    const newFlow = { key: flow.key, step: idx, slots: flow.slots || {} };
    return { reply: st.text, newFlow, suggest_end: false, reply_options: buildReplyOptions(st) };
  }

  return {
    reply: "ご連絡ありがとうございます。\n\nWEB予約：https://v3.apodent.jp/app/entry/1717/minami/\nお電話：0798-47-8111（診療時間内のみ対応）\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。",
    newFlow: null,
    suggest_end: true,
    reply_options: null,
  };
}

/** FAQ ステップの expect に応じて選択肢を生成 */
function buildReplyOptions(step) {
  if (!step || !step.meta) return null;
  const expect = (step.meta.expect || "").toLowerCase();

  if (expect === "yesno") {
    return [
      { label: "はい", value: "はい" },
      { label: "いいえ", value: "いいえ" },
    ];
  }

  if (expect === "choice") {
    const text = step.text || "";
    const options = [];

    // 行頭の番号パース（複数フォーマット対応: 1） 1) 1. 1、 1: ① 等）
    for (const line of text.split(/\n/)) {
      const m = line.match(/^\s*(\d)[）\)\.\．、:：]\s*(.+)/);
      if (m) { options.push({ label: m[1] + "）" + m[2].trim(), value: m[1] }); continue; }
      // ① ② ③ ④ 形式
      const m2 = line.match(/^\s*([①②③④⑤⑥⑦⑧⑨])\s*(.+)/);
      if (m2) {
        const d = "①②③④⑤⑥⑦⑧⑨".indexOf(m2[1]) + 1;
        options.push({ label: d + "）" + m2[2].trim(), value: String(d) });
      }
    }
    if (options.length >= 2) return options;

    // フォールバック: choice メタから番号ボタンを生成
    const choiceMeta = step.meta.choice || "";
    if (choiceMeta) {
      const digits = [...choiceMeta].filter(c => /\d/.test(c));
      if (digits.length >= 2) {
        // テキスト内から各番号の説明を探す
        const fallback = [];
        for (const d of digits) {
          let label = d;
          const re = new RegExp("(?:^|[\\s（(「])?" + d + "[）\\)\\.．、:：\\s]\\s*(.+)", "m");
          const fm = text.match(re);
          if (fm) label = d + "）" + fm[1].split(/\n/)[0].trim();
          fallback.push({ label, value: d });
        }
        return fallback;
      }
    }
  }

  return null;
}

/* ======================================================================
 *  Slot Prefill（自由文から先読み）
 * ====================================================================== */

function prefillSlotsFromFreeText(flow, steps, userText) {
  const t = String(userText || "").trim();
  if (!t) return;

  flow.slots = flow.slots && typeof flow.slots === "object" ? flow.slots : {};

  for (const st of steps) {
    const slot = st?.meta?.slot || "";
    const expect = st?.meta?.expect || "";
    if (!slot || flow.slots[slot]) continue;

    const judged = judgeAnswer(t, { expect, choice: st?.meta?.choice || "", flowKey: flow.key });
    if (judged.ok && judged.value) {
      if (String(expect).toLowerCase() === "tooth") {
        if (looksLikeSymptom(t) && !looksLikeToothStrong(t)) continue;
      }
      flow.slots[slot] = judged.value;
    }
  }
}

/* ======================================================================
 *  Decision（FAQ フロー分岐）
 * ====================================================================== */

function decideFlowReply(flowKey, slots) {
  const key = String(flowKey || "");
  const s = slots || {};

  const WEB = "https://v3.apodent.jp/app/entry/1717/minami/";
  const TEL = "0798-47-8111（診療時間内のみ対応）";

  /* ---- しみる ---- */
  if (key === "歯がしみる（冷たい・甘い・風でしみる）") {
    if (s.source === "1") {
      return { reply: `ご回答ありがとうございます。\n\n治療後からしみる場合、治療後は人工の材料に置き換わっていることもあり、神経が慣れるまでは「長く見て半年ほど」しみることがあります。\nただし、日常生活に支障が出るほど強い場合は、神経の処置（抜髄）が必要になる可能性もあります。\n\nご予約：\nWEB：${WEB}\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
    }
    if (s.source === "2") {
      if (s.tmpcap === "yes") {
        return { reply: `ご回答ありがとうございます。\n\n治療中の歯で仮詰め（仮蓋）が外れている場合、応急処置が必要なことがあります。\nなるべくその部分で噛まず、できるだけ早めの受診をおすすめします。\n\n当日希望の場合はお待ちいただく可能性がありますが、状況により対応できることがありますので、お電話でご相談ください。\nお電話の際は【虫歯治療の仮蓋が取れました】とお伝えください。\n\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      if (s.tmpcap === "no") {
        return { reply: `ご回答ありがとうございます。\n\n治療中の歯がしみる場合、治療の直後は一時的に神経が炎症を起こしてしみることがあります。\n次第に落ち着くことも多いので、次の予約まで様子を見るか、ご心配であればWEB予約またはお電話でご予約ください。\nまた、日常生活に支障が出るほど強い痛みがある場合は、お電話でご相談ください。\n\nご予約：\nWEB：${WEB}\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      return null;
    }
    if (s.source === "3") {
      if (s.tolerable === "1") {
        return { reply: `ご回答ありがとうございます。\n\n原因としては、虫歯もしくは知覚過敏の可能性があります。\nまずはWEBからご予約をお取りください。\n\nWEB予約：${WEB}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      if (s.tolerable === "2") {
        return { reply: `ご回答ありがとうございます。\n\n我慢できないほどの痛み・しみ方の場合は、一度受診をおすすめします。\n空き状況によっては当日のご案内も可能なことがありますので、お電話でご相談ください。\n\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      return null;
    }
  }

  /* ---- 入れ歯が痛い ---- */
  if (key === "入れ歯が痛い") {
    if (s.eating === "yes") {
      return { reply: `ご回答ありがとうございます。\n\n入れ歯を外すとお食事がしにくい場合は、入れ歯の調整が必要です。\nお電話にてご予約をお取りください。\n\n痛ければ、入れ歯を外しておいてもらって大丈夫です。\n\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
    }
    if (s.eating === "no") {
      return { reply: `ご回答ありがとうございます。\n\nお食事に支障がない場合は、WEBにてご予約をお取りください。\n\n痛ければ、入れ歯を外しておいてもらって大丈夫です。\n\nWEB予約：${WEB}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
    }
    return null;
  }

  /* ---- 入れ歯が割れた ---- */
  if (key === "入れ歯が割れた") {
    if (s.eat === "yes") {
      return { reply: `お食事がしにくいとのことですね。\n\n応急処置で対応できる場合がありますので、お電話にてご予約をお願いいたします。\n\nお電話：${TEL}\n\n※割れた入れ歯は【接着剤などで修理せず】、そのままお持ちください。\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
    }
    if (s.eat === "no") {
      return { reply: `現在はお食事に大きな支障はないのですね。\n\nWEB予約よりご予約をお取りください。\n\nWEB予約：${WEB}\n\n※割れた入れ歯は【接着剤などで修理せず】、そのままお持ちください。\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
    }
    return null;
  }

  /* ---- 歯がグラグラする ---- */
  if (key === "歯がグラグラする") {
    // type: 1=自分の歯, 2=詰め物, 3=かぶせ物, 4=差し歯
    if (s.type === "1") {
      if (s.pain === "no") {
        return { reply: `ご回答ありがとうございます。\n\nそこで噛まないようにできるのであれば、噛まないようにしてください。\nウェブにてご予約をお取りください。\n\nWEB予約：${WEB}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      if (s.pain === "yes") {
        if (s.throb === "yes") {
          return { reply: `ご回答ありがとうございます。\n\n応急処置させていただきます。\nお電話にてご予約をお取りください。\n\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
        }
        if (s.throb === "no") {
          return { reply: `ご回答ありがとうございます。\n\nそこで噛まないようにできるのであれば、噛まないようにしてください。\nウェブにてご予約をお取りください。\n\nWEB予約：${WEB}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
        }
        return null;
      }
      return null;
    }
    if (s.type === "2") {
      if (s.pain === "yes") {
        return { reply: `ご回答ありがとうございます。\n\nそこで噛まないようにできるのであれば、噛まないようにして、応急処置しますのでお電話にてご予約をお取りください。\n\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      if (s.pain === "no") {
        return { reply: `ご回答ありがとうございます。\n\nそこで噛まないようにできるのであれば、噛まないようにして様子を見ましょう。\nウェブにてご予約をお取りください。\n\nWEB予約：${WEB}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      return null;
    }
    if (s.type === "3" || s.type === "4") {
      // かぶせ物・差し歯（同じ分岐）
      if (s.pain === "yes") {
        return { reply: `ご回答ありがとうございます。\n\nそこで噛まないようにできるのであれば、噛まないようにして様子を見てください。\nご予約をお取りください。\n\nWEB予約：${WEB}\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      if (s.pain === "no") {
        return { reply: `ご回答ありがとうございます。\n\nそこで噛まないようにできるのであれば、噛まないようにして様子を見ましょう。\nWEBにてご予約をお取りください。\n\nWEB予約：${WEB}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      return null;
    }
    return null;
  }

  /* ---- 詰め物が取れた ---- */
  if (key === "つめもの（かぶせもの・銀歯など）が取れた") {
    if (s.treating === "no") {
      if (s.symptom === "2") {
        return { reply: `ご回答ありがとうございます。\n\n症状がない場合は、このままでも大きな問題にならないケースも多いです。\nただし、取れた部分から欠けたり、食べ物が詰まりやすくなったりするため、取れた部分でなるべく噛まないようにしてください。\n\nご予約：\nWEB：${WEB}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      if (s.symptom === "1" && s.pain === "1") {
        return { reply: `ご回答ありがとうございます。\n\n痛みが我慢できる範囲であれば、まずは取れた部分でなるべく噛まずに過ごしてください。\nしみる・痛む原因として虫歯や露出が関係している可能性がありますので、WEBからご予約をお取りください。\n\nWEB予約：${WEB}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      if (s.symptom === "1" && s.pain === "2") {
        return { reply: `ご回答ありがとうございます。\n\n痛みが我慢できない場合は、早めの受診をおすすめします。\n空き状況によっては当日のご案内も可能なことがありますので、お電話でご相談ください。\n\nご予約：\nWEB：${WEB}\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      return null;
    }
    if (s.treating === "yes") {
      if (s.rct === "yes") {
        return { reply: `ご回答ありがとうございます。\n\n根管治療中の仮詰め（仮蓋）が取れてしまうことは、頻繁ではありませんが起こることがあります。\nもし「全部取れている」状態だと、細菌が根管内に侵入する可能性があるため、一度受診をおすすめします。\n\n当日希望の場合はお待ちいただく可能性がありますが、状況により対応できることがありますので、お電話でご相談ください。\nお電話の際は【根管治療の仮詰めが取れました】とお伝えください。\n\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
      }
      if (s.rct === "no") {
        if (s.caries === "yes") {
          if (s.cold === "no") {
            return { reply: `ご回答ありがとうございます。\n\n冷たいものでしみない場合は、このままでも問題ないケースが多いです。\n次の予約までその部分で噛まないように注意していただくか、ご心配であればWEB予約またはお電話でご予約ください。\n\nご予約：\nWEB：${WEB}\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
          }
          if (s.cold === "yes") {
            return { reply: `ご回答ありがとうございます。\n\n冷たいものでしみる場合は、応急処置が必要なことがあります。\nお電話でご予約をお願いいたします。\nお電話の際は【虫歯治療の仮蓋が取れました】とお伝えください。\n\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
          }
          return null;
        }
        if (s.caries === "no") {
          return { reply: `ご回答ありがとうございます。\n\n治療中の歯でつめもの（仮詰めを含む）が取れている場合、状態によっては応急処置が必要なことがあります。\n取れた部分でなるべく噛まないようにしていただき、WEB予約またはお電話でご相談ください。\n\nご予約：\nWEB：${WEB}\nお電話：${TEL}\n\n※会話が終わりましたら「会話を終了（履歴を消す）」を押してください。` };
        }
      }
    }
  }

  return null;
}

/* ======================================================================
 *  Simple Parsers
 * ====================================================================== */

function parseYesNo(t) {
  const s = String(t).trim().toLowerCase();
  if (["はい","うん","yes","y","1","そう","ok","大丈夫"].includes(s)) return "yes";
  if (["いいえ","いや","no","n","2","ちがう","違う"].includes(s)) return "no";
  if (s.includes("はい")) return "yes";
  if (s.includes("いいえ")) return "no";
  return "";
}

function parseChoiceDigit(t) {
  const m = String(t).match(/[1-9]/);
  return m ? parseInt(m[0], 10) : 0;
}

function parseToothLocation(t) {
  const s = String(t).trim();
  if (!looksLikeToothStrong(s)) return "";
  if (looksLikeSymptom(s) && !/右|左|上|下|奥歯|前歯|[1-8]番/.test(s)) return "";
  return s.slice(0, 40);
}

function looksLikeToothStrong(s) {
  return /右上|左上|右下|左下|右|左|上|下|奥歯|前歯|[1-8]番/.test(s);
}

function looksLikeSymptom(s) {
  return /ぐらぐら|グラグラ|痛|いた|しみ|染み|腫|はれ|外れ|はずれ|取れ|とれ|欠け|かけ|浮い/.test(s);
}

function parseWhen(t) {
  const s = String(t).trim();
  if (/今日|本日/.test(s)) return "今日";
  if (/昨日/.test(s)) return "昨日";
  if (/一昨日/.test(s)) return "一昨日";
  if (/\d+\s*日(前|くらい|程)?/.test(s)) return s.match(/\d+\s*日(前|くらい|程)?/)[0].replace(/\s+/g,"");
  if (/\d+\s*週間(前|くらい|程)?/.test(s)) return s.match(/\d+\s*週間(前|くらい|程)?/)[0].replace(/\s+/g,"");
  if (/\d+\s*ヶ月(前|くらい|程)?/.test(s)) return s.match(/\d+\s*ヶ月(前|くらい|程)?/)[0].replace(/\s+/g,"");
  if (/先週|今週|先月|今月/.test(s)) return s.match(/先週|今週|先月|今月/)[0];
  if (/さっき|先ほど|たった今/.test(s)) return s.match(/さっき|先ほど|たった今/)[0];
  return "";
}

/* ======================================================================
 *  Text Cleaning
 * ====================================================================== */

function cleanReplyText(s) {
  let x = String(s || "");
  x = x.replace(/target="_blank"\s*/g, "").replace(/rel="noopener noreferrer"\s*/g, "").replace(/rel="noopener"\s*/g, "").replace(/rel="noreferrer"\s*/g, "");
  x = x.replace(/<a[^>]*>(.*?)<\/a>/gi, "$1");
  x = x.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, "$2");
  x = x.replace(/["']?\s*>/g, " ");
  x = x.replace(/Powered by\s*Notta\.?/gi, "");
  x = x.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return x;
}

function cleanNottaNoise(s) {
  return String(s || "").replace(/Powered by\s*Notta\.?(ai)?/gi, "").trim();
}

/* ======================================================================
 *  LOG
 * ====================================================================== */

async function saveLogIfPossible(env, payload) {
  const logUrl = String(env.GAS_LOG_URL || "").trim();
  const token = String(env.GAS_TOKEN || "").trim();
  if (logUrl && token) {
    await sendLogWithTimeout(logUrl, token, payload, 8000);
  }
}

async function sendLogWithTimeout(logUrl, token, payload, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const url = `${logUrl}?token=${encodeURIComponent(token)}`;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch {
    // ログ失敗は無視
  } finally {
    clearTimeout(timer);
  }
}

/* ======================================================================
 *  Utils
 * ====================================================================== */

function normalizeFaqAnswerForReply(a) {
  return String(a || "").replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function normalizeFaqAnswerForPrompt(a) {
  return String(a || "").replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim().slice(0, 1500);
}

function safeStr(v, maxLen) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function sanitizeLine(s) {
  return String(s || "").replace(/\s+/g, " ").trim().slice(0, 300);
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}
