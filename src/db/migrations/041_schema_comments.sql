-- Schema comments (COMMENT ON TYPE / TABLE / COLUMN) for every custom enum type, table, and column
-- in the database, so database inspection tools (psql \d+, pgAdmin, DBeaver, Supabase, etc.)
-- display clear descriptions across the entire schema.

-- Enum types
COMMENT ON TYPE reply_model IS 'AI処理やメンション返信で使用可能なGeminiモデル名';
COMMENT ON TYPE thinking_level IS 'Gemini 3系モデルの思考レベル（minimal / low / medium / high）';
COMMENT ON TYPE reply_length IS 'メンション返信の長さ設定（long / normal / short）';
COMMENT ON TYPE ai_task IS 'サーバーごとにモデル・思考レベル・推論ティアを設定可能なAI処理用途（reply / rules / blurb / light / extract / summary）';
COMMENT ON TYPE service_tier IS 'Gemini APIの推論ティア（standard: 通常高速 / flex: 半額・バックグラウンド向け）';

-- schema_migrations
COMMENT ON TABLE schema_migrations IS '適用済みのデータベースマイグレーション履歴';
COMMENT ON COLUMN schema_migrations.version IS 'マイグレーション番号（ファイル名先頭の連番）';
COMMENT ON COLUMN schema_migrations.name IS 'マイグレーション名';
COMMENT ON COLUMN schema_migrations.applied_at IS 'マイグレーションが適用された日時';

-- embedding_models
COMMENT ON TABLE embedding_models IS 'ベクトル埋め込み（Embedding）の生成に使用されたモデル一覧';
COMMENT ON COLUMN embedding_models.id IS '埋め込みモデルの内部ID';
COMMENT ON COLUMN embedding_models.name IS '埋め込みモデル名（例: gemini-embedding-2-preview）';

-- guilds
COMMENT ON TABLE guilds IS 'BOTが参加しているDiscordサーバー（ギルド）の基本情報とサーバー単位の設定';
COMMENT ON COLUMN guilds.id IS 'Discordサーバー（ギルド）ID';
COMMENT ON COLUMN guilds.owner_id IS 'サーバーオーナーのDiscordユーザーID';
COMMENT ON COLUMN guilds.log_bots IS 'BOTによるイベントやメッセージもログ出力対象にするかどうか';
COMMENT ON COLUMN guilds.name IS 'サーバー名';
COMMENT ON COLUMN guilds.icon_url IS 'サーバーアイコンの画像URL';
COMMENT ON COLUMN guilds.member_count IS 'サーバーのメンバー数';
COMMENT ON COLUMN guilds.joined_at IS 'BOTがこのサーバーに参加した日時';
COMMENT ON COLUMN guilds.details_updated_at IS 'サーバー名・アイコン・メンバー数を最終更新した日時';
COMMENT ON COLUMN guilds.youtube_live_events IS 'フォロー中のYouTubeチャンネルの配信予定・動画投稿をDiscordスケジュールイベントとして自動登録するかどうか';
COMMENT ON COLUMN guilds.reply_length IS 'メンション返信の長さ設定（long / normal / short、NULLは既定値）';
COMMENT ON COLUMN guilds.streamer_persona IS 'メンション返信で配信者本人のペルソナとして振る舞うかどうか（falseの場合はBOTとして応答）';
COMMENT ON COLUMN guilds.debug_footer IS 'メンション返信の末尾に使用モデル・トークン数などのデバッグフッターを表示するかどうか';
COMMENT ON COLUMN guilds.token_limit_5h IS '1ユーザーあたりの5時間トークン上限（NULLは既定値、0は無制限）';
COMMENT ON COLUMN guilds.token_limit_week IS '1ユーザーあたりの週間トークン上限（NULLは既定値、0は無制限）';
COMMENT ON COLUMN guilds.token_flex_at IS 'トークン上限の何%に達したらFlex推論へ切り替えるかの閾値（0〜100、NULLは既定値）';
COMMENT ON COLUMN guilds.token_unlimited IS 'サーバー全体のメンショントークン制限および日次回数制限を無制限にするかどうか';
COMMENT ON COLUMN guilds.reply_model IS 'メンション返信（reply用途）で使用するカスタムGeminiモデル（NULLは既定値）';
COMMENT ON COLUMN guilds.reply_thinking IS 'メンション返信（reply用途）で使用するカスタム思考レベル（NULLは既定値）';
COMMENT ON COLUMN guilds.assistant_rules IS 'モデレーターが設定したメンションアシスタント向けの追加ルール（/assistantrules、最大2000文字）';

-- guild_event_logs
COMMENT ON TABLE guild_event_logs IS 'サーバーごとのDiscordイベント種別とログ出力先チャンネルの対応';
COMMENT ON COLUMN guild_event_logs.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN guild_event_logs.event IS 'ログ対象のDiscordイベント名（例: messageDelete, messageUpdate）';
COMMENT ON COLUMN guild_event_logs.channel_id IS 'ログ出力先のDiscordチャンネルID';

-- guild_ignored_channels
COMMENT ON TABLE guild_ignored_channels IS 'イベントログの記録対象から除外（無視）するサーバー内のチャンネル一覧';
COMMENT ON COLUMN guild_ignored_channels.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN guild_ignored_channels.channel_id IS 'ログ記録を無視するDiscordチャンネルID';

-- guild_disabled_events
COMMENT ON TABLE guild_disabled_events IS 'サーバーごとにログ出力を無効化しているDiscordイベント種別一覧';
COMMENT ON COLUMN guild_disabled_events.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN guild_disabled_events.event IS '無効化されているDiscordイベント名';

-- guild_ai_models
COMMENT ON TABLE guild_ai_models IS 'サーバーおよびAI処理用途（6種類）ごとのカスタムモデル・思考レベル・推論ティア設定';
COMMENT ON COLUMN guild_ai_models.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN guild_ai_models.task IS 'AI処理の用途区分（reply / rules / blurb / light / extract / summary）';
COMMENT ON COLUMN guild_ai_models.model IS 'この用途で使用するGeminiモデル（NULLは用途別の既定モデル）';
COMMENT ON COLUMN guild_ai_models.thinking IS 'この用途で使用する思考レベル（NULLは用途別の既定思考レベル）';
COMMENT ON COLUMN guild_ai_models.tier IS 'この用途で使用する推論ティア（standard / flex、NULLは用途別の既定ティア）';

-- guild_emojis
COMMENT ON TABLE guild_emojis IS 'サーバーのカスタム絵文字と、AIが生成した見た目・使い所の説明文およびベクトル埋め込み';
COMMENT ON COLUMN guild_emojis.emoji_id IS 'Discordカスタム絵文字ID';
COMMENT ON COLUMN guild_emojis.guild_id IS '絵文字が属するDiscordサーバーID';
COMMENT ON COLUMN guild_emojis.name IS 'カスタム絵文字の名前';
COMMENT ON COLUMN guild_emojis.animated IS 'アニメーション絵文字かどうか';
COMMENT ON COLUMN guild_emojis.described_name IS '説明文を生成した時点の絵文字名（リネーム検知用）';
COMMENT ON COLUMN guild_emojis.description IS 'AIが画像と名前から生成した絵文字の見た目・使い所の説明文';
COMMENT ON COLUMN guild_emojis.embedding IS '説明文の512次元ベクトル埋め込み（意味検索用）';
COMMENT ON COLUMN guild_emojis.model_id IS '埋め込み生成に使用したモデルID（embedding_models.id）';
COMMENT ON COLUMN guild_emojis.updated_at IS '絵文字情報または説明文の最終更新日時';

-- guild_lore_chunks
COMMENT ON TABLE guild_lore_chunks IS 'サーバー内の公開チャンネルから週単位で内輪ネタ・用語・出来事を抽出した処理単位（チャンク）';
COMMENT ON COLUMN guild_lore_chunks.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN guild_lore_chunks.channel_id IS '抽出元のDiscordチャンネルID';
COMMENT ON COLUMN guild_lore_chunks.week IS '対象週の月曜日（日本時間）の日付';
COMMENT ON COLUMN guild_lore_chunks.text_hash IS 'その週のメッセージ群のハッシュ値（編集・削除による再抽出判定用）';
COMMENT ON COLUMN guild_lore_chunks.extracted_at IS 'AIによる知識抽出を実行した日時';

-- guild_lore_facts
COMMENT ON TABLE guild_lore_facts IS 'サーバーの週次会話チャンクから抽出された内輪ネタ・用語・出来事・話題の知識とベクトル埋め込み';
COMMENT ON COLUMN guild_lore_facts.id IS 'サーバー知識ファクトの一意ID';
COMMENT ON COLUMN guild_lore_facts.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN guild_lore_facts.channel_id IS '抽出元のDiscordチャンネルID';
COMMENT ON COLUMN guild_lore_facts.week IS '対象週の月曜日（日本時間）の日付';
COMMENT ON COLUMN guild_lore_facts.kind IS '知識の種類（joke: 内輪ネタ / term: 用語 / event: 出来事 / topic: 話題）';
COMMENT ON COLUMN guild_lore_facts.name IS '抽出されたネタ・用語・話題の見出し名';
COMMENT ON COLUMN guild_lore_facts.content IS '抽出された知識の具体的な説明内容';
COMMENT ON COLUMN guild_lore_facts.embedding IS '知識内容の512次元ベクトル埋め込み';
COMMENT ON COLUMN guild_lore_facts.model_id IS '埋め込み生成に使用したモデルID（embedding_models.id）';

-- guild_lore_style
COMMENT ON TABLE guild_lore_style IS 'サーバー内の会話から抽出したコミュニティの話し方・雰囲気の要約';
COMMENT ON COLUMN guild_lore_style.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN guild_lore_style.style IS 'AIが要約したサーバー内の話し方・雰囲気の特徴';
COMMENT ON COLUMN guild_lore_style.source_hash IS '要約元の知識群のハッシュ値（再生成判定用）';
COMMENT ON COLUMN guild_lore_style.updated_at IS 'スタイル要約の最終更新日時';

-- messages
COMMENT ON TABLE messages IS 'ログ記録および過去会話検索のために保存されたDiscordメッセージとベクトル埋め込み';
COMMENT ON COLUMN messages.id IS 'DiscordメッセージID';
COMMENT ON COLUMN messages.author_id IS '投稿者のDiscordユーザーID';
COMMENT ON COLUMN messages.content IS 'メッセージ本文';
COMMENT ON COLUMN messages.ts IS 'メッセージの投稿日時';
COMMENT ON COLUMN messages.channel_id IS '投稿先のDiscordチャンネルID';
COMMENT ON COLUMN messages.guild_id IS '投稿先のDiscordサーバーID';
COMMENT ON COLUMN messages.embedding IS 'メッセージ内容の512次元ベクトル埋め込み（意味検索用）';
COMMENT ON COLUMN messages.embedding_model_id IS '埋め込み生成（または埋め込み不要判定）を行ったモデルID（NULLは未処理）';

-- message_attachments
COMMENT ON TABLE message_attachments IS '保存されたDiscordメッセージに添付されていた画像等のURL一覧';
COMMENT ON COLUMN message_attachments.message_id IS '添付元のDiscordメッセージID';
COMMENT ON COLUMN message_attachments.position IS 'メッセージ内での添付ファイルの並び順（0始まり）';
COMMENT ON COLUMN message_attachments.url IS '添付ファイルのURL';

-- message_backfill
COMMENT ON TABLE message_backfill IS 'サーバーのチャンネル過去ログ遡及取得（historyBackfill.js）の進行状況';
COMMENT ON COLUMN message_backfill.channel_id IS '対象のDiscordチャンネルID';
COMMENT ON COLUMN message_backfill.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN message_backfill.before_id IS 'これまでに遡って読み込んだ最も古いメッセージID（次回取得の起点）';
COMMENT ON COLUMN message_backfill.read_count IS 'これまでに遡及取得したメッセージ件数';
COMMENT ON COLUMN message_backfill.done IS '現在の制限設定での遡及取得が完了しているかどうか';
COMMENT ON COLUMN message_backfill.reached_start IS 'チャンネルの最初（最古）のメッセージまで到達したかどうか';
COMMENT ON COLUMN message_backfill.limit_start IS '完了時点の取得開始日時制限（制限緩和時の再開判定用）';
COMMENT ON COLUMN message_backfill.limit_max IS '完了時点の最大取得件数制限（制限緩和時の再開判定用）';
COMMENT ON COLUMN message_backfill.updated_at IS '進行状況の最終更新日時';

-- embedding_batches
COMMENT ON TABLE embedding_batches IS '過去メッセージのベクトル埋め込みを一括生成するGemini Batch APIジョブの実行状態';
COMMENT ON COLUMN embedding_batches.name IS 'Gemini Batch APIのジョブ名（batches/...）';
COMMENT ON COLUMN embedding_batches.created_at IS 'バッチジョブを作成した日時';
COMMENT ON COLUMN embedding_batches.model_id IS '埋め込み生成に使用するモデルID（embedding_models.id）';
COMMENT ON COLUMN embedding_batches.state IS '最終確認時点のGeminiバッチジョブ状態（BATCH_STATE_RUNNINGなど）';
COMMENT ON COLUMN embedding_batches.checked_at IS 'バッチジョブの状態を最終確認した日時';
COMMENT ON COLUMN embedding_batches.last_error IS '状態確認時に発生した直近のエラーメッセージ';

-- embedding_batch_messages
COMMENT ON TABLE embedding_batch_messages IS '実行中の埋め込みバッチジョブに含まれている対象メッセージ一覧';
COMMENT ON COLUMN embedding_batch_messages.message_id IS 'バッチ処理中のDiscordメッセージID';
COMMENT ON COLUMN embedding_batch_messages.batch_name IS '所属するGemini Batch APIジョブ名（embedding_batches.name）';

-- youtube_channels
COMMENT ON TABLE youtube_channels IS 'BOTがフォローして動画・配信を同期するYouTubeチャンネル一覧';
COMMENT ON COLUMN youtube_channels.channel_id IS 'YouTubeチャンネルID（UC...）';
COMMENT ON COLUMN youtube_channels.title IS 'YouTubeチャンネル名';
COMMENT ON COLUMN youtube_channels.description IS 'YouTubeチャンネルの概要欄テキスト';
COMMENT ON COLUMN youtube_channels.handle IS 'YouTubeハンドル名（@...）';
COMMENT ON COLUMN youtube_channels.url IS 'YouTubeチャンネルのURL';
COMMENT ON COLUMN youtube_channels.synced_at IS 'チャンネル情報および動画一覧を最終同期した日時';
COMMENT ON COLUMN youtube_channels.backfill_token IS '過去動画の一覧取得を再開するためのYouTube APIページトークン';
COMMENT ON COLUMN youtube_channels.websub_expires_at IS 'YouTubeプッシュ通知（WebSub）購読の有効期限日時';
COMMENT ON COLUMN youtube_channels.channel_ref IS '環境変数YOUTUBE_CHANNELSで指定されたチャンネル参照文字列';
COMMENT ON COLUMN youtube_channels.position IS '設定リスト内でのチャンネルの並び順（0始まり）';

-- youtube_videos
COMMENT ON TABLE youtube_videos IS 'フォロー中のYouTubeチャンネルの動画・ライブ配信メタデータとベクトル埋め込み';
COMMENT ON COLUMN youtube_videos.video_id IS 'YouTube動画ID（11文字）';
COMMENT ON COLUMN youtube_videos.channel_id IS '投稿元のYouTubeチャンネルID';
COMMENT ON COLUMN youtube_videos.title IS '動画・配信のタイトル';
COMMENT ON COLUMN youtube_videos.description IS '動画・配信の概要欄テキスト';
COMMENT ON COLUMN youtube_videos.published_at IS '動画の公開日時';
COMMENT ON COLUMN youtube_videos.live_status IS 'ライブ配信の状態（none / upcoming / live）';
COMMENT ON COLUMN youtube_videos.scheduled_start IS 'ライブ配信またはプレミア公開の開始予定日時';
COMMENT ON COLUMN youtube_videos.duration IS '動画の長さ（ISO 8601期間形式、例: PT1H23M45S）';
COMMENT ON COLUMN youtube_videos.stream_ended_at IS 'ライブ配信が終了したことを検知した日時（アーカイブ自動要約の起点）';
COMMENT ON COLUMN youtube_videos.archive_attempts IS '終了した配信のアーカイブ要約を試行した回数';
COMMENT ON COLUMN youtube_videos.archive_tried_at IS 'アーカイブ要約を最後に試行した日時';
COMMENT ON COLUMN youtube_videos.embedding IS 'タイトル・概要欄の512次元ベクトル埋め込み（動画検索用）';
COMMENT ON COLUMN youtube_videos.embedding_hash IS '埋め込み生成時の元テキストとモデルのハッシュ値（更新検知用）';
COMMENT ON COLUMN youtube_videos.embedding_model_id IS '埋め込み生成に使用したモデルID（embedding_models.id）';

-- youtube_summaries
COMMENT ON TABLE youtube_summaries IS 'Geminiによって生成されたYouTube動画・配信アーカイブの内容要約（全サーバー共有）';
COMMENT ON COLUMN youtube_summaries.video_id IS 'YouTube動画ID';
COMMENT ON COLUMN youtube_summaries.summary IS 'AIが生成した動画・配信の要約テキスト';
COMMENT ON COLUMN youtube_summaries.created_at IS '要約を生成した日時';

-- guild_youtube_summaries
COMMENT ON TABLE guild_youtube_summaries IS '各Discordサーバーがリクエストまたは自動生成したYouTube動画要約の紐付け';
COMMENT ON COLUMN guild_youtube_summaries.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN guild_youtube_summaries.video_id IS '要約対象のYouTube動画ID';
COMMENT ON COLUMN guild_youtube_summaries.created_at IS 'そのサーバーで要約が作成・紐付けられた日時';

-- youtube_live_events
COMMENT ON TABLE youtube_live_events IS 'YouTubeの配信予定や新規動画投稿から各サーバーに自動作成されたDiscordスケジュールイベント';
COMMENT ON COLUMN youtube_live_events.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN youtube_live_events.video_id IS '対応するYouTube動画ID';
COMMENT ON COLUMN youtube_live_events.event_id IS '作成されたDiscordスケジュールイベントID';
COMMENT ON COLUMN youtube_live_events.status IS 'イベントの進行状態（scheduled / active / completed / canceled / gone）';
COMMENT ON COLUMN youtube_live_events.scheduled_start IS 'イベントに設定された開始予定日時';
COMMENT ON COLUMN youtube_live_events.scheduled_end IS 'イベントに設定された終了予定日時';
COMMENT ON COLUMN youtube_live_events.kind IS 'イベントの種別（stream: ライブ配信 / upload: 動画投稿）';

-- youtube_summary_batches
COMMENT ON TABLE youtube_summary_batches IS '/youtube summarize で投入されたYouTube動画要約のGemini Batch APIジョブ管理';
COMMENT ON COLUMN youtube_summary_batches.name IS 'Gemini Batch APIのジョブ名（batches/...）';
COMMENT ON COLUMN youtube_summary_batches.guild_id IS 'リクエスト元のDiscordサーバーID';
COMMENT ON COLUMN youtube_summary_batches.channel_id IS '完了通知を送信するDiscordチャンネルID';
COMMENT ON COLUMN youtube_summary_batches.requester_id IS 'コマンドを実行したDiscordユーザーID';
COMMENT ON COLUMN youtube_summary_batches.model IS '要約生成に使用するGeminiモデル名';
COMMENT ON COLUMN youtube_summary_batches.created_at IS 'バッチジョブを作成した日時';
COMMENT ON COLUMN youtube_summary_batches.state IS '最終確認時点のGeminiバッチジョブ状態';
COMMENT ON COLUMN youtube_summary_batches.checked_at IS 'バッチジョブの状態を最終確認した日時';
COMMENT ON COLUMN youtube_summary_batches.last_error IS '状態確認時に発生した直近のエラーメッセージ';

-- youtube_summary_batch_videos
COMMENT ON TABLE youtube_summary_batch_videos IS 'YouTube要約バッチジョブに含まれる対象動画IDと並び順';
COMMENT ON COLUMN youtube_summary_batch_videos.batch_name IS '所属する要約バッチジョブ名（youtube_summary_batches.name）';
COMMENT ON COLUMN youtube_summary_batch_videos.position IS 'バッチ結果レポート内での動画の並び順（0始まり）';
COMMENT ON COLUMN youtube_summary_batch_videos.video_id IS '要約対象のYouTube動画ID';

-- knowledge_pages
COMMENT ON TABLE knowledge_pages IS 'Wiki・X・Discord発言・Web検索から収集された知識ページのメタデータ';
COMMENT ON COLUMN knowledge_pages.source IS '知識ソースの種別（wiki / x / discord / web）';
COMMENT ON COLUMN knowledge_pages.url IS '知識ページのURL（または月別・トピック別の識別URL）';
COMMENT ON COLUMN knowledge_pages.title IS 'ページのタイトル';
COMMENT ON COLUMN knowledge_pages.fetched_at IS 'ページを最終取得・更新した日時';

-- knowledge_sections
COMMENT ON TABLE knowledge_sections IS '知識ページを見出し単位に分割したセクション本文とベクトル埋め込み';
COMMENT ON COLUMN knowledge_sections.source IS '知識ソースの種別（wiki / x / discord / web）';
COMMENT ON COLUMN knowledge_sections.url IS '所属する知識ページのURL';
COMMENT ON COLUMN knowledge_sections.position IS 'ページ内でのセクションの並び順（0始まり）';
COMMENT ON COLUMN knowledge_sections.heading IS 'セクションの見出し名';
COMMENT ON COLUMN knowledge_sections.text IS 'セクションの本文テキスト';
COMMENT ON COLUMN knowledge_sections.text_hash IS '本文テキストのハッシュ値（再埋め込み判定用）';
COMMENT ON COLUMN knowledge_sections.embedding IS 'セクション本文の512次元ベクトル埋め込み';
COMMENT ON COLUMN knowledge_sections.model_id IS '埋め込み生成に使用したモデルID（embedding_models.id）';
COMMENT ON COLUMN knowledge_sections.facts_hash IS 'ファクト抽出完了時点の本文ハッシュ値（再抽出判定用）';

-- knowledge_section_images
COMMENT ON TABLE knowledge_section_images IS '知識セクション内に含まれる画像URL一覧';
COMMENT ON COLUMN knowledge_section_images.source IS '知識ソースの種別（wiki / x / discord / web）';
COMMENT ON COLUMN knowledge_section_images.url IS '所属する知識ページのURL';
COMMENT ON COLUMN knowledge_section_images.position IS '所属するセクションの並び順';
COMMENT ON COLUMN knowledge_section_images.image_position IS 'セクション内での画像の並び順（0始まり）';
COMMENT ON COLUMN knowledge_section_images.image_url IS '画像のURL';

-- knowledge_facts
COMMENT ON TABLE knowledge_facts IS '知識セクションからAIが抽出した人物・名言・用語の構造化ファクトとベクトル埋め込み';
COMMENT ON COLUMN knowledge_facts.id IS '知識ファクトの一意ID';
COMMENT ON COLUMN knowledge_facts.source IS '知識ソースの種別（wiki / x / discord / web）';
COMMENT ON COLUMN knowledge_facts.url IS '抽出元ページのURL';
COMMENT ON COLUMN knowledge_facts.position IS '抽出元セクションの並び順';
COMMENT ON COLUMN knowledge_facts.kind IS 'ファクトの種別（character: 人物・キャラ / quote: 語録・名言 / term: 用語・ネタ）';
COMMENT ON COLUMN knowledge_facts.name IS '人物・語録・用語の名称';
COMMENT ON COLUMN knowledge_facts.content IS '抽出された解説・エピソードの内容';
COMMENT ON COLUMN knowledge_facts.embedding IS 'ファクト内容の512次元ベクトル埋め込み';
COMMENT ON COLUMN knowledge_facts.model_id IS '埋め込み生成に使用したモデルID（embedding_models.id）';

-- knowledge_fact_aliases
COMMENT ON TABLE knowledge_fact_aliases IS '抽出された知識ファクト（人物・用語など）の別名・表記ゆれ一覧';
COMMENT ON COLUMN knowledge_fact_aliases.fact_id IS '対象の知識ファクトID（knowledge_facts.id）';
COMMENT ON COLUMN knowledge_fact_aliases.alias_position IS 'ファクト内での別名の並び順（0始まり）';
COMMENT ON COLUMN knowledge_fact_aliases.alias IS '別名・愛称・表記ゆれの文字列';

-- x_posts
COMMENT ON TABLE x_posts IS 'フォロー対象のX（旧Twitter）アカウントから取得したポスト（ツイート）本文';
COMMENT ON COLUMN x_posts.id IS 'Xのポスト（ステータス）ID';
COMMENT ON COLUMN x_posts.account IS '投稿元のXアカウント名（スクリーンネーム）';
COMMENT ON COLUMN x_posts.url IS 'ポストの固定リンクURL';
COMMENT ON COLUMN x_posts.text IS 'ポストの本文テキスト';
COMMENT ON COLUMN x_posts.created_at IS 'ポストの投稿日時';
COMMENT ON COLUMN x_posts.reply_to IS '返信先アカウントまたは返信先ポストの識別子（通常の投稿はNULL）';

-- x_post_media
COMMENT ON TABLE x_post_media IS 'Xのポストに添付されている画像・メディアのURL一覧';
COMMENT ON COLUMN x_post_media.post_id IS '添付元のXポストID（x_posts.id）';
COMMENT ON COLUMN x_post_media.position IS 'ポスト内でのメディアの並び順（0始まり）';
COMMENT ON COLUMN x_post_media.url IS 'メディア画像のURL';

-- discord_channels
COMMENT ON TABLE discord_channels IS '配信者のDiscord発言知識（discord_posts）が投稿されたチャンネルの情報';
COMMENT ON COLUMN discord_channels.id IS 'DiscordチャンネルID';
COMMENT ON COLUMN discord_channels.guild_id IS 'チャンネルが属するDiscordサーバーID';
COMMENT ON COLUMN discord_channels.name IS 'Discordチャンネル名';

-- discord_users
COMMENT ON TABLE discord_users IS '配信者のDiscord発言知識（discord_posts）の対象ユーザー情報';
COMMENT ON COLUMN discord_users.id IS 'DiscordユーザーID';
COMMENT ON COLUMN discord_users.name IS 'Discord上の表示名・ユーザー名';

-- discord_posts
COMMENT ON TABLE discord_posts IS '知識ベース構築対象ユーザー（配信者など）のDiscord発言履歴';
COMMENT ON COLUMN discord_posts.id IS 'DiscordメッセージID';
COMMENT ON COLUMN discord_posts.channel_id IS '投稿されたDiscordチャンネルID（discord_channels.id）';
COMMENT ON COLUMN discord_posts.author_id IS '投稿者のDiscordユーザーID（discord_users.id）';
COMMENT ON COLUMN discord_posts.content IS '発言の本文テキスト';
COMMENT ON COLUMN discord_posts.created_at IS '発言の投稿日時';

-- discord_backfill
COMMENT ON TABLE discord_backfill IS '配信者のDiscord発言収集（discordKnowledge.js）におけるチャンネルごとの過去ログ走査進捗';
COMMENT ON COLUMN discord_backfill.channel_id IS '走査対象のDiscordチャンネルID';
COMMENT ON COLUMN discord_backfill.guild_id IS 'DiscordサーバーID';
COMMENT ON COLUMN discord_backfill.before_id IS 'これまでに走査した最も古いメッセージID';
COMMENT ON COLUMN discord_backfill.done IS 'チャンネル先頭までの走査が完了したかどうか';
COMMENT ON COLUMN discord_backfill.updated_at IS '走査進捗の最終更新日時';

-- twitch_channels
COMMENT ON TABLE twitch_channels IS 'BOTがフォローして配信アーカイブ（VOD）を同期するTwitchチャンネル一覧';
COMMENT ON COLUMN twitch_channels.user_id IS 'TwitchユーザーID';
COMMENT ON COLUMN twitch_channels.login IS 'Twitchのログイン名（小文字のチャンネル識別子）';
COMMENT ON COLUMN twitch_channels.display_name IS 'Twitchの表示名';
COMMENT ON COLUMN twitch_channels.description IS 'Twitchチャンネルの自己紹介・概要文';
COMMENT ON COLUMN twitch_channels.synced_at IS 'チャンネル情報およびアーカイブ一覧を最終同期した日時';

-- twitch_videos
COMMENT ON TABLE twitch_videos IS 'フォロー中のTwitchチャンネルの配信アーカイブ（VOD）・ダイジェスト動画一覧';
COMMENT ON COLUMN twitch_videos.video_id IS 'Twitch動画ID';
COMMENT ON COLUMN twitch_videos.user_id IS '投稿元のTwitchユーザーID（twitch_channels.user_id）';
COMMENT ON COLUMN twitch_videos.title IS '配信アーカイブのタイトル';
COMMENT ON COLUMN twitch_videos.description IS '配信アーカイブの説明文';
COMMENT ON COLUMN twitch_videos.url IS 'Twitch動画ページのURL';
COMMENT ON COLUMN twitch_videos.published_at IS '配信または動画の公開日時';
COMMENT ON COLUMN twitch_videos.duration IS '動画の長さ（例: 2h15m30s）';
COMMENT ON COLUMN twitch_videos.view_count IS '再生回数';

-- steam_profiles
COMMENT ON TABLE steam_profiles IS 'BOTがフォローして所持ゲーム・プレイ時間・レビューを同期するSteamプロフィール一覧';
COMMENT ON COLUMN steam_profiles.steam_id IS '64ビットSteam ID（17桁の数字文字列）';
COMMENT ON COLUMN steam_profiles.account_ref IS '環境変数STEAM_ACCOUNTSで指定されたアカウント参照文字列';
COMMENT ON COLUMN steam_profiles.persona_name IS 'Steam上のプロフィール表示名';
COMMENT ON COLUMN steam_profiles.custom_url IS 'SteamカスタムURL識別子（/id/<custom_url>）';
COMMENT ON COLUMN steam_profiles.summary IS 'Steamプロフィールの自己紹介文';
COMMENT ON COLUMN steam_profiles.member_since IS 'Steamアカウント開設日';
COMMENT ON COLUMN steam_profiles.level IS 'Steamプロフィールレベル';
COMMENT ON COLUMN steam_profiles.game_count IS '所持ゲーム総数';
COMMENT ON COLUMN steam_profiles.wishlist_count IS 'ウィッシュリスト登録ゲーム数';
COMMENT ON COLUMN steam_profiles.synced_at IS 'Steamプロフィールおよびゲーム情報を最終同期した日時';

-- steam_apps
COMMENT ON TABLE steam_apps IS 'SteamのApp IDと日本語・英語ゲームタイトルのキャッシュ辞書';
COMMENT ON COLUMN steam_apps.app_id IS 'SteamアプリケーションID（AppID）';
COMMENT ON COLUMN steam_apps.name IS 'ゲームタイトル（日本語名がある場合は日本語名、なければ英語名）';
COMMENT ON COLUMN steam_apps.name_en IS 'ゲームの英語原題（日本語名と異なる場合のみ保持）';

-- steam_games
COMMENT ON TABLE steam_games IS 'フォロー中のSteamアカウントが所持・プレイしているゲームとプレイ時間・最終プレイ日時';
COMMENT ON COLUMN steam_games.steam_id IS '所持者の64ビットSteam ID（steam_profiles.steam_id）';
COMMENT ON COLUMN steam_games.app_id IS 'SteamアプリケーションID（AppID）';
COMMENT ON COLUMN steam_games.name IS 'ゲームタイトル（日本語優先）';
COMMENT ON COLUMN steam_games.name_en IS 'ゲームの英語原題';
COMMENT ON COLUMN steam_games.playtime_hours IS '累計プレイ時間（時間単位）';
COMMENT ON COLUMN steam_games.recent_hours IS '直近2週間のプレイ時間（時間単位）';
COMMENT ON COLUMN steam_games.first_played_at IS 'BOTが最初にこのゲームのプレイを検知した日時';
COMMENT ON COLUMN steam_games.last_played_at IS '最終プレイ日時';

-- steam_reviews
COMMENT ON TABLE steam_reviews IS 'フォロー中のSteamアカウントが投稿したゲームレビュー';
COMMENT ON COLUMN steam_reviews.steam_id IS '投稿者の64ビットSteam ID（steam_profiles.steam_id）';
COMMENT ON COLUMN steam_reviews.app_id IS 'レビュー対象のSteamアプリケーションID（AppID）';
COMMENT ON COLUMN steam_reviews.name IS 'レビュー対象のゲームタイトル';
COMMENT ON COLUMN steam_reviews.recommended IS 'おすすめ（高評価）かどうか（true: おすすめ / false: おすすめしない）';
COMMENT ON COLUMN steam_reviews.hours_on_record IS 'レビュー記載の総プレイ時間（時間単位）';
COMMENT ON COLUMN steam_reviews.posted IS 'レビュー投稿日の表示テキスト';
COMMENT ON COLUMN steam_reviews.content IS 'レビュー本文テキスト';
COMMENT ON COLUMN steam_reviews.url IS 'レビューページのURL';
COMMENT ON COLUMN steam_reviews.position IS 'プロフィール上でのレビューの並び順（0始まり）';

-- steam_wishlist
COMMENT ON TABLE steam_wishlist IS 'フォロー中のSteamアカウントがウィッシュリストに登録しているゲーム一覧';
COMMENT ON COLUMN steam_wishlist.steam_id IS '64ビットSteam ID（steam_profiles.steam_id）';
COMMENT ON COLUMN steam_wishlist.app_id IS 'SteamアプリケーションID（AppID）';
COMMENT ON COLUMN steam_wishlist.name IS 'ゲームタイトル（日本語優先）';
COMMENT ON COLUMN steam_wishlist.name_en IS 'ゲームの英語原題';
COMMENT ON COLUMN steam_wishlist.priority IS 'ウィッシュリスト内の優先順位';
COMMENT ON COLUMN steam_wishlist.added_at IS 'ウィッシュリストに追加された日時';
