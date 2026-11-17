# レビュー引き継ぎメモ

リポジトリ全体レビューと改善対応の作業ログ。途中で作業が止まっても、ここを読めば続きから再開できる。

- ブランチ: `ccr-e536bcff-va9k9e`
- 開始時点の master: `8475776`
- ベースライン（着手前）: `npm run lint` OK / `test:unit` 661 pass / `test:it` 84 pass / `check:secrets` OK

## 進め方

1. 領域ごとに読む → 問題を見つけたら直す → テスト → コミット → push
2. 1 コミットごとにこのメモの「対応済み」「未着手」を更新する

## レビュー対象と状況

| 領域 | 状況 |
| --- | --- |
| ルート（index/primary/replica、Docker、CI） | 未着手 |
| セキュリティ系（eval、urlFetcher、linkSafety、websub、aes、redact） | 未着手 |
| コマンド基盤（commandhandler、slash、staffAccess） | 未着手 |
| DB（clients、interfaces、migrate、messageBatcher） | 未着手 |
| AI 系（aiGateway、mentionEvent、eventTools/Drafter、sokudan） | 未着手 |
| imagegen（Python） | 未着手 |
| infra（terraform） | 未着手 |

## 対応済み

- 依存の脆弱性対応（`npm audit --omit=dev` が 7 件 → 0 件）
  - `npm audit fix` で undici / ws / form-data / formidable / qs を更新（lock のみ）
  - sharp `^0.34.5` → `^0.35.5`（libvips 等の脆弱性。Discord から来た画像を処理するので影響あり）
  - uuid を依存から削除し、標準の `crypto.randomUUID()` に置換（v4 しか使っていなかった）
  - package-lock.json は元が CRLF なので CRLF のまま保っている
- 誤ってコミットされていた `imagegen/__pycache__/*.pyc` を削除し `.gitignore` に追加

## 見つけたが未対応（要判断・大きすぎる等）

（なし）
