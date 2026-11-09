# Cloud Run GPU による無検閲（Uncensored）モデル構築・運用ガイド

Railway（8GB RAM）では 31B クラスの大型 GGUF モデルを動作させることができないため、**Google Cloud Run GPU（NVIDIA L4 / 24GB VRAM・リクエスト時のみ起動する `min-instances=0` 構成）** に `llama.cpp`（`llama-server`）をデプロイし、RoboPolice から OpenAI 互換 API として呼び出す手順と運用方法をまとめます。

---

## 1. 全体アーキテクチャと 2 段階ルーティング

```
[Discord ユーザー]
   │ メンション（任意で --1 / --2 / --r18 等の明示指定も可能）
   ▼
[Railway: RoboPolice Bot (常時稼働 / 8GB RAM)]
   │
   ├─ 通常時 ────────────────────────► [Google Gemini API]
   │
   └─ 検閲ブロック / R18判定 / 明示指定時
         │
         ├─ ① 通常フォールバック (Model 1: UNCENSORED_MODEL)
         │     gemma-4-31B-it-ARA-heretic.IQ4_XS.gguf
         │
         └─ ② R18・創作特化 (Model 2: UNCENSORED_R18_MODEL)
               gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.Q4_K_M.gguf
         │
         ▼ HTTPS (POST /v1/chat/completions + Bearer API Key)
[Google Cloud Run GPU (NVIDIA L4 / 24GB VRAM)]
   ├─ アイドル時: インスタンス数 0（GPU・CPU・メモリ課金 $0）
   ├─ 起動時: GCS バケット (/models) をマウントし、指定されたモデルを VRAM にロード
   └─ llama.cpp (llama-server --models-dir /models --models-max 1)
```

### 自動ルーティングの優先順位

| 状況・トリガー | 選択される環境変数 | 推奨モデル | 動作の詳細 |
| :--- | :--- | :--- | :--- |
| **① 通常の検閲ブロック**<br>（Gemini が `PROHIBITED_CONTENT` / `SAFETY` 等で拒否） | `UNCENSORED_MODEL`<br>（モデル1） | `gemma-4-31B-it-ARA-heretic.IQ4_XS.gguf` | 論理破綻が少なく日本語・文脈追従性が高い Heretic 31B モデルで応答します。 |
| **② R18・成人向け・創作判定**<br>（R18 キーワード検出、`hand_over_r18` ツール呼出、または Gemini の道徳的説教・拒絶応答） | `UNCENSORED_R18_MODEL`<br>（モデル2） | `gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.Q4_K_M.gguf` | ロールプレイ・成人向け創作表現に特化した 31B Thinking モデルで応答します。 |

---

## 2. 料金体系とコスト試算（本当に使った分だけ？）

Cloud Run GPU（`--min-instances=0`）＋ Cloud Storage（GCS）構成の料金は、**「① モデル置き場（GCS）のわずかな保管料」＋「② リクエストが来てコンテナが動いている秒数分の GPU/CPU/メモリ料金」のみ**です。

| 項目 | 使っていない時（アイドル時） | 使った時（稼働時）の単価 | 目安（円換算・$1=150円） |
| :--- | :--- | :--- | :--- |
| **Cloud Run GPU (NVIDIA L4・ゾーン冗長なし)** | **$0 / 秒（完全無料）** | $0.0001867 / 秒（約 $0.67 / 時間） | 約 1.68 円 / 分 |
| **Cloud Run CPU (8 vCPU)** | **$0 / 秒（完全無料）** | $0.0001440 / 秒（約 $0.52 / 時間） | 約 1.30 円 / 分 |
| **Cloud Run メモリ (32 GiB)** | **$0 / 秒（完全無料）** | $0.0000640 / 秒（約 $0.23 / 時間） | 約 0.58 円 / 分 |
| **推論コンテナ合計（GPU + CPU + RAM）** | **$0（インスタンス数 0）** | **$0.0003947 / 秒（約 $0.0237 / 分・約 $1.42 / 時間）** | **約 3.6 円 / 分（約 215 円 / 時間）** |
| **GCS ストレージ（唯一の固定費）** | 約 $0.020〜$0.023 / GB・月 | **1モデル（17.1GB）: 約 $0.39 / 月**<br>**2モデル合計（35.6GB）: 約 $0.82 / 月** | **1モデル: 約 60 円 / 月**<br>**2モデル: 約 125 円 / 月** |

### 注意点（知っておくべき仕様）
1. **唯一の固定費は GCS のファイル保管代（月 60〜125 円程度）のみ**:
   誰も無検閲モデルを呼び出さない月は、Cloud Run の課金は完全に **$0** で、GCS に置いてある GGUF ファイルの容量代（約 $0.4〜$0.8/月）しかかかりません。
2. **起動〜アイドル終了までの秒単位課金**:
   リクエストが来るとコンテナが起動（コールドスタート約 30 秒＋生成 15〜30 秒）し、応答完了後も連続会話に備えて数分〜最大15分ほどウォーム状態（待機）を維持してから自動で `0` 台に戻ります。1回の呼び出し＋待機を含めても数セント（数円〜数十円）単位です。
3. **Google AI Ultra 特典（毎月 $100 クレジット）で実質無料**:
   Google AI Ultra 付帯の **Google Developer Program クレジット（毎月 $100 ＝ 約 15,000 円分）** は GCS ストレージ代にも Cloud Run GPU 代にもそのまま充当されます。ストレージ代（約 $0.8）を差し引いても **毎月 約 70 時間分の GPU フル稼働枠**が無料になるため、通常の Bot 運用では手出し **$0** で収まります。

---

## 3. 事前準備：Google AI Ultra 特典クレジットの有効化

1. [Google Developer Program](https://developers.google.com/program) にアクセスし、Google AI Ultra を契約している Google アカウントでサインインします。
2. ダッシュボードの **「Benefits（特典）」** タブを開きます。
3. **「Google Cloud credits ($100/month)」** を選択し、使用する GCP プロジェクトの請求先アカウントにクレジットを適用します。

---

## 4. Cloud Run GPU の構築手順（Google Cloud Shell で完結）

手元の PC に数十 GB のモデルをダウンロードする必要はありません。[Google Cloud Console](https://console.cloud.google.com/) 右上の **`>_`（Cloud Shell をアクティブにする）** を開き、データセンター内の高速回線で Hugging Face から GCS バケットへ直接流し込みます。

### ステップ 1: プロジェクト設定と API 有効化（アジア最寄りリージョン: `asia-southeast1` シンガポール）

> **重要（リージョンについて）**:
> Cloud Run のサーバーレス L4 GPU（`--gpu-type=nvidia-l4`）が対応しているリージョンは `asia-southeast1`（シンガポール）、`us-central1`、`us-east4`、`europe-west1`、`europe-west4` の 5 つのみです（`asia-northeast1` 東京は未対応）。
> **GCS バケットと Cloud Run のリージョンが異なるとリージョン間通信料（約 $0.08/GB）が発生してしまうため、必ず両方とも同じ `asia-southeast1`（同一リージョン内通信は完全無料）に統一してください。**

```bash
export PROJECT_ID="wax100"
export REGION="asia-southeast1"
export BUCKET_NAME="${PROJECT_ID}-llm-models"
export UNCENSORED_KEY=$(openssl rand -hex 32)

echo "生成されたAPIキー（後でRailwayに設定します）: ${UNCENSORED_KEY}"

gcloud config set project "${PROJECT_ID}"
gcloud services enable run.googleapis.com storage.googleapis.com
```

### ステップ 2: GCS バケット作成・権限付与と 2 モデルの直接転送

```bash
# モデル保存用バケットを作成（必ず Cloud Run と同じ asia-southeast1 に作成）
gcloud storage buckets create "gs://${BUCKET_NAME}" --location="${REGION}"

# Cloud Run のデフォルトサービスアカウントに GCS バケットの読み取り権限を付与
PROJECT_NUM=$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="serviceAccount:${PROJECT_NUM}-compute@developer.gserviceaccount.com" \
  --role="roles/storage.objectViewer"

# ① モデル1（通常フォールバック用: ARA Heretic 31B / 約15.7GiB）
curl -fL "https://huggingface.co/mradermacher/gemma-4-31B-it-ARA-heretic-GGUF/resolve/main/gemma-4-31B-it-ARA-heretic.IQ4_XS.gguf" \
  | gcloud storage cp - "gs://${BUCKET_NAME}/gemma-4-31B-it-ARA-heretic.IQ4_XS.gguf"

# ② モデル2（R18・創作特化用: DECKARD Heretic Thinking 31B / 約17.4GiB）
curl -fL "https://huggingface.co/mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-GGUF/resolve/main/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.Q4_K_M.gguf" \
  | gcloud storage cp - "gs://${BUCKET_NAME}/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.Q4_K_M.gguf"
```

### ステップ 3: Cloud Run GPU（マルチモデル・ルーターモード）のデプロイ

`llama-server` の `--models-dir /models` と `--models-max 1` を指定することで、バケット内の任意の `.gguf` を API リクエストの `model` パラメータに応じて自動的に入れ替えてロードできます（L4 の 24GB VRAM に常に 1 モデルだけ展開されます）。
また、API キーはコマンド引数（`--args`）ではなく環境変数 `LLAMA_API_KEY`（`--set-env-vars`）として渡すことで、コンソールの「コマンドと引数」欄に露出しないようにします。

```bash
gcloud beta run deploy gemma-heretic \
  --image=ghcr.io/ggml-org/llama.cpp:server-cuda \
  --region="${REGION}" \
  --gpu=1 \
  --gpu-type=nvidia-l4 \
  --no-gpu-zonal-redundancy \
  --cpu=8 \
  --memory=32Gi \
  --min-instances=0 \
  --max-instances=1 \
  --concurrency=4 \
  --timeout=900 \
  --cpu-boost \
  --no-cpu-throttling \
  --allow-unauthenticated \
  --add-volume=name=models,type=cloud-storage,bucket="${BUCKET_NAME}",mount-options="implicit-dirs;metadata-cache-ttl-secs=3600" \
  --add-volume-mount=volume=models,mount-path=/models \
  --set-env-vars="LLAMA_API_KEY=${UNCENSORED_KEY}" \
  --command="/app/llama-server" \
  --args="--models-dir,/models,--models-max,1,--host,0.0.0.0,--port,8080,-ngl,99,-c,8192,-fa,on"
```

デプロイ完了時に表示される `Service URL`（例: `https://gemma-heretic-xxxxxx.asia-southeast1.run.app`）を控えます。

---

## 5. Railway（RoboPolice）側の環境変数設定

Railway のダッシュボード（Variables）に以下の環境変数を設定します（末尾に `.gguf` が付いていても自動的に除去・正規化されます）。

```env
UNCENSORED_API_URL=https://gemma-heretic-xxxxxx.asia-southeast1.run.app/v1
UNCENSORED_API_KEY=<ステップ1で生成されたUNCENSORED_KEY>
UNCENSORED_SKIP_STARTUP_PROBE=true

# ① 通常フォールバック用（モデル1）
UNCENSORED_MODEL=gemma-4-31B-it-ARA-heretic.IQ4_XS

# ② R18・成人向け特化用（モデル2）
UNCENSORED_R18_MODEL=gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.Q4_K_M
```

- `UNCENSORED_SKIP_STARTUP_PROBE=true` を設定すると、Railway 側で Bot が再起動した際に `/v1/models` への起動時プローブを行わなくなるため、不要な Cloud Run GPU のコールドスタート（課金）を防げます。
- リクエスト時にモデルが `unloaded` 状態の場合は、Bot が自動的に `POST /models/load` を呼んで `GET /v1/models` でロード完了を待機してから推論リクエストを送るため、コールドロード時の `upstream request timeout` も自動的に回避されます。

---

## 6. 新しいモデルへの入れ替え・追加方法（汎用対応）

今後新しい GGUF モデルを試したい場合、**Cloud Run の再デプロイやコード変更は不要**です。

1. **GCS バケットに新しい `.gguf` ファイルを置く**:
   ```bash
   curl -fL "https://huggingface.co/<作者>/<リポジトリ>/resolve/main/<ファイル名>.gguf" \
     | gcloud storage cp - "gs://${BUCKET_NAME}/<ファイル名>.gguf"
   ```
2. **切り替える方法**:
   - **恒久的に切り替える場合**: Railway の環境変数（`UNCENSORED_MODEL` / `UNCENSORED_R18_MODEL`）を `<ファイル名>`（または `<ファイル名>.gguf`）に書き換えるだけで反映されます。
   - **単一モデル運用の場合**: バケットに `.gguf` が 1 つだけの場合、`UNCENSORED_MODEL` を未設定（空欄）にしておけば `/v1/models` から自動的にモデル ID を検出して使用します。
   - **チャットから一時的に試す場合**: 下述の明示的モデル指定（`@RoboPolice --model <ファイル名> ...`）で即座に呼び出せます。

---

## 7. Discord メッセージ・リプライから明示的にモデルを指定する方法

メンション本文の**先頭または末尾**にモデル指定タグやフラグを含めるか、**前にモデル指定や R18 指定を使ったメッセージ／Bot 返信にリプライ**すると、**Gemini（Argon4 等）をスキップして指定したモデルへ直接ルーティング**できます。
※ 指定したタグ・フラグ文字列は、AI に渡される前に本文から自動的に除去されます。

### ショートカット一覧

| 指定したいモデル | メッセージ内に含める書き方（先頭・末尾のどちらでも可） | 実際の動作 |
| :--- | :--- | :--- |
| **モデル1（通常無検閲 / `UNCENSORED_MODEL`）** | `--1` / `--uncensored` / `--model 1` / `-m 1` / `[model:1]` / `[1]` | Gemini を通さず、直接 **モデル1（ARA Heretic 31B）** で回答を生成します。 |
| **モデル2（R18・創作特化 / `UNCENSORED_R18_MODEL`）** | `--2` / `--r18` / `--model 2` / `-m 2` / `[model:2]` / `[r18]` / `【R18】` | Gemini を通さず、直接 **モデル2（DECKARD R18 31B）** で回答を生成します。 |
| **任意のカスタムモデル（GCS 内の `.gguf` 等）** | `--model <モデル名>` / `[model:<モデル名>]` | GCS バケットに入れた別モデルをピンポイントで直接呼び出します。 |
| **Gemini のティアを明示指定** | `--deep`（Argon4） / `--flash`（Flash） / `--lite`（Flash-Lite） | 通常モデルの Gemini 側で推論ティアを強制指定します（検閲ブロック時は通常通り無検閲へフォールバック）。 |

### 使用例（通常メンション・リプライの両対応）

```text
@RoboPolice --1 この設定でダークファンタジーの導入を書いて
@RoboPolice --2 ちょっと大人向けのシチュエーションでセリフを考えて
@RoboPolice 続きを書いて --r18
@RoboPolice [model:2] もっと詳しく描写して
（前の R18 や --2 の返信に対してそのままリプライ）もっと続きを書いて
```
