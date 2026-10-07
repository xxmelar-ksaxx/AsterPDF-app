# AsterPDF Desktop

An offline PDF workspace for Windows and Apple Silicon Macs. It opens PDFs, DOCX files, PNGs, JPEGs, and WebP images in one step. Imported files appear immediately as PDFs and can be saved through the same **Save PDF** action. This is a separate open source application from the AsterPDF website.

## Features

- Open a local PDF, DOCX, PNG, JPEG, or WebP file with the file picker or drag and drop it into the window. DOCX conversion uses a bundled browser renderer and Electron PDF printing; it does not require Word, LibreOffice, or a network connection. Text in a converted DOCX remains searchable.
- Add more PDFs, DOCX files, and images to the open PDF to make one document. Append them or insert them after a chosen page.
- Reorder pages by dragging, or use the move buttons. Select several pages to move, rotate, duplicate, or delete together. These page changes update the preview immediately and stay in memory until **Save PDF** is clicked. Undo and redo up to 20 edits within a 128 MB history limit.
- Click **Sign** to choose from saved signatures or add one by drawing or importing a PNG, JPEG, WebP, or SVG. The signature follows the pointer before placement. Until **Save PDF**, click a placed signature to move or resize it, or right-click it to delete it. Drawing uses a high-resolution canvas, and saved signatures remain available on this computer. Newly drawn signatures save as PDF vector strokes rather than extractable image objects. Imported signatures and signatures saved by earlier versions remain images; redraw an older signature to use vector saving. Visible signatures can still be copied with PDF editing or screen capture tools.
- Compress offline. **Lossless** repacks PDF objects and preserves text and annotations when it reduces size. **Balanced** and **Smallest** render pages as JPEG images; these modes can reduce image-heavy PDFs more substantially but flatten searchable text, links, forms, and comments. The app keeps the original open when a preset cannot reduce size. A successful compression saves to a new PDF path by default.
- Reopen a recent PDF from the opening screen. The list shows a locally cached preview of its first page and keeps up to eight available files.
- Scroll continuously through every page. Nearby pages render on demand, and the page counter follows the scroll position. You can still jump from the toolbar, page list, or a comment.
- Read embedded text notes and comments attached to markup annotations. Authors are shown from the PDF's annotation author field; unnamed comments display **Unknown author**.
- Place new text notes on a page. Set your comment author name in **Settings** before adding a note.
- Each new comment is saved into the open PDF automatically. A spinner beside the filename shows a save in progress; an unsaved dot remains if writing fails, and **Save PDF** retries it. Other edits, including page changes, imports, signatures, and compression, are saved only when **Save PDF** is clicked. Save pending page changes before adding a comment. Use **File → Save As…** to make a copy. The notes use standard PDF `/Text` annotations with `/T` (author) and `/Contents` (comment), so other PDF readers can read them.

The application makes no network requests at runtime. PDF parsing, DOCX and image conversion, editing, compression, file access, and settings all stay on the local machine. Dependencies are downloaded only when building from source.

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

`npm run smoke` exercises the reader, recent-file previews, automatic saves, failed-save retry, and PDF annotations. `npm run smoke:editor` checks DOCX and image conversion, searchable DOCX text, page edits, signatures, and offline compression. `ASTERPDF_SMOKE_PACKAGED=1` runs the reader smoke test against `release/win-unpacked/AsterPDF.exe` after a Windows build.

## Implementation

Electron hosts the same bundled React/TypeScript UI on both platforms. PDF.js renders pages and reads annotations; pdf-lib edits PDFs and writes standard text annotations. DOCX Preview renders Word documents locally, then Electron prints the result to a searchable PDF. Electron's isolated preload exposes only file, print, recent-file, and settings operations. The renderer has no Node.js access, remote navigation and windows are blocked, and the packaged UI is served through a local custom protocol with a restrictive content security policy. Author settings and small recent-file previews are stored in the operating system's per-user app data directory.

## Current scope

Supported import formats match the website's PDF, DOCX, and common image workflow; legacy `.doc`, presentations, spreadsheets, and arbitrary file formats are not supported. DOCX Preview is an HTML renderer, so complex Word layout may differ from Microsoft Word, especially automatic page breaks, field codes, and specialized drawings. New comments are sticky notes; this release does not create highlights, edit existing comments, or show reply threads. Encrypted PDFs require a future password flow. Saving or editing rewrites the PDF and can invalidate existing cryptographic signatures; use **Save As…** to retain an untouched original. Copying pages can also lose document-level outlines and interactive form structure. Check advanced PDFs in their original reader after editing.

Licensed under MIT; see [LICENSE](LICENSE).
