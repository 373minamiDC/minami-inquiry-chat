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

Everything lives in `index.html`:

- **CSS** (lines 7-36): Dark theme using CSS variables (`:root`), responsive layout with flexbox
- **HTML** (lines 38-75): Notice/disclaimer card, profile status bar, chat area, input bar
- **JavaScript** (lines 77-265): All application logic

### Data Flow

1. User types a message and clicks send
2. `ensureProfile()` checks localStorage for patient profile; if missing, prompts for consent, name, and DOB via `confirm()`/`prompt()` dialogs
3. `getOrCreateSessionId()` generates a UUID (or fallback timestamp-based ID) stored in localStorage
4. POST request to `API_URL` with payload: `{ session_id, patient: {name, dob}, user_agent, page_url, messages }`
5. Backend returns `{ reply: "..." }` which is rendered as an AI bubble

### localStorage Keys

| Key | Purpose | Format |
|-----|---------|--------|
| `minami_inquiry_chat_v1` | Chat history (last 30 messages) | `[{role, content}, ...]` |
| `minami_patient_profile_v1` | Patient info | `{name, dob, consent, updated_at}` |
| `minami_inquiry_session_v1` | Session ID | UUID string |

### Key Functions

- `ensureProfile(forceReinput)` - Consent + patient info collection flow
- `send()` - Main send handler: validates profile, calls API, renders response
- `render()` - Rebuilds chat from `messages` array; shows welcome message if empty
- `refreshStatus()` - Updates profile/session display in the status bar

## System Architecture (3層構成)

```
index.html (フロントエンド)
  ↓ POST /api/chat (faq_flow 状態を含む)
worker.js (Cloudflare Workers)
  ├─ 1) FAQ フロー（ステップ分岐・slot 管理）← スプレッドシート FAQ シート
  ├─ 2) Knowledge 要約（全件取得→スコアリング→OpenAI要約）← スプレッドシート KNOWLEDGE シート
  └─ 3) 通常 OpenAI 回答（FAQにもKnowledgeにも該当なし）
  ↓ GAS Web App (doGet / doPost)
Google スプレッドシート
  ├─ FAQ シート（列: q / a / k / enabled）
  ├─ KNOWLEDGE シート（列: doc_title / chunk_id / text）
  └─ LOGS シート（自動生成）
```

### Workers 環境変数 (Cloudflare Settings)
- `GAS_FAQ_URL` : FAQ 取得用 GAS URL (?action=faq)
- `GAS_KNOWLEDGE_URL` : Knowledge 取得用 GAS URL (?action=knowledge)
- `GAS_LOG_URL` : ログ保存用 GAS URL
- `GAS_TOKEN` : ログ保存用トークン
- `OPENAI_API_KEY` : OpenAI API キー
- `OPENAI_MODEL` : 使用モデル（デフォルト: gpt-4o-mini）
- `ALLOWED_ORIGINS` : CORS 許可オリジン

### ローカルファイル
- `worker.js` : Cloudflare Workers 統合版コード（FAQ フロー + Knowledge + OpenAI）
- `gas_full.js` : GAS 完全版（doGet/doPost/FAQ/Knowledge/Logs すべて含む）※ GAS エディタに貼り付け済み
- `gas_knowledge_fix.js` : （旧）GAS の handleKnowledge_ 関数の修正版 → gas_full.js に統合済み
- `index.html` : フロントエンド（faq_flow 対応済み、source タグ表示あり）
- `wrangler.toml` : Cloudflare Workers デプロイ設定（`wrangler deploy` で使用）

## デプロイ方法

### index.html（フロントエンド）
GitHub に push → GitHub Pages が自動反映（設定済み）

### worker.js（Cloudflare Workers）
```bash
# 初回のみ: wrangler CLI インストール
npm install -g wrangler
wrangler login

# wrangler.toml の account_id を設定してから:
wrangler deploy
```
※ 環境変数（API キー等）は Cloudflare Dashboard > Settings > Variables で管理

### GAS（Google Apps Script）
GAS スクリプトエディタで `gas_full.js` の内容を貼り付け → デプロイ > デプロイを管理 > 新しいバージョン
※ 新しいバージョンを選ばないと反映されない

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
- wrangler.toml 作成（半自動デプロイ対応）

### 今後の作業
- FAQ シートへの新規項目追加
- KNOWLEDGE シートへの患者やり取り要約データの追加
- 完全自動デプロイ（GitHub Actions）への移行（必要になったら）

## Important Notes

- The API endpoint URL is hardcoded on line 79 — change it there when switching environments
- All UI text is in Japanese
- The app is a medical inquiry tool with explicit disclaimers — do not remove the notice/disclaimer section
- DOB validation is loose (`YYYY-MM-DD` regex only); the user can override format warnings
