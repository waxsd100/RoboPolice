-- Mentions can now ask the bot to write a message into a channel (kind 'message'); the column is
-- free text, so only its description changes.
COMMENT ON COLUMN mention_logs.kind IS '応答の種類（chat: チャット返信 / event: イベント登録・更新 / forum: フォーラム投稿・更新 / message: チャンネルへの書き込み・更新 / error: エラー / refused: 制限・拒否 / cancelled: キャンセル・タイムアウト）';
