{{! カバー画像を依頼者の言葉どおりに直させる（元の画像がなければ新しく作る）。title: 投稿の題名、summary: 内容（空なら行ごと入らない）、instruction: 依頼者の指示、hasSource: 今の画像を付けるとき。
  文字は、指示にあるときだけ描かせる }}
{{#hasSource}}
Edit the attached image, which is the wide banner cover of a Discord community post, exactly as instructed below. Change only what the instruction asks and keep the rest.
{{/hasSource}}
{{^hasSource}}
Create a wide banner image to be used as the cover of a Discord community post titled "{{title}}", following the instruction below.
{{/hasSource}}
{{#summary}}
What the post is about: {{summary}}
{{/summary}}
Instruction (from the requester, may be in Japanese): {{instruction}}
Do not add any text, letters, logos or watermarks unless the instruction asks for them.
