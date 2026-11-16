{{! 会話で頼まれた画像を作らせる（generate_image）。description: モデルが書いた、作る画像の説明。hasSource: 元にする画像を付けるとき }}
{{#hasSource}}
Using the attached image(s) as the base, make the picture described below. Keep what the description does not ask to change.
{{/hasSource}}
{{^hasSource}}
Make the picture described below.
{{/hasSource}}
Description (may be in Japanese): {{description}}
Do not add any text, letters, logos or watermarks unless the description asks for them.
