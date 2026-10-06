# AsterPDF Desktop

An offline desktop PDF reader and commenting app for Windows and Apple Silicon Macs. This is a separate open source application from the AsterPDF web workspace. Its first release focuses on reading PDFs and working with comments embedded in the PDF itself.

## Features

- Open a local PDF with the file picker or drag and drop it into the window.
- Reopen a recent PDF from the opening screen. The list shows a locally cached preview of its first page and keeps up to eight available files.
- Scroll continuously through every page. Nearby pages render on demand, and the page counter follows the scroll position. You can still jump from the toolbar, page list, or a comment.
- Read embedded text notes and comments attached to markup annotations. Authors are shown from the PDF's annotation author field; unnamed comments display **Unknown author**.
- Place new text notes on a page. Set your comment author name in **Settings** before adding a note.
- Each new comment is saved into the open PDF automatically. A spinner beside the filename shows a save in progress; an unsaved dot remains if writing fails, and **Save** retries it. Use **File → Save As…** to make a copy. The notes use standard PDF `/Text` annotations with `/T` (author) and `/Contents` (comment), so other PDF readers can read them.

The application makes no network requests at runtime. PDF parsing, rendering, annotation writing, file access, and author settings all stay on the local machine. Dependencies are downloaded only when building from source.

## Build from source

Install Node.js 20 or newer. The lockfile pins the dependency tree.

### Windows x64

Run `build-windows.bat`. It installs the locked dependencies, checks TypeScript, bundles the interface, and creates an NSIS installer at `release/AsterPDF-0.4.0-Windows-x64-Setup.exe` plus a matching `.sha256` checksum file. The installer includes the app; installing it does not download anything.

### macOS Apple Silicon

On an M series Mac, run:

```bash
chmod +x build-macos.command
./build-macos.command
```

The script creates an arm64 DMG installer and ZIP in `release/`, with a `.sha256` checksum file for each. For a public macOS release, provide a **Developer ID Application** signing certificate and Apple notarization credentials in the build environment. The script enables notarization when credentials are present. Without those credentials, it produces an unsigned local build that macOS Gatekeeper may block. See [electron-builder's notarization guide](https://www.electron.build/v26/docs/notarization/) for the supported certificate and credential variables. The installed application remains fully offline; signing and notarization occur only during the build.

The Windows installer built without a code signing certificate is also unsigned and may show a SmartScreen warning. Electron Builder can sign it when a Windows signing certificate is supplied to the build environment.

Build outputs and checksum files stay under `release/`, which `.gitignore` excludes from the source repository. If distributing builds through GitHub, attach the installers and their matching `.sha256` files to a GitHub Release; they are not source-code commits. On macOS, verify a downloaded file with `shasum -a 256 -c <checksum-file>.sha256`. On Windows, compare `Get-FileHash <installer> -Algorithm SHA256` with the hash in its `.sha256` file.

## Development and verification

```bash
npm ci
npm test
npm run build
npm run desktop
```

`npm run desktop` starts the built app. During development, run `npm run dev` in one terminal, then start Electron with `ASTERPDF_DEV_URL=http://127.0.0.1:5173` in another terminal. On Windows PowerShell set the variable with `$env:ASTERPDF_DEV_URL='http://127.0.0.1:5173'` before `npm run desktop`.

`npm run smoke` exercises the desktop window, checks recent-file previews and reopening, automatic saves and a failed-save retry, and verifies the PDF annotations. `ASTERPDF_SMOKE_PACKAGED=1` runs the smoke test against `release/win-unpacked/AsterPDF.exe` after a Windows build.

## Implementation

Electron hosts the same bundled React/TypeScript UI on both platforms. PDF.js renders pages and reads annotations; pdf-lib writes standard PDF text annotations. Electron's isolated preload exposes only file, recent-file, and settings operations. The renderer has no Node.js access, remote navigation and windows are blocked, and the packaged UI is served through a local custom protocol with a restrictive content security policy. Author settings and small recent-file previews are stored in the operating system's per-user app data directory.

## Current scope

New comments are sticky notes. Existing markup comments are listed when they contain annotation text; this release does not create highlights, draw ink, edit existing comments, or show reply threads. Encrypted PDFs require a future password flow. Saving rewrites the PDF, so it can invalidate existing digital signatures; use **Save As…** to retain an untouched original. PDFs with advanced interactive or nonstandard features should be checked in the original reader after saving.

Licensed under MIT; see [LICENSE](LICENSE).
