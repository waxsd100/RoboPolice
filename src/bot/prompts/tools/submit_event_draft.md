{{! submit_event_draft: イベントの下書きの提出（eventDrafter.js）。最初の段落がツールの説明、「## 引数名」の節が各引数の説明。maxImages: 画像候補の上限数 }}
イベントの登録を頼まれたとき、調べ終わったら必ず最後に1回だけ呼ぶ。登録するイベントの下書き、または作れない理由を提出する。

## found
イベントとして登録できる情報（少なくとも名前と開始日時）が読み取れたか

## reason
found が false のとき、何が足りないかを利用者向けに日本語で一文

## name
イベント名（100文字以内）

## description
イベントの説明（1000文字以内、日本語）。参照元のリンクがあれば末尾に含める

## start
開始日時。タイムゾーンオフセット付き ISO 8601（例: 2026-11-03T19:00:00+09:00）

## end
終了日時。同じ形式。分からなければ空文字

## location_type
Discord のボイス/ステージチャンネルで行うなら voice/stage、それ以外は external

## location
location_type が external のときの場所（会場名・住所・URL など、100文字以内）

## image_urls
カバー画像の候補 URL（良い順、最大{{maxImages}}つ）。参照したページの og:image / twitter:image、メッセージの添付画像・埋め込み画像から、告知画像や会場写真など内容に合うものを選ぶ。ロゴやアイコンなど小さい画像、内容と関係ない画像は選ばない。なければ空

## channel_id
location_type が voice/stage のときのチャンネル ID（list_channels で確認したもの）
