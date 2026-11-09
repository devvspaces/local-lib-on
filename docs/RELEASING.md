# Releasing

Releases are built by GitHub Actions (`.github/workflows/release.yml`). They are published to
[GitHub Releases](https://github.com/devvspaces/local-lib-on/releases), and installed copies update themselves from there.

## One-time setup

1. Create the public repository `devvspaces/local-lib-on` and push `master`.
2. Add the repository secret under **Settings → Secrets and variables → Actions**:
   - `TAURI_SIGNING_PRIVATE_KEY`: the contents of `~/.tauri/local-lib.key` (on the maintainer's Mac).
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: not needed. The key has no password, and a missing secret reads as empty.

   The matching public key is in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. **Back up the private key.** If it is lost, existing installs can't verify new updates, and users would have to download a new build by hand.
3. Allow Actions to push the version-bump commit: **Settings → Actions → General → Workflow permissions → Read and write**.

## Cutting a release

1. Add a new entry at the **top** of `changelogs/changelogs.json`, with a higher `version`, the date, and `features` / `fixes`.
2. Commit with a message ending in `--release`, and push to `master`:
   ```sh
   git commit -am "Audiobook improvements --release" && git push
   ```
   You can also run the **Release** workflow by hand from the Actions tab.
3. The workflow then:
   - checks the version
   - bumps `package.json`, `tauri.conf.json` and `Cargo.toml` (one bot commit)
   - creates a draft release with notes from the changelog
   - builds macOS (Apple Silicon and Intel), Windows x64 and Linux x64 in parallel, uploading the installers, the signed updater bundles and `latest.json`
   - publishes the release

Installed apps check `releases/latest/download/latest.json` once a day (Settings → Library → About & updates). They download the signed bundle for their platform, verify it against the public key, and offer **Restart now**.

## macOS signing

Builds are ad-hoc signed (`bundle.macOS.signingIdentity: "-"`), not notarized. On first launch, users run `xattr -cr "/Applications/Local Lib.app"`; the release notes say so. Updates installed from inside the app don't need this.

To ship notarized builds later, add these secrets. The workflow already passes them to the build, so no workflow changes are needed:
- `APPLE_CERTIFICATE`: a base64 `.p12` of your Developer ID Application certificate
- `APPLE_CERTIFICATE_PASSWORD`
- `APPLE_SIGNING_IDENTITY`: for example `Developer ID Application: Name (TEAMID)`
- `APPLE_ID`, `APPLE_PASSWORD` (an app-specific password) and `APPLE_TEAM_ID`

## Platform notes

- **Windows** links the C runtime statically (`src-tauri/.cargo/config.toml`), because sherpa-onnx's static libraries require it.
- **Audiobook export** uses `afconvert` on macOS and `ffmpeg` elsewhere. The dialog explains how to install ffmpeg if it's missing.
- **Vision OCR** is macOS-only. Other platforms use Tesseract automatically.

## Building locally

```sh
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/local-lib.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" bun tauri build
```

The output goes to `src-tauri/target/release/bundle/`: `dmg/`, `macos/*.app`, and the updater files `*.app.tar.gz` / `*.sig`.
