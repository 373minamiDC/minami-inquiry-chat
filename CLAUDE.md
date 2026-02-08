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
- `send()` - メイン送信ハンドラ: プロフィール確認 → API呼び出し → レスポンス描画（reply_options があればボタン表示）
- `addBubble(role, text, source, options)` - チャットバブル追加。options があれば選択ボタンも描画
- `render()` - messages 配列からチャットを再構築
- `refreshStatus()` - プロフィール/セッション表示を更新

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
GAS の `handleAddFaq_` エンドポイントを使って API 経由で追加可能:
```javascript
// Node.js スクリプトで追加（例）
const body = JSON.stringify({
  q: "質問テキスト",
  a: "[[step1 expect=yesno slot=slotname]]質問文\\n（「はい」または「いいえ」でお答えください）",
  k: "キーワード1,キーワード2",
  enabled: true,
});
fetch(GAS_URL + "?action=add_faq&token=任意の文字列", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body,
});
```
※ FAQ にステップフローを追加した場合、`worker.js` の `decideFlowReply` 関数にも対応する分岐ロジックを追加する必要がある

## 現在の作業状況（2026-02-08 時点）

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
- **FAQ フロー追加済み**:
  - 歯がしみる（冷たい・甘い・風でしみる）— 3分岐（治療後/治療中/不明）
  - つめもの（かぶせもの・銀歯など）が取れた — 治療中/否 → 症状分岐
  - 入れ歯が痛い — 食事に支障あり→電話 / なし→WEB（slot: eating）
  - 入れ歯が割れた — 食事に支障あり→電話 / なし→WEB（slot: eat）※ユーザーが手動でスプレッドシートに追加

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
- FAQ を追加するときは **スプレッドシートへの追加** と **worker.js の decideFlowReply への分岐ロジック追加** の2ステップが必要

## Git 設定
- リポジトリ: https://github.com/373minamiDC/minami-inquiry-chat
- user.name: 373minamiDC
- user.email: 373minami.dc@gmail.com
