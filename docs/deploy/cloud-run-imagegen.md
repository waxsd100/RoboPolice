# 検閲なしの画像モデル（Cloud Run GPU）

会話で頼まれた画像（`generate_image`）のうち、成人向けの画像と、Gemini の画像モデルが断った画像を描く、検閲なしの画像モデルを立てる手順です。検閲なしの文章モデル（[cloud-run-gpu.md](cloud-run-gpu.md)）と同じく、Cloud Run GPU（NVIDIA L4）で、使われたときだけ動かします。

## 使われる条件

検閲なしの画像モデルが使われるのは、次の**すべて**に当てはまるときだけです。

- `UNCENSORED_IMAGE_API_URL` が設定されている
- サーバーで検閲なしモデルが有効（`%safety r18 on`。オーナーサーバーは既定で有効）で、セーフティフィルタがオフ
- 依頼されたチャンネル（スレッドなら親チャンネル）が**年齢制限あり**

そのうえで、次の2つの場合に使われます。

- 会話の AI が `generate_image` を `adult: true` で呼んだとき、または検閲なしの文章モデルが返事に `[[画像: …]]` の行を書いたとき
- Gemini の画像モデルが画像を断ったとき（代わりに描く）

条件に当てはまらないチャンネルでは、成人向けの画像は作らず、会話の AI にその理由を返します。

## 子どもは描かない

成人向けの画像では、子ども・未成年は描きません。画像が崩れないよう、止め方は最小限にしています。

1. Bot（`src/bot/utils/uncensoredImage.js`）が、子どもであることをはっきり示す語（child・loli・shota・schoolgirl・小学生・女子高生・JK・17歳以下の年齢など）を含む依頼を、画像モデルに送る前に断る。「少女」「teen」「school uniform」のような、アニメの絵柄で普通に使う語では断らない
2. 画像のサーバー（`imagegen/server.py`）も同じ語の依頼を断る（HTTP 400）
3. 除外プロンプト（negative prompt）は短く「child, loli, shota」と画質の語だけにする。依頼のプロンプトには何も足さない

語の一覧を変えるときは、1 と 2 の両方を直してください。

## 1. モデル（チェックポイント）を用意する

SDXL 系のチェックポイント（`.safetensors`）を GCS のバケットに置きます。何を使うかは運営者が選んでください。ライセンス（商用利用・成人向けの生成を許しているか）を必ず確かめてください。

```bash
export PROJECT_ID="wax100"
export REGION="asia-southeast1"
export BUCKET_NAME="${PROJECT_ID}-image-models"
export IMAGE_KEY=$(openssl rand -hex 32)
echo "API キー（あとで Railway に設定）: ${IMAGE_KEY}"

gcloud config set project "${PROJECT_ID}"
gcloud services enable run.googleapis.com storage.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
gcloud storage buckets create "gs://${BUCKET_NAME}" --location="${REGION}"
PROJECT_NUM=$(gcloud projects describe "${PROJECT_ID}" --format="value(projectNumber)")
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="serviceAccount:${PROJECT_NUM}-compute@developer.gserviceaccount.com" \
  --role="roles/storage.objectViewer"
```

```bash
curl -fL "<チェックポイントの URL>" | gcloud storage cp - "gs://${BUCKET_NAME}/model.safetensors"
```

`IMAGEGEN_MODEL` に Hugging Face のリポジトリ名を入れることもできます（既定は `cagliostrolab/animagine-xl-4.0`）。ただしその場合は、起動するたびに約 7GB をダウンロードするので、起動が遅くなります。

## 2. イメージを作る

```bash
gcloud artifacts repositories create images --repository-format=docker --location="${REGION}"
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/images/imagegen:latest"
gcloud builds submit --config=infra/cloudbuild/imagegen.yaml --substitutions=_IMAGE="${IMAGE}" .
```

## 3. Cloud Run GPU にデプロイする

```bash
gcloud beta run deploy imagegen \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --gpu=1 \
  --gpu-type=nvidia-l4 \
  --no-gpu-zonal-redundancy \
  --cpu=8 \
  --memory=32Gi \
  --min-instances=0 \
  --max-instances=1 \
  --concurrency=1 \
  --timeout=600 \
  --cpu-boost \
  --no-cpu-throttling \
  --allow-unauthenticated \
  --add-volume=name=models,type=cloud-storage,bucket="${BUCKET_NAME}",readonly=true \
  --add-volume-mount=volume=models,mount-path=/models \
  --set-env-vars="IMAGEGEN_MODEL=/models/model.safetensors,IMAGEGEN_API_KEY=${IMAGE_KEY}"
```

`--allow-unauthenticated` でも、`IMAGEGEN_API_KEY` を設定しているので、キーのない呼び出しは HTTP 401 で断られます。

## 4. Bot（Railway）に設定する

```env
UNCENSORED_IMAGE_API_URL=https://imagegen-xxxxx.a.run.app
UNCENSORED_IMAGE_API_KEY=<ステップ1の IMAGE_KEY>
# 任意: 画像を待つ時間（ミリ秒。既定 360000 = 6分。冷えた状態からの起動を含む）
UNCENSORED_IMAGE_TIMEOUT_MS=
```

AUTOMATIC1111 や Forge の Web API（`/sdapi/v1/txt2img`・`/sdapi/v1/img2img`）を自分のパソコンで動かしている場合は、その URL を `UNCENSORED_IMAGE_API_URL` に入れても使えます（Cloudflare Tunnel などで公開）。その場合も、Bot 側の「子どもは描かない」のチェックと除外プロンプトは効きます。

## 費用

文章モデルと同じく、使っていないときは Cloud Run の課金は $0 です。動いている間は約 $1.42 / 時間（L4 + 8 vCPU + 32GiB）で、1枚あたりの生成は10秒前後です。冷えた状態からの起動にはモデルの読み込みで1〜3分かかり、その間も課金されます。
