# AsterPDF Desktop

An offline PDF workspace for Windows and Apple Silicon Macs. It opens PDFs, DOCX files, PNGs, JPEGs, and WebP images in one step. Imported files appear immediately as PDFs and can be saved through the same **Save PDF** action. This is a separate open source application from the AsterPDF website.

## Features

- Open a local PDF, DOCX, PNG, JPEG, or WebP file with the file picker or drag and drop it into the window. DOCX conversion uses a bundled browser renderer and Electron PDF printing; it does not require Word, LibreOffice, or a network connection. Text in a converted DOCX remains searchable.
- Add more PDFs, DOCX files, and images to the open PDF to make one document. Append them or insert them after a chosen page.
- Reorder pages by dragging, or use the move buttons. Select several pages to move, rotate, duplicate, or delete together. These page changes update the preview immediately and stay in memory until **Save PDF** is clicked. Undo and redo up to 20 edits within a 128 MB history limit.
- Use **Edit** to change a supported original PDF text object in place or add editable text and images. Click inside a text frame to edit; drag its border to move original PDF text or added text. When editing original text, choose its font from the Edit tools bar. The searchable menu lists the original font, bundled Noto fonts, and installed fonts that permit embedding; favorite fonts and the last three choices stay on this machine. Typing Arabic does not change the selected font. AsterPDF matches PDF font names to installed fonts (including generated numeric suffixes) and embeds the match when it covers the replacement. If the original font is unavailable or lacks the new glyphs, AsterPDF uses a bundled fallback or reports unsupported text without changing the PDF. AsterPDF checks saved original text before accepting a replacement. Noto Naskh Arabic shapes Arabic into an embedded PDF font, preserving joined letters and editable logical text through save and reopen. Some PDF readers may copy mixed Arabic, Latin, and number runs in a different order; AsterPDF's own text editing retains the requested logical line. Added text currently offers Helvetica and bundled Noto fonts in its inline editor.
- Use **Draw** to add editable pen strokes, lines, rectangles, and ellipses. AsterPDF stores editing data in saved PDFs so these objects can be changed after reopening the file.
- Click **Sign** to choose from saved signatures or add one by drawing or importing a PNG, JPEG, WebP, or SVG. The signature follows the pointer before placement. A placed signature stays movable and resizable until it is saved. While signatures are pending, the toolbar shows a green **Confirm** action to save the PDF and a red **Discard** action to remove those placements after confirmation. The comment action returns after the save. Drawing uses a high-resolution canvas, and saved signatures remain available on this computer. Newly drawn signatures save as PDF vector strokes rather than extractable image objects. Imported signatures and signatures saved by earlier versions remain images; redraw an older signature to use vector saving. Visible signatures can still be copied with PDF editing or screen capture tools.
- Compress offline. A background worker calculates approximate output sizes once for each version of the open PDF; sampled pages make the **Balanced** and **Smallest** numbers estimates rather than guarantees. Selecting a preset does not alter the PDF. Click **Save compressed copy…**, choose a location, and then compression begins with visible progress. Canceling the location dialog leaves the PDF untouched. **Lossless** repacks PDF objects and preserves text and annotations when it reduces size. **Balanced** and **Smallest** render pages as JPEG images; these modes can reduce image-heavy PDFs more substantially but flatten searchable text, links, forms, and comments. The original file remains at its path.
- Reopen a recent PDF from the opening screen. The list shows a locally cached preview of its first page and keeps up to eight available files.
- Scroll continuously through every page. Nearby pages render on demand, and the page counter follows the scroll position. You can still jump from the toolbar, page list, or a comment.
- Read embedded text notes and comments attached to markup annotations. Authors are shown from the PDF's annotation author field; unnamed comments display **Unknown author**.
- Place new text notes on a page. Set your comment author name in **Settings** before adding a note.
- Each new comment is saved into the open PDF automatically. A spinner beside the filename shows a save in progress; an unsaved dot remains if writing fails, and **Save PDF** retries it. Page changes and imports are saved with **Save PDF**; pending signatures can be saved with **Confirm** in the toolbar. Compression uses its own **Save compressed copy…** action. Save pending page changes before adding a comment. Use **File → Save As…** to make a copy. The notes use standard PDF `/Text` annotations with `/T` (author) and `/Contents` (comment), so other PDF readers can read them.

PDF parsing, DOCX and image conversion, editing, compression, file access, and settings all stay on the local machine and work without an internet connection. Update checks contact the public GitHub Releases API every 24 hours while AsterPDF is running, or on the next launch after a check is due. The check time and latest release are cached locally across restarts. **Settings → Check for updates** runs a manual check. When a newer stable version is found, an **Update** button appears beside Settings. Clicking it downloads the update inside AsterPDF with a progress bar, percentage, and downloaded size. You can close Settings and keep working while it downloads; the header continues showing progress.

After download verification, choose **Restart and install** in Settings. AsterPDF saves pending document changes (including placed signatures and a composed comment) first. Converted files prompt for a PDF location. Canceling that dialog or a save error keeps the application open and leaves the update ready to install. Updates never install automatically on normal exit. Download failures offer a retry. An interrupted download can be retried on the next launch; completed cached downloads are revalidated before reuse. In-app installation is available in packaged builds; development builds display an explanation. Update requests contain no PDF content, file paths, comments, or author settings. Failed checks and downloads leave document work available offline.

## Build from source

Install Node.js 20 or newer. The lockfile pins the dependency tree.

### Windows x64

Run `build-windows.bat`. It installs the locked dependencies, checks TypeScript, bundles the interface, and creates an NSIS installer at `release/AsterPDF-0.5.0-Windows-x64-Setup.exe` plus a matching `.sha256` checksum file. The installer includes the app; installing it does not download anything.

### macOS Apple Silicon

On an M series Mac, run:

```bash
chmod +x build-macos.command
./build-macos.command
```

The script creates an arm64 DMG installer and ZIP in `release/`, with a `.sha256` checksum file for each. For a public macOS release, provide a **Developer ID Application** signing certificate and Apple notarization credentials in the build environment. The script enables notarization when credentials are present. Without those credentials, it produces an unsigned local build that macOS Gatekeeper may block. See [electron-builder's notarization guide](https://www.electron.build/v26/docs/notarization/) for the supported certificate and credential variables. Document features work offline; signing and notarization occur only during the build.

The Windows installer built without a code signing certificate is also unsigned and may show a SmartScreen warning. Electron Builder can sign it when a Windows signing certificate is supplied to the build environment.

Build outputs and checksum files stay under `release/`, which `.gitignore` excludes from the source repository. If distributing builds through GitHub, attach the installers and their matching `.sha256` files to a GitHub Release; they are not source-code commits. On macOS, verify a downloaded file with `shasum -a 256 -c <checksum-file>.sha256`. On Windows, compare `Get-FileHash <installer> -Algorithm SHA256` with the hash in its `.sha256` file.

### GitHub release files for in-app updates

Both build scripts generate updater metadata for the public `xxmelar-ksaxx/AsterPDF-app` repository. For each new version, set `package.json` to that version, build both platforms, and attach these files to the matching stable `v<version>` release:

- **Windows:** `AsterPDF-<version>-Windows-x64-Setup.exe`, its `.sha256` and `.exe.blockmap`, and `latest.yml`.
- **macOS:** `AsterPDF-<version>-macOS-arm64.dmg`, `AsterPDF-<version>-macOS-arm64.zip`, their `.sha256` files, `latest-mac.yml`, and any generated `.blockmap` files.

Keep generated filenames and metadata unchanged. Upload the complete set to a draft release, then publish it once both platforms are ready. The YAML files contain SHA-512 integrity hashes used by the updater; `.sha256` files are for manual verification. `app-update.yml` is bundled inside the installed app and does not need a separate release upload. Older releases without the YAML metadata cannot be installed through this flow. Users on versions without this feature need to install the first supporting version manually.

macOS in-app installation requires a properly signed app and ZIP, with the same signing identity across releases; use notarized builds for public distribution. The DMG alone is insufficient. Windows uses the bundled NSIS installer. See [electron-builder v26 auto-update requirements](https://www.electron.build/v26/docs/features/auto-update/). No publishing or signing credentials are embedded in the app.

## Development and verification

```bash
npm ci
npm test
npm run build
npm run desktop
```

`npm run desktop` starts the built app. During development, run `npm run dev` in one terminal, then start Electron with `ASTERPDF_DEV_URL=http://127.0.0.1:5173` in another terminal. On Windows PowerShell set the variable with `$env:ASTERPDF_DEV_URL='http://127.0.0.1:5173'` before `npm run desktop`.

`npm run smoke` exercises the reader, recent-file previews, automatic saves, failed-save retry, and PDF annotations. `npm run smoke:editor` checks DOCX and image conversion, searchable DOCX text, page edits, signatures, and offline compression. `npm run smoke:updates` checks update progress, retry, and save-before-install with mocked network/installer operations and real PDF writes, including canceled Save As and failed writes. It never installs an update. `ASTERPDF_SMOKE_PACKAGED=1` runs the reader smoke test against `release/win-unpacked/AsterPDF.exe` after a Windows build.

## Implementation

Electron hosts the same bundled React/TypeScript UI on both platforms. PDF.js renders pages and reads annotations; pdf-lib edits PDFs and writes standard text annotations. DOCX Preview renders Word documents locally, then Electron prints the result to a searchable PDF. Electron's isolated preload exposes file, print, recent-file, settings, and update operations. Update checks run in the main process against the fixed public GitHub repository. `electron-updater` downloads and verifies the platform package using its separate network session; the renderer cannot supply update URLs or installer paths. The main process independently refuses installation while document changes or a save remain pending. The renderer has no Node.js access, remote navigation and windows are blocked, and the packaged UI is served through a local custom protocol with a restrictive content security policy. Author settings, update-check state, and small recent-file previews are stored in the operating system's per-user app data directory.

## Current scope

Supported import formats match the website's PDF, DOCX, and common image workflow; legacy `.doc`, presentations, spreadsheets, and arbitrary file formats are not supported. DOCX Preview is an HTML renderer, so complex Word layout may differ from Microsoft Word, especially automatic page breaks, field codes, and specialized drawings. New comments are sticky notes; this release does not create highlights, edit existing comments, or show reply threads. Encrypted PDFs require a future password flow. Saving or editing rewrites the PDF and can invalidate existing cryptographic signatures; use **Save As…** to retain an untouched original. Copying pages can also lose document-level outlines and interactive form structure. Check advanced PDFs in their original reader after editing.

Licensed under MIT; see [LICENSE](LICENSE).
