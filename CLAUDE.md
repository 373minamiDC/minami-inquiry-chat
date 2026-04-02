# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AI-powered dental inquiry chatbot frontend for Minami Dental Clinic (みなみ歯科医院). Patients describe symptoms via chat, and an AI responds with guidance (not diagnosis). The frontend collects patient consent, name, and date of birth before allowing messages.

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JavaScript in `index.html` (no framework, no build system)
- **Backend**: Cloudflare Workers — ローカルの `worker.js` に統合版コードあり
- **データ連携**: Google Apps Script (GAS) 経由でスプレッドシートの FAQ / Knowledge / Logs を操作
- **Storage**: Browser `localStorage` for chat history, patient profile, and session ID

## How to Run

Open `index.html` directly in a browser. No build step, no dependencies, no package manager.

## Architecture

`index.html` にすべてのフロントエンドコードが入っている:

- **CSS**: ライト系・高級感テーマ（明朝体ベース、ゴールドブラウン系アクセント）
  - モーダル（プロフィール入力用）
  - 選択ボタン（FAQフロー用）
- **HTML**: 注意書きカード、プロフィール状態バー、チャットエリア、入力バー、プロフィールモーダル
- **JavaScript**: 全アプリケーションロジック

### Data Flow

1. User types a message and clicks send
2. `ensureProfile()` checks localStorage for patient profile; if missing, shows modal (consent + name + DOB dropdowns)
3. `getOrCreateSessionId()` generates a UUID stored in localStorage
4. POST request to `API_URL` with payload: `{ session_id, patient: {name, dob}, user_agent, page_url, messages, faq_flow }`
5. Backend returns `{ reply, source, faq_flow, reply_options }` — reply is rendered as AI bubble, reply_options as clickable buttons

### localStorage Keys

| Key | Purpose | Format |
|-----|---------|--------|
| `minami_inquiry_chat_v1` | Chat history (last 30 messages) | `[{role, content}, ...]` |
| `minami_patient_profile_v1` | Patient info | `{name, dob, consent, updated_at}` |
| `minami_inquiry_session_v1` | Session ID | UUID string |

### Key Functions (index.html)

- `ensureProfile(forceReinput)` - **async** Promise ベース。モーダルで同意+氏名+DOB(ドロップダウン)を取得
- `send()` - メイン送信ハンドラ: プロフィール確認 → API呼び出し → レスポンス描画（reply_options があればボタン表示、suggest_end があれば終了ボタン表示）
- `addBubble(role, text, source, options)` - チャットバブル追加。options があれば選択ボタンも描画
- `addEndChatButton()` - 「会話を終了する」ボタンを追加（クリックで messages / faqFlow / localStorage をクリア）
- `render()` - messages 配列からチャットを再構築（最終メッセージに suggest_end があれば終了ボタンも再描画）
- `refreshStatus()` - プロフィール/セッション表示を更新

### Key Functions (worker.js)

- `pickRelevantFaq(items, userText, limit)` — FAQ キーワードマッチ（必須キーワード `*` 対応、q 主語ガード付き、活用形マッチ対応）
- `extractQSubject(q)` — FAQ の q（質問文）から「が」「は」の前の主語を抽出
- `faqStemMatch(text, keyword)` — キーワードの語幹を生成しユーザーテキストに含まれるか判定（活用形対応）
- `parseFlowSteps(a)` — FAQ の `a` 列から `[[stepN ...]]` タグをパースしてステップ配列を返す
- `advanceSteps(steps, flow, startFrom)` — 次の未回答ステップへ進む（slot 済み・condition 不成立はスキップ）
- `checkStepCondition(cond, slots)` — `condition=slotName:val1|val2` の成立判定
- `prefillSlotsFromFreeText(flow, steps, userText)` — 自由文から slot を先読み（condition チェック付き）
- `judgeAnswer(text, {expect, choice, flowKey})` — ユーザー回答を expect 形式で判定
- `normalizeChoiceBySchema(t, choice, flowKey)` — flowKey ごとの自然言語→数字マッチング
- `decideFlowReply(flowKey, slots)` — slot 充填状況から最終回答を決定（フローごとの分岐ロジック）
- `buildReplyOptions(step)` — ステップの expect に応じて選択ボタン（reply_options）を生成（複数フォーマット対応: `1)` `1.` `①` 等、フォールバック: choice メタから自動生成）

## System Architecture (3層構成)

```
index.html (フロントエンド / GitHub Pages)
  ↓ POST /api/chat (faq_flow 状態を含む)
worker.js (Cloudflare Workers)
  ├─ 1) FAQ フロー（ステップ分岐・slot 管理・reply_options 返却）← スプレッドシート FAQ シート
  ├─ 2) Knowledge 要約（全件取得→NFKC+バイグラムスコアリング→OpenAI要約）← スプレッドシート KNOWLEDGE シート
  └─ 3) 通常 OpenAI 回答（FAQにもKnowledgeにも該当なし）
  ↓ GAS Web App (doGet / doPost)
Google スプレッドシート
  ├─ FAQ シート（列: q / a / k / enabled）
  ├─ KNOWLEDGE シート（列: doc_title / chunk_id / text）
  └─ LOGS シート（自動生成）
```

### Workers 環境変数 (Cloudflare Settings)

**wrangler.toml に定義済み（非秘密）:**
- `GAS_FAQ_URL` : FAQ 取得用 GAS URL (?action=faq)
- `GAS_KNOWLEDGE_URL` : Knowledge 取得用 GAS URL (?action=knowledge)
- `GAS_LOG_URL` : ログ保存用 GAS URL
- `ALLOWED_ORIGINS` : CORS 許可オリジン

**Dashboard で手動設定（秘密）:**
- `GAS_TOKEN` : ログ保存用トークン（`wrangler secret put GAS_TOKEN`）
- `OPENAI_API_KEY` : OpenAI API キー（`wrangler secret put OPENAI_API_KEY`）
- `OPENAI_MODEL` : 使用モデル（デフォルト: gpt-4o-mini）

### ローカルファイル
- `worker.js` : Cloudflare Workers 統合版コード（FAQ フロー + Knowledge + OpenAI + reply_options）
- `gas_full.js` : GAS 完全版（doGet/doPost/FAQ/Knowledge/Logs/AddFAQ すべて含む）※ GAS エディタに貼り付け済み
- `index.html` : フロントエンド（モーダル入力・選択ボタン・faq_flow 対応・source タグ表示）
- `wrangler.toml` : Cloudflare Workers デプロイ設定（非秘密の環境変数含む）

### Worker レスポンス形式
```json
{
  "reply": "回答テキスト",
  "source": "faq_flow | faq_flow_decision | faq | knowledge_ai | openai | system",
  "faq_flow": { "key": "入れ歯が痛い", "step": 1, "slots": {} },
  "suggest_end": false,
  "reply_options": [
    { "label": "はい", "value": "はい" },
    { "label": "いいえ", "value": "いいえ" }
  ]
}
```

## デプロイ方法

### index.html（フロントエンド）
GitHub に push → GitHub Pages が自動反映（設定済み）
```bash
git add index.html
git commit -m "変更内容"
git push origin main
```

### worker.js（Cloudflare Workers）
```bash
# プロジェクトディレクトリで:
wrangler deploy
```
※ 秘密の環境変数（OPENAI_API_KEY, GAS_TOKEN）は Cloudflare Dashboard で管理
※ `wrangler deploy` しても秘密変数は上書きされない（wrangler.toml に非秘密のみ記載）

### GAS（Google Apps Script）
GAS スクリプトエディタで `gas_full.js` の内容を貼り付け → デプロイ > デプロイを管理 > 新しいバージョン
※ 新しいバージョンを選ばないと反映されない

### FAQ をスプレッドシートに追加する方法
GAS の `handleAddFaq_` エンドポイントを使って API 経由で追加可能。

**重要: 文字化け防止のため、JSON は ASCII-safe エンコーディングで送信すること。**
日本語文字を `\uXXXX` エスケープに変換してから送信する。

```javascript
// Node.js スクリプトで追加（例）— 文字化け防止版
const GAS_URL = "https://script.google.com/macros/s/AKfycbxR4vIJKyzbN9zgrOO3bRR2_0QX59kz6qA1Jw-wN5aZXYJRrNEK8t4slZGdXWDpD8Z1Uw/exec";

// 日本語を \uXXXX エスケープに変換（ASCII-only JSON）
function asciiSafeStringify(obj) {
  return JSON.stringify(obj).replace(/[^\x00-\x7F]/g, (ch) => {
    return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
  });
}

const payload = {
  q: "質問テキスト",
  a: "[[step1 expect=yesno slot=slotname]]質問文\\n（「はい」または「いいえ」でお答えください）",
  k: "キーワード1,キーワード2",
  enabled: true,
};

fetch(GAS_URL + "?action=add_faq&token=gas_token", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: asciiSafeStringify(payload),
  redirect: "follow",
}).then(r => r.text()).then(console.log);
```

**GAS 側にも UTF-8 デコード対策を実装済み**（`parsePostJson_` 関数）:
- GAS が UTF-8 バイト列を Latin-1 として誤読した場合、バイト列を再構築して正しくデコードする
- `handleAddFaq_` と `handleLog_` の両方で使用

※ FAQ にステップフローを追加した場合、`worker.js` の `decideFlowReply` 関数にも対応する分岐ロジックを追加する必要がある
※ `worker.js` に `normalizeChoiceBySchema` の自然言語マッチングも追加する（4択以上の場合は flowKey で分岐）

### FAQ ステップ定義の属性一覧

```
[[stepN expect=TYPE slot=SLOTNAME choice=DIGITS condition=SLOT:VAL1|VAL2]]
質問テキスト
```

| 属性 | 必須 | 説明 | 例 |
|------|------|------|-----|
| `expect` | ○ | 回答の期待形式 | `yesno`, `choice`, `when`, `tooth`, `free` |
| `slot` | ○ | 回答を保存するスロット名 | `treating`, `throb` |
| `choice` | △ | expect=choice 時の有効な数字 | `12345`（5択）, `123`（3択） |
| `condition` | × | このステップを表示する条件 | `treating:yes`, `treatment:1\|2\|3` |

- `condition` は `slotName:value1|value2` 形式。slots[slotName] が指定値のいずれかに一致するときのみ表示
- 条件不成立のステップは `advanceSteps` でスキップされ、`prefillSlotsFromFreeText` でも prefill されない
- 同じ slot 名を複数ステップで使える（排他的な condition を付けること。例: step5 と step6 の両方が `throb` だが、condition が排他的）

## 現在の作業状況（2026-02-27 時点）

### 完了済み
- FAQ フロー（ステップ分岐）が動作するように worker.js を統合版として再構築
- index.html に faq_flow 状態管理を追加
- スプレッドシート FAQ シートのヘッダーを q / a / k / enabled に変更
- **Knowledge 要約が正常動作**:
  - GAS スクリプト再構築（doGet が消失していた問題を修正 → `gas_full.js` として完全版を作成）
  - Cloudflare Workers に `GAS_KNOWLEDGE_URL` 環境変数を設定
  - スコアリング改善: NFKC 正規化 + 日本語助詞分割 + バイグラムマッチング
    - Notta 由来テキストの CJK 部首補助文字（⻭≠歯 等）に対応するためバイグラム照合を導入
  - source タグ表示（`[source: knowledge_ai]` 等）を index.html に追加
- **wrangler.toml 作成**（半自動デプロイ対応、非秘密の環境変数を `[vars]` に記載）
- **UIリニューアル**: ダークテーマ → ライト・高級感テーマ（明朝体、ゴールドブラウン系）
- **プロフィール入力をモーダル化**: prompt/confirm → モーダルウィンドウ（同意チェック + 氏名 + 生年月日ドロップダウン選択）
- **FAQ 選択ボタン**: Workers が `reply_options` を返し、フロントエンドで「はい/いいえ」等のボタンを表示 → クリックで自動送信
- **GAS に FAQ 追加 API（handleAddFaq_）を実装**: POST ?action=add_faq で FAQ をスプレッドシートに追加可能
- **チャット終了ボタン**: `suggest_end: true` 時に「会話を終了する」ボタンを表示。クリックで messages / faqFlow / localStorage（チャット履歴・セッション）をクリアしてリセット。`render()` でも最終メッセージの `suggest_end` フラグを見て再描画時にボタンを復元
- **FAQ キーワード活用形マッチ**: `faqStemMatch()` で動詞語尾（る/い/く 等）や複合語尾（する/した/ない/ている 等）を除去して語幹マッチ。`pickRelevantFaq` の通常キーワード・q テキストの両方で活用形対応
- **choice 選択ボタンのフォーマット拡張**: `buildReplyOptions` が複数の行頭フォーマット（`1)` `1.` `1、` `1:` `①` 等）に対応。パース失敗時は choice メタから番号ボタンを自動生成するフォールバック付き
- **FAQ フロー追加済み**:
  - 歯がしみる（冷たい・甘い・風でしみる）— 3分岐（治療後/治療中/不明）
  - つめもの（かぶせもの・銀歯など）が取れた — 治療中/否 → 症状分岐
  - 入れ歯が痛い — 食事に支障あり→電話 / なし→WEB（slot: eating）
  - 入れ歯が割れた — 食事に支障あり→電話 / なし→WEB（slot: eat）※ユーザーが手動でスプレッドシートに追加
  - **歯がグラグラする** — 4択（自分の歯/詰め物/かぶせ物/差し歯）→ 痛み有無 → 自分の歯+痛みありの場合のみズキズキ質問（3ステップ）
    - slots: `type`(choice 1234), `pain`(yesno), `throb`(yesno)
    - 自分の歯+ズキズキあり → 応急処置・電話
    - 自分の歯+ズキズキなし/痛みなし → 噛まないように・WEB
    - 詰め物+痛みあり → 応急処置・電話
    - 詰め物+痛みなし → 様子見・WEB
    - かぶせ物/差し歯+痛みあり → 様子見・WEB+電話
    - かぶせ物/差し歯+痛みなし → 様子見・WEB
    - `normalizeChoiceBySchema` に flowKey ベースの自然言語マッチング追加（自分/詰め/かぶせ/差し歯）
  - **歯茎が腫れて痛い** — 条件分岐あり（治療中→治療種別5択、非治療中→親知らず有無）→ ズキズキ質問 or 即決
    - slots: `since`(when), `treating`(yesno), `treatment`(choice 12345), `wisdom`(yesno), `throb`(yesno), `denture_eat`(yesno)
    - 治療中+虫歯+ズキズキあり → 電話 / なし → 1週間様子見・WEB
    - 治療中+根管+ズキズキあり → 電話（根っこ先端の病巣）/ なし → 2,3日様子見・WEB
    - 治療中+抜歯+ズキズキあり → 電話+WEB / なし → 電話（2週間腫れ続く場合）
    - 治療中+インプラント → 即決：電話
    - 治療中+入れ歯+食事できる → WEB / できない → 電話
    - 非治療中+親知らず+ズキズキあり → 電話 / なし → WEB（抜歯が必要なケース多い）
    - 非治療中+親知らず以外+ズキズキあり → 電話 / なし → WEB（歯周病 or 根っこの病巣）
    - `normalizeChoiceBySchema` に5択マッチング追加（虫歯/根管/抜歯/インプラント/入れ歯）
    - **`condition` 属性を `advanceSteps` に追加**: ステップ定義に `condition=slotName:value1|value2` を記述すると、条件不成立のステップを自動スキップ
- **FAQ 追加時の文字化け防止対策**:
  - **送信側**: `asciiSafeStringify()` で日本語を `\uXXXX` エスケープに変換し、ASCII-only JSON で送信
  - **GAS 側**: `parsePostJson_()` 関数を追加。UTF-8 バイト列が Latin-1 として誤読された場合にバイト再構築＋UTF-8 デコード
  - `handleAddFaq_` と `handleLog_` の両方で `parsePostJson_` を使用（`gas_full.js` 更新済み・GAS 再デプロイ済み）
- **FAQ 誤マッチ防止ガード**（`pickRelevantFaq` 改良）:
  - **q 主語チェック**: FAQ の q（質問文）から「が」「は」の前の主語を抽出し、ユーザーテキストに主語が含まれない場合はスコアを 5 に抑制（閾値 10 未満で不発にする）。例: q="入れ歯が痛い" → 主語"入れ歯"がテキストに無い → 抑制
  - **必須キーワード（`*`接頭辞）**: k 列で `*入れ歯,痛い` のように `*` 付きキーワードを指定すると、必須キーワードが1つもマッチしない場合はその FAQ をスキップ。主語チェックより明示的な制御が必要な場合に使用

### 未コミット変更（2026-02-27 時点）
- `worker.js` — `checkStepCondition` 追加、`advanceSteps`/`prefillSlotsFromFreeText` に condition チェック追加、必須キーワード `*` サポート、q 主語ガード（`extractQSubject`）、歯茎が腫れて痛いの5択マッチング＋分岐ロジック追加
- `gas_full.js` — `parsePostJson_()` 関数追加（UTF-8 文字化け防止）、`handleAddFaq_` と `handleLog_` で使用
- `CLAUDE.md` — 本ファイルの更新
- **Cloudflare Workers にはデプロイ済み**（wrangler deploy 完了）
- **スプレッドシートにはFAQ追加済み**（GAS API 経由で add_faq 成功）
- **GAS は再デプロイ済み**（parsePostJson_ 含む gas_full.js を貼り付け済み）
- git commit / push はまだ（必要なら `git add worker.js gas_full.js CLAUDE.md && git commit && git push`）

### 今後の作業
- FAQ シートへの新規項目追加（ユーザーが雰囲気を伝えると、正しい形式に変換して追加する運用）
- KNOWLEDGE シートへの患者やり取り要約データの追加
- 完全自動デプロイ（GitHub Actions）への移行（必要になったら）

## Important Notes

- The API endpoint URL is hardcoded in index.html (`API_URL` 変数) — change it there when switching environments
- All UI text is in Japanese
- The app is a medical inquiry tool with explicit disclaimers — do not remove the notice/disclaimer section
- DOB is now collected via year/month/day dropdowns (no longer a text prompt)
- `wrangler deploy` は非秘密の環境変数のみ設定する。秘密変数（OPENAI_API_KEY, GAS_TOKEN）は Dashboard で管理されており、deploy で消えない
- FAQ を追加するときは **スプレッドシートへの追加**（GAS API 経由、ASCII-safe JSON 必須）と **worker.js の decideFlowReply への分岐ロジック追加** の2ステップが必要
- FAQ 追加の API 送信時は必ず `asciiSafeStringify()` を使い、日本語を `\uXXXX` にエスケープする（`JSON.stringify` のまま送ると GAS 側で文字化けする）
- 4択以上の choice フローを追加する場合は `normalizeChoiceBySchema` に flowKey ベースの自然言語マッチングを追加する
- FAQ キーワード（k 列）で `*` を接頭辞にすると必須キーワードになる（例: `*入れ歯,痛い` → 「入れ歯」が含まれないテキストではこの FAQ は発火しない）。q の主語による自動ガードもあるが、明示制御が必要なら `*` を使う
- ステップ定義に `condition=slotName:value1|value2` を追加すると、`slots[slotName]` が指定値のいずれかに一致するときのみそのステップが表示される（条件分岐フロー用）。`advanceSteps` と `prefillSlotsFromFreeText` の両方で condition チェックを実施

## Git 設定
- リポジトリ: https://github.com/373minamiDC/minami-inquiry-chat
- user.name: 373minamiDC
- user.email: 373minami.dc@gmail.com
