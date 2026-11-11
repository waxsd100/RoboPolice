# Railway での `GeneLab/sokudan-ja-310m` 構築・連携ガイド

現在 Railway 上で稼働している RoboPolice と同じプロジェクト内に、軽量日本語判断モデル [`GeneLab/sokudan-ja-310m`](https://huggingface.co/GeneLab/sokudan-ja-310m)（CPU 推論・約 3.1 億パラメータ）を**別サービス（内部通信のみ・外部公開なし）**として追加する手順です。

Hugging Face アカウント登録や API キー取得は一切不要で、ビルド時にモデル重みがイメージ内（`/app/model`）へ同梱されるため起動は約 3 秒で完了します。

---

## 1. アーキテクチャ（Railway Private Networking）

```
[Railway Project]
 ├── robopolice (既存の Bot サービス / Dockerfile)
 │     │  環境変数: SOKUDAN_URL=http://${{sokudan.RAILWAY_PRIVATE_DOMAIN}}:8000
 │     ▼  Railway Private Network (内部通信・通信料無料・外部非公開)
 └── sokudan (新規サービス / Dockerfile.sokudan)
       ├─ Public Networking: 無効（外部インターネットからはアクセス不可）
       ├─ Healthcheck Path: /health
       └─ CPU 推論 (メモリ使用量目安: 約 1.0〜1.4 GB)
```

- `Dockerfile.sokudan` は自動でデュアルスタック（`::` = IPv6 + IPv4 両対応）でリッスンするため、Railway の IPv6 内部ネットワーク（`*.railway.internal`）からそのまま接続できます。
- 万が一 `sokudan` サービスを再起動・停止中であっても、Bot 側は 3 秒タイムアウト＋30 秒サーキットブレーカーで自動的に既存の正規表現／Gemini 判定へフォールバックし、メンション応答は止まりません。

---

## 2. Railway での構築手順（5 分）

### ステップ 1: 同じプロジェクト内に `sokudan` サービスを追加

1. [Railway Dashboard](https://railway.com/dashboard) で、RoboPolice が動いている **Project** を開きます。
2. 右上の **`+ Create`**（または **`+ New`**）→ **`GitHub Repo`** を選択し、Bot と同じ **`waxsd100/RoboPolice`** リポジトリを選びます。
3. 作成された新しいサービスをクリックし、分かりやすいように **Settings** → **Service Name** を **`sokudan`** に変更します。

### ステップ 2: `Dockerfile.sokudan` を指定する

`sokudan` サービスの **Settings** タブを開き、以下を設定します。

| 設定項目 | 設定値 | 補足 |
| :--- | :--- | :--- |
| **Source** → **Branch** | `master`（PR マージ前のお試しなら `feat/sokudan-decision-model`） | 自動デプロイ対象ブランチ |
| **Build** → **Builder** | `Dockerfile` | — |
| **Build** → **Dockerfile Path** | `Dockerfile.sokudan` | **重要**: 通常の `Dockerfile` ではなくこちらを指定します |
| **Deploy** → **Healthcheck Path** | `/health` | モデルのロード完了後に Ready になります |
| **Networking** → **Public Networking** | **設定しない（Generate Domain を押さない）** | 内部ネットワーク（`railway.internal`）だけで通信するため外部公開は不要・安全です |

### ステップ 3: `sokudan` サービスの環境変数（Variables）

`sokudan` サービスの **Variables** タブに以下を 1 つだけ追加します（ポート番号を固定するため）。

```env
PORT=8000
```

> ※ もし念のため内部通信にも Bearer 認証を付けたい場合は、任意のランダム文字列を `SOKUDAN_API_KEY` に設定することもできます（内部非公開ネットワークのみであれば省略可）。

設定後、**Deploy** を押すとビルドが始まります（初回は CPU 版 PyTorch とモデル重みのダウンロードで 2〜4 分ほどかかります）。ログに `Uvicorn running on http://[::]:8000` と表示され、ステータスが **Active (Healthy)** になれば準備完了です。

### ステップ 4: 既存の Bot サービス側から接続する

既存の **RoboPolice（Bot 本体）サービス**の **Variables** タブを開き、以下の変数を追加して Redeploy します。

Railway の **Reference Variable（参照変数）** を使うとドメイン名の打ち間違いが起きません：

```env
SOKUDAN_URL=http://${{sokudan.RAILWAY_PRIVATE_DOMAIN}}:${{sokudan.PORT}}
```

（または直接 `http://sokudan.railway.internal:8000` と書いても同じです）

#### 任意のチューニング用環境変数（通常は未設定の既定値で最適）

| 変数名 | 既定値 | 説明 |
| :--- | :--- | :--- |
| `SOKUDAN_TIMEOUT_MS` | `3000` | サイドカー応答のタイムアウト（ミリ秒）。超過時は自動で既存ロジックへフォールバック |
| `SOKUDAN_BOOL_THRESHOLD` | `0.35` | `noul`（真偽判定）の共通閾値（モデルの出力分布に合わせて調整済み） |
| `SOKUDAN_R18_THRESHOLD` | `SOKUDAN_BOOL_THRESHOLD` | 用途1: R18 事前振り分けの閾値だけ個別に変えたい場合（例: `0.40`） |
| `SOKUDAN_DEEP_THRESHOLD` | `SOKUDAN_BOOL_THRESHOLD` | 用途1: `deepModel` 直接振り分けの閾値だけ個別に変えたい場合 |
| `SOKUDAN_INJECTION_THRESHOLD` | `SOKUDAN_BOOL_THRESHOLD` | 用途2a: プロンプトインジェクション警告の閾値 |
| `SOKUDAN_REFUSAL_THRESHOLD` | `SOKUDAN_BOOL_THRESHOLD` | 用途2b: R18 ソフト拒否／朝チュン検知の閾値 |
| `SOKUDAN_POLISH_THRESHOLD` | `SOKUDAN_BOOL_THRESHOLD` | 用途3: `replyPolish` で書き直しを実行する `noul` 閾値 |
| `SOKUDAN_POLISH_SCORE_THRESHOLD` | `1.0` | 用途3: `replyPolish` で書き直しを実行する硬さスコア閾値（`0`〜`2`） |

---

## 3. 動作確認方法

Bot サービスが再起動したら、Railway の **Bot サービスの Deploy Logs** で次のログが出ていることを確認します：

```text
INFO: [SOKUDAN]: Connected to http://sokudan.railway.internal:8000 (model: /app/model, backend: torch, device: cpu)
```

さらに実際のメンション時に以下のログで動作を確認できます：
- **用途1（事前ルーティング）**:
  - `[SOKUDAN]: Deep reasoning/creative request detected (p=0.xx); routing directly to gemini-4-argon`
  - `[SOKUDAN]: R18 intent detected in request (p=0.xx); ... answers instead of ...`
- **用途2（インジェクション検知）**:
  - `[INJECTION]: Possible prompt injection (sokudan p=0.xx) in ...`
- **用途3（`replyPolish` スキップ）**:
  - `[POLISH]: Skipped polishing a natural reply in ... (sokudan score=0.xx, p=0.xx)`

---

## 4. Railway でのリソース・コスト目安

- **メモリ**: アイドル〜推論時で **約 1.0〜1.4 GB RAM**（Hobby / Pro プランの 8GB 上限に対して十分余裕があります）
- **CPU**: メンションが来た瞬間だけ数ミリ秒〜100ms 程度 CPU を使い、待機中はほぼ `0%` です
- **月額目安**: Railway の従量課金（RAM 約 $10/GB・月）で **月 $10〜$14 前後**（一方で `think_deeper` の Flash 1 往復分のトークンと、250 文字以上の返信ごとの `replyPolish` Gemini 呼び出しが削減されます）
