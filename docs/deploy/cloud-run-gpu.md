# Cloud Run GPU による無検閲（Uncensored）モデル構築・運用ガイド

Railway（8GB RAM）では 31B クラスの大型 GGUF モデルを動作させることができないため、**Google Cloud Run GPU（NVIDIA L4 / 24GB VRAM・リクエスト時のみ起動する `min-instances=0` 構成）** に `llama.cpp`（`llama-server`）をデプロイし、RoboPolice から OpenAI 互換 API として呼び出す手順と運用方法をまとめます。

---

## 1. 全体アーキテクチャと 3 段階ルーティング

```
[Discord ユーザー]
   │ メンション（任意で --model 1/2/3 等の明示指定も可能）
   ▼
[Railway: RoboPolice Bot (常時稼働 / 8GB RAM)]
   │
   ├─ 通常時 ────────────────────────► [Google Gemini API]
   │
   └─ 検閲ブロック / R18判定 / 制限到達 / 明示指定時
         │
         ├─ ① 通常フォールバック (Model 1: UNCENSORED_MODEL)
         │     gemma-4-31B-it-ARA-heretic.IQ4_XS.gguf
         │
         ├─ ② R18・創作特化 (Model 2: UNCENSORED_R18_MODEL)
         │     gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.Q4_K_M.gguf
         │
         └─ ③ トークン制限・高負荷・障害時 (Model 3: UNCENSORED_FAST_MODEL)
               Gemma-4-26B-A4B-It-Abliterated-Q4_K_M.gguf (高速 MoE / 4B Active)
         │
         ▼ HTTPS (POST /v1/chat/completions + Bearer API Key)
[Google Cloud Run GPU (NVIDIA L4 / 24GB VRAM)]
   ├─ アイドル時: インスタンス数 0（GPU 課金 $0）
   ├─ 起動時: GCS バケット (/models) をマウントし、指定されたモデルを VRAM にロード
   └─ llama.cpp (llama-server --models-dir /models --models-max 1)
```

### 自動ルーティングの優先順位

| 状況・トリガー | 選択される環境変数 | 推奨モデル | 動作の詳細 |
| :--- | :--- | :--- | :--- |
| **① 通常の検閲ブロック**<br>（Gemini が `PROHIBITED_CONTENT` / `SAFETY` 等で拒否） | `UNCENSORED_MODEL`<br>（モデル1） | `gemma-4-31B-it-ARA-heretic.IQ4_XS.gguf` | 論理破綻が少なく日本語・文脈追従性が高い Heretic 31B モデルで応答します。 |
| **② R18・成人向け・創作判定**<br>（R18 キーワード検出、`hand_over_r18` ツール呼出、または Gemini の道徳的説教・拒絶応答） | `UNCENSORED_R18_MODEL`<br>（モデル2） | `gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.Q4_K_M.gguf` | ロールプレイ・成人向け創作表現に特化した 31B Thinking モデルで応答します。 |
| **③ 制限到達・高負荷・フォールバック失敗時**<br>（サーバー/ユーザーのトークン上限到達で Flex ティアに落ちた場合、Bot 全体の負荷が高い場合、またはモデル1/2 がタイムアウト・エラーになった場合） | `UNCENSORED_FAST_MODEL`<br>（モデル3 / 高速版） | `Gemma-4-26B-A4B-It-Abliterated-Q4_K_M.gguf` | MoE（Mixture of Experts）構造により **1トークンあたり 4B 分のみ計算**されるため、31B Dense 比で約 4〜5 倍高速・低コストに応答します。 |

---

## 2. 事前準備：Google AI Ultra 特典クレジットの有効化

**Google AI Ultra** プランを契約している場合、付帯する **Google Developer Program Premium 特典**として **毎月 $100 分の Google Cloud クレジット**を受け取ることができます（Cloud Run GPU の従量課金にそのまま充当可能）。

1. [Google Developer Program](https://developers.google.com/program) にアクセスし、Google AI Ultra を契約している Google アカウントでサインインします。
2. ダッシュボードの **「Benefits（特典）」** タブを開きます。
3. **「Google Cloud credits ($100/month)」** を選択し、使用する GCP プロジェクトの請求先アカウントにクレジットを適用します。

---

## 3. Cloud Run GPU の構築手順（Google Cloud Shell で完結）

手元の PC に数十 GB のモデルをダウンロードする必要はありません。[Google Cloud Console](https://console.cloud.google.com/) 右上の **`>_`（Cloud Shell をアクティブにする）** を開き、データセンター内の高速回線で Hugging Face から GCS バケットへ直接流し込みます。

### ステップ 1: プロジェクト設定と API 有効化

```bash
export PROJECT_ID="あなたのGCPプロジェクトID"
export REGION="us-central1"
export BUCKET_NAME="${PROJECT_ID}-llm-models"
export UNCENSORED_KEY=$(openssl rand -hex 32)

echo "生成されたAPIキー（後でRailwayに設定します）: ${UNCENSORED_KEY}"

gcloud config set project "${PROJECT_ID}"
gcloud services enable run.googleapis.com storage.googleapis.com
```

### ステップ 2: GCS バケット作成と 3 モデルの直接転送

```bash
# モデル保存用バケットを作成
gcloud storage buckets create "gs://${BUCKET_NAME}" --location="${REGION}"

# ① モデル1（通常フォールバック用: ARA Heretic 31B / 約17.1GB）
curl -L "https://huggingface.co/mradermacher/gemma-4-31B-it-ARA-heretic-GGUF/resolve/main/gemma-4-31B-it-ARA-heretic.IQ4_XS.gguf" \
  | gcloud storage cp - "gs://${BUCKET_NAME}/gemma-4-31B-it-ARA-heretic.IQ4_XS.gguf"

# ② モデル2（R18・創作特化用: DECKARD Heretic Thinking 31B / 約18.5GB）
curl -L "https://huggingface.co/DavidAU/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking/resolve/main/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.Q4_K_M.gguf" \
  | gcloud storage cp - "gs://${BUCKET_NAME}/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.Q4_K_M.gguf"

# ③ モデル3（制限到達時・高速MoE版: 26B-A4B Abliterated / 約16.0GB）
curl -L "https://huggingface.co/SevenOfNine/Gemma-4-26B-A4B-It-Abliterated-GGUF/resolve/main/Gemma-4-26B-A4B-It-Abliterated-Q4_K_M.gguf" \
  | gcloud storage cp - "gs://${BUCKET_NAME}/Gemma-4-26B-A4B-It-Abliterated-Q4_K_M.gguf"
```

### ステップ 3: Cloud Run GPU（マルチモデル・ルーターモード）のデプロイ

`llama-server` の `--models-dir /models` と `--models-max 1` を指定することで、バケット内の任意の `.gguf` を API リクエストの `model` パラメータに応じて自動的に入れ替えてロードできます（L4 の 24GB VRAM に常に 1 モデルだけ展開されます）。

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
  --timeout=300 \
  --no-cpu-throttling \
  --allow-unauthenticated \
  --add-volume=name=models,type=cloud-storage,bucket="${BUCKET_NAME}",mount-options="implicit-dirs;metadata-cache-ttl-secs=3600" \
  --add-volume-mount=volume=models,mount-path=/models \
  --command="/app/llama-server" \
  --args="--models-dir,/models,--models-max,1,--host,0.0.0.0,--port,8080,-ngl,99,-c,8192,-fa,on,--api-key,${UNCENSORED_KEY}"
```

デプロイ完了時に表示される `Service URL`（例: `https://gemma-heretic-xxxxxx-uc.a.run.app`）を控えます。

---

## 4. Railway（RoboPolice）側の環境変数設定

Railway のダッシュボード（Variables）に以下の環境変数を設定します。

```env
UNCENSORED_API_URL=https://gemma-heretic-xxxxxx-uc.a.run.app/v1
UNCENSORED_API_KEY=<ステップ1で生成されたUNCENSORED_KEY>
UNCENSORED_SKIP_STARTUP_PROBE=true

# ① 通常フォールバック用（モデル1）
UNCENSORED_MODEL=gemma-4-31B-it-ARA-heretic.IQ4_XS.gguf

# ② R18・成人向け特化用（モデル2）
UNCENSORED_R18_MODEL=gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking.Q4_K_M.gguf

# ③ 制限到達・高負荷時の高速版（モデル3）
UNCENSORED_FAST_MODEL=Gemma-4-26B-A4B-It-Abliterated-Q4_K_M.gguf
```

- `UNCENSORED_SKIP_STARTUP_PROBE=true` を設定すると、Railway 側で Bot が再起動した際に `/v1/models` への起動時プローブを行わなくなるため、不要な Cloud Run GPU のコールドスタート（課金）を防げます。
- `UNCENSORED_Timeout_MS`（内部設定: 240,000ms = 4分）により、Cloud Run GPU が `0` インスタンスからコールドスタート（約 25〜40 秒）してもタイムアウトせずに待機します。

---

## 5. 新しいモデルへの入れ替え・追加方法（汎用対応）

今後新しい GGUF モデルを試したい場合、**Cloud Run の再デプロイやコード変更は不要**です。

1. **GCS バケットに新しい `.gguf` ファイルを置く**:
   ```bash
   curl -L "https://huggingface.co/<作者>/<リポジトリ>/resolve/main/<ファイル名>.gguf" \
     | gcloud storage cp - "gs://${BUCKET_NAME}/<ファイル名>.gguf"
   ```
2. **切り替える方法**:
   - **恒久的に切り替える場合**: Railway の環境変数（`UNCENSORED_MODEL` / `UNCENSORED_R18_MODEL` / `UNCENSORED_FAST_MODEL`）を `<ファイル名>.gguf` に書き換えるだけで反映されます。
   - **単一モデル運用の場合**: バケットに `.gguf` が 1 つだけの場合、`UNCENSORED_MODEL` を未設定（空欄）にしておけば `/v1/models` から自動的にモデル ID を検出して使用します。
   - **チャットから一時的に試す場合**: 下述の明示的モデル指定（`@RoboPolice --model <ファイル名>.gguf ...`）で即座に呼び出せます。

---

## 6. Discord メッセージから明示的にモデルを指定する方法

メンション本文の**任意の位置**（先頭・末尾・途中どこでも可）にモデル指定タグやフラグを含めると、**Gemini をスキップして指定したモデルへ直接ルーティング**（または Gemini のティアを強制指定）できます。
※ 指定したタグ・フラグ文字列は、AI に渡される前に本文から自動的に除去されます。

### ショートカット一覧

| 指定したいモデル | メッセージ内に含める書き方（どれでも同じ動作） | 実際の動作 |
| :--- | :--- | :--- |
| **モデル1（通常無検閲 / `UNCENSORED_MODEL`）** | `--model 1` / `-m 1` / `[model:1]` / `--1` / `--uncensored` | Gemini を通さず、直接 **モデル1（ARA Heretic 31B）** で回答を生成します。 |
| **モデル2（R18・創作特化 / `UNCENSORED_R18_MODEL`）** | `--model 2` / `-m 2` / `[model:2]` / `--2` / `--r18` | Gemini を通さず、直接 **モデル2（DECKARD R18 31B）** で回答を生成します。 |
| **モデル3（高速 MoE 版 / `UNCENSORED_FAST_MODEL`）** | `--model 3` / `-m 3` / `[model:3]` / `--3` / `--fast` | Gemini を通さず、直接 **モデル3（26B-A4B 高速版）** で回答を生成します。 |
| **任意のカスタムモデル（GCS 内の `.gguf` 等）** | `--model <ファイル名.gguf>` / `[model:<ファイル名.gguf>]` | GCS バケットに入れた別モデルをピンポイントで直接呼び出します。 |
| **Gemini のティアを明示指定** | `--deep`（Pro） / `--flash`（Flash） / `--lite`（Flash-Lite） | 通常モデルの Gemini 側で推論ティアを強制指定します（検閲ブロック時は通常通り無検閲へフォールバック）。 |

### 使用例

```text
@RoboPolice --1 この設定でダークファンタジーの導入を書いて
@RoboPolice --r18 ちょっと大人向けのシチュエーションでセリフを考えて
@RoboPolice --fast 手短に要約して！
@RoboPolice [model:2] 続きを書いて
@RoboPolice --model my-custom-model.Q4_K_M.gguf 新しいモデルのテスト！
```
