# TernSite

TernSite is a Rocket-based web app for TernReader:
- Convert EPUB + image files for the Xteink X4.
- Flash the latest **application** firmware via WebSerial.

Planned host: `https://ternreader.org`

## What’s Implemented
- Drag-and-drop conversion for `.epub`, `.png`, `.jpg`, `.jpeg`.
- Image conversion using `tern-image` (defaults to TRIM v2 gray2).
- Book conversion using `tern-book` with Bookerly fonts.
- WebSerial flashing of the **app-only** firmware at `0x10000`.
- Firmware metadata and binary served from `/api/firmware/latest` and `/api/firmware/app`.
- Local cache support in `cache/` for firmware binaries.
- ONNX barcode/QR model support for image conversion.

## Repo Layout
- `src/main.rs` — Rocket server + API endpoints.
- `static/` — UI (HTML/CSS/JS) and bundled `esptool-js`.
- `fonts/` — Bookerly fonts.
- `models/` — ONNX barcode/QR model.
- `cache/` — local firmware binaries (e.g. `tern-fw-v0.2.0.bin`).

## Requirements
- Rust toolchain
- Bookerly fonts in `fonts/` (already in this repo)
- ONNX model in `models/YOLOV8s_Barcode_Detection.onnx` (already in this repo)

## Run
```
cargo run
```
Open `http://localhost:8000` in Chrome or Edge (WebSerial required for flashing).

## Conversion
### Images
- Drag and drop a `.png`, `.jpg`, or `.jpeg`.
- Defaults to TRIM v2 (gray2) output.
- Optional controls: fit, dither, barcode/QR handling, invert.
- Output filename is auto-generated and editable.

### Books
- Drag and drop a `.epub`.
- Bookerly is the only font choice for now.
- Default size is `24` (editable, comma-separated).
- Output filename is auto-generated and editable.

## Firmware Flashing
- UI shows the latest app firmware version and size.
- Uses WebSerial + bundled `esptool-js`.
- Flashes **application image only** at `0x10000`.
- Progress shown via a progress bar; log reports completion.

### Firmware Source
- If a file matching `cache/tern-fw-*.bin` exists, it is preferred.
- Otherwise it falls back to GitHub releases (`azw413/TernReader`).

## API Endpoints
- `GET /api/info`
- `GET /api/firmware/latest`
- `GET /api/firmware/app`
- `POST /api/convert/image`
- `POST /api/convert/book`

## Notes
- WebSerial requires Chrome/Edge.
- If flashing doesn’t connect, ensure no other app or tab has the port open.
