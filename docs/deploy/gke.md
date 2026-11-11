# GKE（wax100 k8s-platform）で動かす

Railway で動かしている RoboPolice を、[waxsd100/k8s-platform](https://github.com/waxsd100/k8s-platform) の
GKE へ移すための手順です。dev は Canine、本番は Canine からの昇格（GitOps）で動かします。

```text
dev  : Canine プロジェクト robopolice（Namespace robopolice、gVisor）
         + アドオン robopolice-postgres（公式 postgres:18 ＋ 注釈で pgvector）・robopolice-redis
本番 : prod-robopolice（Config Sync が components/apps/robopolice から同期）
         BOT 1 台（Recreate）＋ postgres ＋ redis。機密は Secret Manager → External Secrets
```

> [!IMPORTANT]
>
> **BOT は必ず 1 台で動かします。** 同じ `BOT_TOKEN` で 2 本つながると、ログも返信も二重になります。
> 昇格ジョブは既定で HPA（最小 2 台）を付けるので、昇格の前に dev の Namespace に
> `wax100.io/single-replica=true` を付けます（下の 3）。同じ理由で、**dev には本番と別の BOT（テスト用の
> Discord アプリ）のトークンを使い**、本番の切り替え中は Railway と GKE が同時に動かないようにします（下の 5）。

## 0. 前提

- k8s-platform に次の 2 つが入っていること（`wax100.io/single-replica` ラベルと、PostgreSQL の拡張を注釈で
  差し込む `wax100.io/postgres-extensions`）
- 管理者の kubectl コンテキスト `wax100-dev` / `wax100-prod`（k8s-platform の `hack/kubectl-contexts.sh`）
- テスト用の Discord アプリの BOT トークン（Server Members・Message Content・Presence の各 Intent を有効に）と、
  それを入れたテスト用サーバー

## 1. DB と Redis（Canine のアドオン）

RoboPolice は pgvector が要ります（`src/db/migrations/009_pgvector.js`）。DB のイメージは公式の `postgres:18` の
まま替えず、Pod の注釈 `wax100.io/postgres-extensions: "vector"` で pgvector を差し込みます（k8s-platform の Kyverno が、
Pod の作成時に拡張のファイルを写して `extension_control_path` で読ませる）。ほかの拡張が要るようになったら、
注釈にカンマ区切りで足します（k8s-platform のカタログ `addons/kyverno/base/configmap-postgres-extensions.yaml` にあるもの）。
`pgcrypto` などの contrib は公式イメージに入っているので、注釈なしで `CREATE EXTENSION` できます。

| アドオン名            | チャート                                                               | values                                                                                                                                              |
| :-------------------- | :--------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| `robopolice-postgres` | `groundhog2k/postgres`（`https://groundhog2k.github.io/helm-charts/`） | `podAnnotations: { wax100.io/postgres-extensions: "vector" }`・`image.tag: "18"`・`storage.requestedSize: 20Gi`・`settings.superuserPassword.value` |
| `robopolice-redis`    | `groundhog2k/redis`                                                    | 既定のままでよい（中身は 3 時間で消えるキャッシュなので、永続化は無くてもよい）                                                                     |

- **名前は必ず `robopolice-<何か>` にします。** 昇格ジョブがこの名前でアプリと一緒に本番へ持ち込みます
- `image.tag` は `18` にします（注釈の拡張は PostgreSQL 18 用。18 以外では Pod の作成が拒否されます）。
  Railway の PostgreSQL（`SELECT version();`）が 18 以下なら、そのまま移せます（18 の `pg_dump` は古いサーバーを読める）
- メッセージ履歴は大きくなります。`storage.requestedSize` は Railway の DB の大きさ
  （`SELECT pg_size_pretty(pg_database_size(current_database()));`）の 2 倍程度にします。PVC は後から広げられますが、縮められません
- Bitnami のチャートは使いません（k8s-platform の `docs/GKE_SETUP_GUIDE.md` の 8.8）
- バックアップは dev・本番とも毎日自動で取られます（5432 のポートで DB と見分けるので、注釈の有無にかかわらず取られる）

## 2. BOT（Canine のプロジェクト）

| 項目           | 値                                                                                                                                                                 |
| :------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| プロジェクト名 | `robopolice`（Namespace も `robopolice`。本番は `prod-robopolice`）                                                                                                |
| リポジトリ     | `waxsd100/RoboPolice`、ブランチ `master`、ビルドは `Dockerfile`                                                                                                    |
| サービス       | YouTube の WebSub を使わないなら **Background service**（ポート無し）。使うなら **Web service・ポート 8080**（本番は `https://robopolice.wax100.io` で公開される） |
| 台数           | 1                                                                                                                                                                  |

環境変数は `.env.example` と README の表のとおりです。Railway との違いだけ挙げます。

| 変数                                      | dev                                                                  | 本番（Secret Manager に入れる値）                                                                                         |
| :---------------------------------------- | :------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| `BOT_TOKEN`                               | **テスト用の BOT のトークン**                                        | 今の Railway と同じ                                                                                                       |
| `PGHOST`                                  | `<postgres の Service>.robopolice-postgres.svc.cluster.local`        | `<postgres の Service>`（Namespace を付けない。PR 本文に出る）                                                            |
| `PGUSER` / `PGPASSWORD` / `PGDATABASE`    | `postgres` / アドオンの `superuserPassword` / `postgres`             | 同じ形（本番のアドオンのパスワード）                                                                                      |
| `REDIS_HOST`                              | `<redis の Service>.robopolice-redis.svc.cluster.local`              | `<redis の Service>`                                                                                                      |
| `REDIS_PASSWORD`                          | アドオンで付けたときだけ                                             | 同じ                                                                                                                      |
| `AES_KEY`                                 | 何でもよい                                                           | **今の Railway と同じ値**（変えると Redis の招待コードが読めない。移した DB に暗号化の残りがあれば migration も通らない） |
| `OWNER_GUILD_IDS`                         | テスト用サーバー                                                     | 今と同じ                                                                                                                  |
| `GCP_SECRETS` / `GCP_SERVICE_ACCOUNT_KEY` | 設定しない                                                           | 設定しない（GKE では External Secrets が Secret Manager から入れる）                                                      |
| `YOUTUBE_WEBSUB_URL`                      | 設定しない（dev は外から届かない）                                   | 使うなら `https://robopolice.wax100.io`                                                                                   |
| `PORT`                                    | 設定しない（既定 8080）                                              | 同じ                                                                                                                      |
| `HISTORY_BACKFILL` / `MESSAGE_EMBEDDINGS` | `false` を勧める（テストで Gemini と Discord の API を使い過ぎない） | 今と同じ                                                                                                                  |

DB の接続先を間違えて dev から本番の DB に書かないよう、dev と本番の DB は別のアドオンです（dev から `prod-*` へは
NetworkPolicy で届きません）。

起動したら Canine のログで `[DB]: Applied N migration(s)` と `Shard manager is booting up` を確認し、テスト用サーバーで
`/setup`・メンションなどを試します。gVisor の中で動かない場合は、k8s-platform の `docs/ARCHITECTURE.md` の 1 章の
`wax100.io/sandbox=false` を見てください。

### 2.1 `GeneLab/sokudan-ja-310m` サイドカー／別サービス（任意）

メンション時の事前ルーティング（イベント／フォーラム／雑談の分類、長文・推論依頼の直接 `deepModel` 振り分け、婉曲的な R18 依頼の検知）、プロンプトインジェクション・ソフト拒否（朝チュン）検知、および `replyPolish` の事前判定を高速・低コストで行う軽量日本語判断モデル [`GeneLab/sokudan-ja-310m`](https://huggingface.co/GeneLab/sokudan-ja-310m) を動かす場合は、リポジトリの `Dockerfile.sokudan` を使って別サービス（または同一 Pod 内サイドカー）として起動します。

- **ビルド**: `Dockerfile.sokudan`（ビルド時にモデルの重みを `/app/model` に同梱するため、起動時外部通信やアカウント登録は不要です）
- **ポート**: `8000`（ヘルスチェック: `GET /health`、推論エンドポイント: `POST /v1/systemone`）
- **リソース目安（CPU 推論）**: requests `cpu: 250m`, `memory: 1.5Gi` / limits `memory: 2Gi`
- **BOT 側の環境変数**: `SOKUDAN_URL=http://<sokudan の Service 名>:8000`（ローカルの `docker compose up -d` では `http://sokudan:8000` が自動設定されます）

## 3. 本番に昇格する

```bash
kubectl --context wax100-dev label ns robopolice wax100.io/single-replica=true   # 先にこれ。BOT を 1 台・Recreate で昇格させる
kubectl --context wax100-dev label ns robopolice wax100.io/promote=true
```

毎時 15 分に昇格ジョブが k8s-platform に PR を立てます。PR 本文で次を確認します。

- 「**1 台で動かします**（…）。dev の Namespace に `wax100.io/single-replica=true` が付いているため」と出ていること。
  `overlays/production/hpa.yaml` が**無い**こと（あれば、ラベルより前に昇格された。hpa.yaml と replicas を消すパッチを PR で外す）
- アドオン（`robopolice-postgres`・`robopolice-redis`）も一緒に昇格していること
- Secret Manager に登録する ID の一覧（下の 4 で使う）

PR に次のパッチを足してからマージします（Kyverno の既定 requests は 100m / 128Mi で、BOT には小さすぎるため）。

```yaml
# components/apps/robopolice/overlays/production/kustomization.yaml に追記
patches:
  - target:
      kind: Deployment
      name: <BOT の Deployment 名>
    patch: |-
      - op: add
        path: /spec/template/spec/containers/0/resources
        value:
          requests:
            cpu: 250m
            memory: 512Mi
```

マージすると Config Sync が `prod-robopolice` を作ります。**この時点では BOT の機密をまだ登録しません**
（登録しないかぎり BOT の Pod は起動しないので、Railway と二重にならない）。

## 4. 本番の DB の機密だけ先に登録する

PR 本文に出た ID のうち、**postgres・redis のアドオンの分だけ**を登録します。ID と形（値そのままか、
キーと値の JSON か）は PR 本文のとおりにします。

```bash
PROJECT=<k8s-platform の GCP プロジェクト>
printf '%s' '<本番の postgres の superuser パスワード>' |
  gcloud secrets versions add <PR 本文の ID> --project "$PROJECT" --data-file=-
```

（Secret が無ければ先に `gcloud secrets create <ID> --project "$PROJECT" --replication-policy=automatic`。）

```bash
kubectl --context wax100-prod -n prod-robopolice get pods   # postgres と redis が Running、BOT は CreateContainerConfigError のまま
```

## 5. Railway から切り替える

ここからは BOT が止まります（DB の大きさにより数分〜数十分）。

1. **Railway の BOT を止める。** Railway の BOT のサービスを Remove（または Settings の Replicas を 0）。
   Railway の Postgres は消さない
2. **Railway の DB を本番の DB へ流し込む。** Railway の Postgres の `DATABASE_PUBLIC_URL`（Variables タブ）を使います。
   本番の postgres の Pod の中で `pg_dump` を `pg_restore` に直接流すので、手元にもクラスタにもダンプのファイルは残りません

   ```bash
   POD=$(kubectl --context wax100-prod -n prod-robopolice get pod -o name | grep postgres | head -1)
   read -rs RAILWAY_URL   # DATABASE_PUBLIC_URL を貼る（画面にも履歴にも残らない）
   kubectl --context wax100-prod -n prod-robopolice exec -i "$POD" -c postgres -- \
     env RAILWAY_URL="$RAILWAY_URL" bash -c '
       set -o pipefail
       pg_dump --format=custom --no-owner --no-acl "$RAILWAY_URL" |
         pg_restore --no-owner --no-acl --exit-on-error -U postgres -d postgres'
   unset RAILWAY_URL
   ```

   コンテナ名が `postgres` でないときは `kubectl get pod … -o jsonpath='{.spec.containers[*].name}'` で確かめます。
   流し込み先は空の DB にします（やり直すときは `prod-robopolice` の postgres で
   `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` してから）

3. **件数を比べる。** Railway と本番で同じ数になること

   ```sql
   SELECT (SELECT count(*) FROM messages) AS messages, (SELECT count(*) FROM guilds) AS guilds,
          (SELECT max(version) FROM schema_migrations) AS last_migration;
   ```

4. **BOT の機密を登録する。** PR 本文に出た BOT の Secret の ID に、本番の環境変数を登録します。
   Canine の環境変数が 1 つの Secret（`envFrom`）なら、**キーと値の JSON オブジェクト**で登録します。
   本番用の `.env.prod`（2 の表の「本番」の値。`PGHOST`・`REDIS_HOST` は Namespace を付けない名前）から作る例:

   ```bash
   grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env.prod |
     jq -Rn '[inputs | capture("^(?<key>[^=]+)=(?<value>.*)$")] | from_entries' |
     gcloud secrets versions add <PR 本文の ID> --project "$PROJECT" --data-file=-
   ```

   今の値は Railway の Variables タブと、Secret Manager の `robopolice-*`
   （`gcloud secrets versions access latest --secret robopolice-bot-token` など）から取ります

5. **起動を確かめる。** External Secrets が 1 時間以内（すぐ反映したいときは
   `kubectl -n prod-robopolice annotate externalsecret --all force-sync=$(date +%s) --overwrite`）に Secret を作り、BOT が起動します

   ```bash
   kubectl --context wax100-prod -n prod-robopolice get pods
   kubectl --context wax100-prod -n prod-robopolice logs deploy/<BOT の Deployment 名> -f
   ```

   Railway で当たっていない migration があればそれだけが当たり（`[DB]: Applied N migration(s)`。無ければ出ない）、
   `Shard manager is booting up` が出て、本番のサーバーで
   ログが 1 回ずつ出ること（二重でないこと）を確かめます。WebSub を使うなら、`[WEBSUB]: Listening …` の後に
   YouTube の購読が更新されます

うまくいかないときは、本番の BOT の Secret の版を無効にして（`gcloud secrets versions disable`）止め、
Railway の BOT を戻します。Railway の DB は手を付けていないので、そのまま戻れます。

## 6. 片付け（数日動かして問題が無ければ）

- Railway の BOT・Postgres・Redis を消す（Postgres は消す前に念のため `pg_dump` を手元に取っておく）
- `infra/terraform` のサービスアカウントの鍵を消す（`gcloud iam service-accounts keys list/delete
--iam-account robopolice-runtime@…`）。GKE では使わない。Secret Manager の `robopolice-*` も、値を本番の ID に移したら
  `terraform destroy` で消してよい
- Privacy Policy（Wiki）に保存先（Railway）が書いてあれば、Google Cloud（東京リージョン）に直す。README の
  「Legal」のとおり、保存先が変わったら同じ変更で直す
- dev の Namespace は残しておく（以降の変更は dev を更新すると、追従 PR が自動で立つ）
