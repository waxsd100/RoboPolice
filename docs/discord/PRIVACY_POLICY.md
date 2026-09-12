# Privacy Policy — ロボポリス (RoboPolice)

**Discord Application ID:** `308674858781245440`
**Last updated:** << YYYY-MM-DD >>

> ⚠️ これは雛形です。`<< >>` を実値に置換し、**安定した恒久URL**（例: GitHub Pages）で公開してから
> Discord の申請フォームと Developer Portal の Privacy Policy URL 欄に登録してください。
> Discord サーバーの招待リンクは URL として認められません。

---

## 1. Who we are

RoboPolice ("the App") is a Discord audit-logging application operated by << 運営者名 / チーム名 >>
("we", "us"). Contact: << メールアドレス >> / << サポートサーバー招待URL >>.

## 2. What data we collect

The App only receives data from Discord's API for servers it has been added to.

### 2.1 Message data

For every message sent in a non-excluded channel of a server where the App is installed, we store:

| Field | Stored form |
|---|---|
| Message ID | plaintext |
| Author user ID | plaintext |
| Message content | **AES-256 encrypted** |
| Image attachment URLs (max 10) | **AES-256 encrypted** |
| Timestamp | plaintext |

We do not store the server ID or the channel ID of a message.

This data exists for one purpose only: so that when a message is later deleted or edited, the App can
show server moderators what it previously said. Discord's API cannot return a deleted message, so
retaining it in advance is the only way this feature can work.

### 2.2 Server configuration data

Per server, we store: server ID, server owner ID, the log channel ID configured for each event type,
the list of channels excluded from logging, the list of disabled events, and per-server settings.

### 2.3 Operational caches

Invite code usage counters, webhook handles and server settings are held temporarily in Redis to
avoid repeated API calls. These are caches, not a long-term store.

### 2.4 What we do NOT collect

- Presence / online status / activity data (the App does not use the Presence intent)
- Member profile data (nicknames, roles and avatars are read live from Discord and are never written
  to our database)
- Direct messages — the App only operates in servers
- Payment information
- Any data from servers the App has not been added to

## 3. How we use the data

Solely to generate the log embeds that the App posts back into the same server the event came from,
and to answer moderator commands such as `/userinfo` and `/archive`.

We do **not** use your data for machine learning or AI model training, profiling, advertising,
analytics, or any statistical product. We do **not** sell, rent or share it with third parties.

## 4. Retention

| Data | Retention |
|---|---|
| Message rows | << N >> days, then permanently deleted |
| Server configuration | Until the App is removed from the server |
| Operational caches | Transient; cleared on restart |

## 5. Security

Message content and attachment URLs are encrypted with AES-256 in the application layer before being
written to the database, so plaintext content never reaches disk. The encryption key is held only in
the application's runtime environment. << ディスク暗号化・アクセス制限があればここに記載 >>

## 6. Your choices

- **Server administrators** can exclude a channel with `/ignorechannel`, stop all logging with
  `/stoplogging`, or remove the App from the server (which deletes its configuration).
- **Any user** can run `/clearmydata` to get the contact details for a data deletion request.

## 7. Requesting deletion of your data

Contact us at << メールアドレス >> or via << サポートサーバー招待URL >> with your Discord user ID.
We will delete your stored message rows. In all cases, message rows are automatically deleted after
<< N >> days.

## 8. Children

The App is not directed at children under the minimum age required by Discord's Terms of Service in
their country.

## 9. Changes

We may update this policy. The "Last updated" date above reflects the most recent revision, and
material changes will be announced in << サポートサーバー招待URL >>.

## 10. Contact

<< メールアドレス >> / << サポートサーバー招待URL >>
