# レビュー引き継ぎメモ

リポジトリ全体レビューと改善対応の作業ログ。途中で作業が止まっても、ここを読めば続きから再開できる。

- ブランチ: `ccr-e536bcff-va9k9e`
- 開始時点の master: `8475776`
- ベースライン（着手前）: `npm run lint` OK / `test:unit` 661 pass / `test:it` 84 pass / `check:secrets` OK

## 環境メモ

- ローカルの Postgres には pgvector が無いので `npm run test:db` は動かせない（PGHOST 無しだと skip）。DB テストは PR の CI で確認する
- `npm ci` の前に `git config --global url."https://github.com/".insteadOf ssh://git@github.com/` が必要（eris が git+ssh 指定）
- PR: https://github.com/waxsd100/RoboPolice/pull/194 （ドラフト）

## 進め方

1. 領域ごとに読む → 問題を見つけたら直す → テスト → コミット → push
2. 1 コミットごとにこのメモの「対応済み」「未着手」を更新する

## レビュー対象と状況

| 領域 | 状況 |
| --- | --- |
| ルート（index/primary/replica、Docker、CI） | 読了・問題なし |
| セキュリティ系（eval、urlFetcher、linkSafety、websub、aes、redact） | 読了・問題なし |
| コマンド基盤（commandhandler、slash、staffAccess） | 未着手 |
| DB（clients、interfaces、migrate、messageBatcher） | 未着手 |
| AI 系（aiGateway、mentionEvent、eventTools/Drafter、sokudan） | 未着手 |
| imagegen（Python） | 対応済み |
| infra（terraform） | 未着手 |

## 対応済み

- 依存の脆弱性対応（`npm audit --omit=dev` が 7 件 → 0 件）
  - `npm audit fix` で undici / ws / form-data / formidable / qs を更新（lock のみ）
  - sharp `^0.34.5` → `^0.35.5`（libvips 等の脆弱性。Discord から来た画像を処理するので影響あり）
  - uuid を依存から削除し、標準の `crypto.randomUUID()` に置換（v4 しか使っていなかった）
  - package-lock.json は元が CRLF なので CRLF のまま保っている
- 誤ってコミットされていた `imagegen/__pycache__/*.pyc` を削除し `.gitignore` に追加
- `.env.example` に、コードは読んでいるのに README にも `.env.example` にも載っていなかった設定 17 個を「Advanced tuning」として追記（既定値はコードから転記）
- `imagegen/server.py`
  - API キー比較を `hmac.compare_digest`（定数時間）に変更
  - 子ども判定（`check_prompt`）を GPU ロックの前に移動（拒否が生成待ちの後ろに並ばない）
  - img2img の壊れた base64／画像で 500 ではなく 400 を返す
  - ※ ローカルに PIL / torch が無いので `py_compile` のみ確認。実機での動作確認は未実施

## 見つけたが未対応（要判断・大きすぎる等）

（なし）
