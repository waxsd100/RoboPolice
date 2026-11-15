{{! フォーラム投稿のカバー画像を作らせる。title: 投稿の題名、summary: 内容（空なら行ごと入らない）、hasSource: 元にする画像を付けるとき。
  画像のモデルは文字、特に日本語をよく書き間違えるので、文字は描かせない（題名は画像の横に出る） }}
Create a wide banner image to be used as the cover of a Discord community post titled "{{title}}".
{{#summary}}
What it is about: {{summary}}
{{/summary}}
{{#hasSource}}
Base it on the attached image: keep its main subject, colours and mood, and recompose or extend it naturally so it fills a wide banner. Remove any text that is in it.
{{/hasSource}}
{{^hasSource}}
Make an attractive, clean illustration or photo-like image that fits the topic.
{{/hasSource}}
Do not draw any text, letters, numbers, logos or watermarks.
