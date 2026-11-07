# DeepSeek-V4-Pro-Qwen3.5-9B-UNCENSORED-heretic（Railway 内部デプロイ手順）

`xtools-at/DeepSeek-V4-Pro-Qwen3.5-9B-UNCENSORED-heretic` の GGUF 量子化モデル（`mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-UNCENSORED-heretic-i1-GGUF`）を、Railway の同じプロジェクト内に `llama-server` として立ち上げ、プライベートネットワーク（`*.railway.internal`）経由で `RoboPolice` と接続する手順です。

## 1. Railway にモデル用サービスを追加する（Git push 不要）

1. Railway の `RoboPolice` プロジェクト画面を開きます。
2. 右上の **+ New** → **Docker Image** をクリックします。
3. イメージ名に以下を入力して Enter を押します：
   ```text
   ghcr.io/ggml-org/llama.cpp:server
   ```
4. 追加されたサービスの **Variables** タブ（**Raw Editor** が便利です）に以下を貼り付けます：
   ```env
   LLAMA_ARG_HOST=::
   LLAMA_ARG_PORT=8080
   LLAMA_ARG_HF_REPO=mradermacher/DeepSeek-V4-Pro-Qwen3.5-9B-UNCENSORED-heretic-i1-GGUF:IQ3_M
   LLAMA_ARG_CTX_SIZE=8192
   LLAMA_ARG_JINJA=1
   LLAMA_ARG_REASONING=off
   ```
   - `IQ3_M`（約 3.99 GB）は Railway のメモリ上限（8 GB）内で余裕をもって動作します。より高精度にしたい場合は `:Q4_K_M`（約 5.63 GB）に変更できます。
   - `LLAMA_ARG_HOST=::` により、Railway の IPv6 内部通信（`*.railway.internal`）で外部公開なしに安全に接続できます。

## 2. RoboPolice 本体の Variables を設定する

1. 同じプロジェクト内の `RoboPolice` サービスの **Variables** タブを開きます。
2. 以下を追加します（`<サービス名>` は手順 1 で作成したサービスの名前、または `${{サービス名.RAILWAY_PRIVATE_DOMAIN}}` 参照変数）：
   ```env
   UNCENSORED_API_URL=http://${{llama-server.RAILWAY_PRIVATE_DOMAIN}}:8080/v1
   GEMINI_REPLY_TIMEOUT_MS=180000
   ```
   （※手順 1 のサービス名を `llama-server` にした場合、上記をそのまま貼り付けるだけで繋がります）
