# Connecting Dropbox, OneDrive or Google Drive

Local Lib signs in to these services with OAuth (PKCE) in your browser. Your password never goes through the app. Each service needs a free "app" registration that you own. You do this once, then paste the ID into **Settings → Sync & backup**.

You don't need any of this if the desktop sync client (iCloud Drive, Dropbox, Google Drive or OneDrive) is already installed. In that case, pick **Cloud folder** and choose a folder inside it.

## Dropbox
1. Go to <https://www.dropbox.com/developers/apps> and choose **Create app**.
2. Choose **Scoped access**, then **App folder**, and give it a name (e.g. "Local Lib (me)").
3. On the **Permissions** tab, enable `files.content.write` and `files.content.read`, then **Submit**.
4. On the **Settings** tab, under OAuth 2 → Redirect URIs, add `http://127.0.0.1`. Dropbox allows any loopback port for desktop apps.
5. Copy the **App key** into Local Lib (Dropbox → Client ID) and click **Sign in with browser**.

Files appear in `Dropbox/Apps/<your app name>/`.

## OneDrive (personal Microsoft account)
1. Go to <https://portal.azure.com> → **App registrations** → **New registration**.
2. Supported account types: **Personal Microsoft accounts only**.
3. Redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost`.
4. Under **Authentication**, set **Allow public client flows** to **Yes**.
5. Under **API permissions**, add Microsoft Graph delegated `Files.ReadWrite.AppFolder` and `offline_access`.
6. Copy the **Application (client) ID** into Local Lib (OneDrive → Client ID) and sign in.

Files appear in `OneDrive/Apps/<your app name>/`.

## Google Drive
1. Go to <https://console.cloud.google.com>, create a project, and enable the **Google Drive API**.
2. Configure the OAuth consent screen: External, Testing mode, and add yourself as a test user.
3. Go to **Credentials → Create credentials → OAuth client ID**, and choose **Desktop app**.
4. Copy the **Client ID** and **Client secret** into Local Lib. A desktop-app secret isn't actually secret; Google requires it anyway. Then sign in.

Local Lib only asks for the `drive.file` scope, so it can see only files it created, inside a "Local Lib" folder.

## Encryption
Turn on **End-to-end encryption** after choosing the location, and enter the same passphrase on every device.
- **What's encrypted:** library state, book files and backups are sealed on the device before upload. The service only stores ciphertext.
- **What's readable:** file names (device ids, content hashes, backup timestamps) and `sync/crypto.json`, which holds the salt and a check value.
- **A forgotten passphrase can't be recovered.** Keep a local backup.
