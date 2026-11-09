# Save to Local Lib (browser extension)

This extension saves the page you're viewing into Local Lib with one click. It works on DOI pages, arXiv, journals that expose `citation_*` tags, Open Library, and direct PDF links.

## Install (unpacked)
- **Chrome / Edge / Brave:**
  1. Open `chrome://extensions` and turn on **Developer mode**.
  2. Click **Load unpacked** and pick this `extension/` folder.
- **Firefox:**
  1. Open `about:debugging#/runtime/this-firefox`.
  2. Click **Load Temporary Add-on…** and pick `manifest.json`.

## Connect
1. In Local Lib, open **Settings → Browser connector** and copy the token.
2. Click the extension icon and paste the token once.

The extension only talks to `http://127.0.0.1:23120`, on your own machine. Requests without the token are rejected, and ordinary web pages can't call the connector.
