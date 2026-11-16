{{! submit_forum_post_draft: フォーラム投稿の下書きの提出（forumPost.js）。最初の段落がツールの説明、「## 引数名」の節が各引数の説明。maxTitle: 題名の上限文字数、maxContent: 本文の上限文字数、maxTags: タグの上限数、maxImages: 画像候補の上限数 }}
フォーラムへの投稿を頼まれたとき、調べ終わったら必ず最後に1回だけ呼ぶ。投稿の下書き、または作れない理由を提出する。

## found
投稿先と、投稿の題名・本文を決められたか

## reason
found が false のとき、何が足りないかを利用者向けに日本語で一文

## channel_id
投稿先のフォーラムの ID（list_forums で確認したもの）

## title
投稿の題名（{{maxTitle}}文字以内）

## content
投稿の本文（{{maxContent}}文字以内、Discord の Markdown 可）。参照元のリンクがあれば末尾に含める

## tags
付けるタグの名前（list_forums に出たものから最大{{maxTags}}個）

## image_urls
投稿に添える画像の候補 URL（良い順、最大{{maxImages}}つ）。参照したページの og:image / twitter:image、メッセージの添付画像・埋め込み画像から内容に合うものを選ぶ。ロゴやアイコンなど小さい画像は選ばない。なければ空
