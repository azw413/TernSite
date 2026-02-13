const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fileName = document.getElementById("file-name");
const convertBtn = document.getElementById("convert-btn");
const convertStatus = document.getElementById("convert-status");
const convertModal = document.getElementById("convert-modal");
const convertClose = document.getElementById("convert-close");
const convertTarget = document.getElementById("convert-target");
const uploadProgress = document.getElementById("upload-progress");
const uploadPercent = document.getElementById("upload-percent");
const uploadProgressWrap = document.querySelector(".upload-progress");
const uploadMetrics = document.getElementById("upload-metrics");
const imageOptions = document.getElementById("image-options");
const bookOptions = document.getElementById("book-options");
const imageOutput = document.getElementById("image-output");
const bookOutput = document.getElementById("book-output");

const fwName = document.getElementById("fw-name");
const fwTag = document.getElementById("fw-tag");
const fwSize = document.getElementById("fw-size");
const connectBtn = document.getElementById("connect-btn");
const flashBtn = document.getElementById("flash-btn");
const downloadBtn = document.getElementById("download-btn");
const flashLog = document.getElementById("flash-log");
const flashProgress = document.getElementById("flash-progress");
const flashPercent = document.getElementById("flash-percent");

const usbConnectBtn = document.getElementById("fm-connect-btn");
const usbRefreshBtn = document.getElementById("fm-refresh-btn");
const usbNewBtn = document.getElementById("fm-new-btn");
const usbAddBtn = document.getElementById("fm-add-btn");
const fmStatus = document.getElementById("fm-status");
const fmBreadcrumbs = document.getElementById("fm-breadcrumbs");
const fmList = document.getElementById("fm-list");
const fmEmpty = document.getElementById("fm-empty");
const usbLog = document.getElementById("usb-log");

let selectedFile = null;
let connectedLoader = null;
let esptoolModule = null;
let connecting = false;
let currentPort = null;
let currentTransport = null;
let flashing = false;

let usbPort = null;
let usbReader = null;
let usbWriter = null;
let usbBuffer = new Uint8Array(0);
let usbReqId = 1;
const pendingUsbFrames = [];
const usbInbox = new Map();
const usbStats = {
  rxBytes: 0,
  crcErrors: 0,
  badMagic: 0,
  badVersion: 0,
};
let usbConnected = false;
let usbMaxPayload = 4096;
let currentPath = "/";
let uploadInProgress = false;
let uploadCancelRequested = false;
let currentUploadPath = null;
let uploadStartMs = 0;
let uploadTotalBytes = 0;

function logFlash(message) {
  flashLog.textContent += `${message}\n`;
  flashLog.scrollTop = flashLog.scrollHeight;
}

function logUsb(message) {
  const time = new Date().toLocaleTimeString();
  usbLog.textContent += `[${time}] ${message}\n`;
  usbLog.scrollTop = usbLog.scrollHeight;
}

function setProgress(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  flashProgress.style.width = `${clamped}%`;
  flashPercent.textContent = `${clamped.toFixed(1)}%`;
}

function setUploadProgress(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  uploadProgress.style.width = `${clamped}%`;
  uploadPercent.textContent = `${Math.round(clamped)}%`;
}

function showUploadProgress() {
  uploadProgressWrap.classList.add("visible");
  setUploadProgress(0);
  uploadMetrics.textContent = "";
}

function hideUploadProgress() {
  uploadProgressWrap.classList.remove("visible");
  setUploadProgress(0);
  uploadMetrics.textContent = "";
}

function formatRate(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "0.0 KB/s";
  return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function updateUploadMetrics(sentBytes) {
  const elapsedSec = (Date.now() - uploadStartMs) / 1000;
  const rate = sentBytes / Math.max(elapsedSec, 0.1);
  const remainingBytes = Math.max(uploadTotalBytes - sentBytes, 0);
  const eta = remainingBytes / Math.max(rate, 1);
  uploadMetrics.textContent = `${formatRate(rate)} • ${formatEta(eta)} remaining`;
}

function setFile(file) {
  selectedFile = file;
  fileName.textContent = file ? file.name : "No file selected";

  const epub = file && isEpub(file);
  const image = file && isImage(file);
  imageOptions.style.display = image ? "block" : "none";
  bookOptions.style.display = epub ? "block" : "none";
  imageOptions.classList.toggle("hidden", !image);
  bookOptions.classList.toggle("hidden", !epub);

  if (file) {
    if (image) {
      imageOutput.value = replaceExtension(file.name, ".tri");
    }
    if (epub) {
      bookOutput.value = replaceExtension(file.name, ".trbk");
    }
  }
}

function formatSize(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(size >= 10 || idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function joinPath(base, name) {
  if (base === "/") return `/${name}`;
  return `${base.replace(/\/$/, "")}/${name}`;
}

function normalizePath(path) {
  if (!path.startsWith("/")) return `/${path}`;
  return path === "" ? "/" : path;
}

function setFileManagerStatus(text) {
  fmStatus.textContent = text;
}

function renderBreadcrumbs(path) {
  fmBreadcrumbs.textContent = "";
  const parts = path.split("/").filter(Boolean);
  const rootBtn = document.createElement("button");
  rootBtn.textContent = "/";
  rootBtn.addEventListener("click", () => listDirectory("/"));
  fmBreadcrumbs.appendChild(rootBtn);
  let current = "";
  parts.forEach((part) => {
    current += `/${part}`;
    const btn = document.createElement("button");
    btn.textContent = part;
    btn.addEventListener("click", () => listDirectory(current));
    fmBreadcrumbs.appendChild(btn);
  });
}

function renderFileList(entries) {
  fmList.textContent = "";
  const hiddenNames = new Set(["TRCACHE", "TRRESUME", "TRRECENT", "TRBOOKS"]);
  const filtered = entries.filter((entry) => {
    if (entry.name.startsWith(".")) return false;
    if (hiddenNames.has(entry.name)) return false;
    return true;
  });
  if (filtered.length === 0) {
    fmEmpty.style.display = "block";
    return;
  }
  fmEmpty.style.display = "none";
  filtered.forEach((entry) => {
    const row = document.createElement("div");
    row.className = "file-row";
    const nameCell = document.createElement("div");
    nameCell.className = "file-name";
    const nameBtn = document.createElement("button");
    nameBtn.textContent = entry.isDir ? `[DIR] ${entry.name}` : entry.name;
    if (entry.isDir) {
      nameBtn.addEventListener("click", () => listDirectory(joinPath(currentPath, entry.name)));
    } else {
      nameBtn.disabled = true;
    }
    nameCell.appendChild(nameBtn);

    const sizeCell = document.createElement("div");
    sizeCell.className = "file-meta";
    sizeCell.textContent = entry.isDir ? "—" : formatSize(entry.size);

    const actionsCell = document.createElement("div");
    actionsCell.className = "file-actions";
    if (!entry.isDir) {
      const delBtn = document.createElement("button");
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteEntry(entry));
      actionsCell.appendChild(delBtn);
    }

    row.appendChild(nameCell);
    row.appendChild(sizeCell);
    row.appendChild(actionsCell);
    fmList.appendChild(row);
  });
}

function isImage(file) {
  const name = file.name.toLowerCase();
  return name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg");
}

function isEpub(file) {
  return file.name.toLowerCase().endsWith(".epub");
}

function replaceExtension(filename, newExt) {
  const idx = filename.lastIndexOf(".");
  if (idx === -1) return filename + newExt;
  return filename.slice(0, idx) + newExt;
}

function toShortName(filename) {
  const parts = filename.split(".");
  const ext = parts.length > 1 ? parts.pop() : "";
  const base = parts.join(".");
  const clean = (str) => str.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  const shortBase = clean(base).slice(0, 8) || "FILE";
  let shortExt = clean(ext).slice(0, 3);
  if (shortExt === "TRB") {
    shortExt = "TBK";
  }
  return shortExt ? `${shortBase}.${shortExt}` : shortBase;
}

function ensureShortName(filename) {
  const short = toShortName(filename);
  return {
    name: short,
    changed: short.toUpperCase() !== filename.toUpperCase(),
  };
}

function uint8ToBinaryString(bytes) {
  const chunkSize = 0x8000;
  let result = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    result += String.fromCharCode(...chunk);
  }
  return result;
}

function buildImageFormData(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("region", document.getElementById("image-region").value);
  formData.append("fit", document.getElementById("image-fit").value);
  formData.append("dither", document.getElementById("image-dither").value);
  formData.append("invert", document.getElementById("image-invert").checked ? "true" : "false");
  formData.append("trimg_version", document.getElementById("image-trim").value);
  formData.append("output_name", imageOutput.value);
  return formData;
}

function buildBookFormData(file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("sizes", document.getElementById("book-sizes").value);
  formData.append("font", document.getElementById("book-font").value);
  formData.append("output_name", bookOutput.value);
  return formData;
}

async function handleConvert() {
  if (uploadInProgress) {
    uploadCancelRequested = true;
    convertStatus.textContent = "Canceling upload...";
    return;
  }
  if (!selectedFile) {
    convertStatus.textContent = "Select a file first.";
    return;
  }

  if (!isEpub(selectedFile) && !isImage(selectedFile)) {
    convertStatus.textContent = "Unsupported file type.";
    return;
  }

  const endpoint = isEpub(selectedFile) ? "/api/convert/book" : "/api/convert/image";
  const formData = isEpub(selectedFile)
    ? buildBookFormData(selectedFile)
    : buildImageFormData(selectedFile);

  convertStatus.textContent = "Converting...";
  hideUploadProgress();
  const response = await fetch(endpoint, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    convertStatus.textContent = `Conversion failed: ${response.status}`;
    return;
  }

  const blob = await response.blob();
  const defaultName = isEpub(selectedFile) ? "converted.trbk" : "converted.tri";
  const contentDisp = response.headers.get("Content-Disposition");
  const name = contentDisp && contentDisp.includes("filename=")
    ? contentDisp.split("filename=")[1]
    : defaultName;
  if (usbConnected) {
    const targetPath = joinPath(currentPath, name);
    const short = ensureShortName(name);
    const finalName = short.name;
    const finalPath = joinPath(currentPath, finalName);
    if (short.changed) {
      convertStatus.textContent = `Device requires 8.3 names. Using ${finalName}.`;
    }
    convertStatus.textContent = `Uploading to ${finalPath} ...`;
    showUploadProgress();
    uploadInProgress = true;
    uploadCancelRequested = false;
    currentUploadPath = finalPath;
    convertBtn.textContent = "Cancel";
    uploadStartMs = Date.now();
    uploadTotalBytes = blob.size;
    try {
      await usbUploadBlob(finalPath, blob, (percent) => setUploadProgress(percent));
      convertStatus.textContent = `Uploaded to ${finalPath}.`;
      hideUploadProgress();
      setFile(null);
      fileInput.value = "";
      await listDirectory(currentPath);
      convertModal.classList.remove("open");
    } catch (err) {
      hideUploadProgress();
      if (err?.message === "Upload canceled") {
        convertStatus.textContent = "Upload canceled.";
        if (currentUploadPath) {
          try {
            await usbDelete(currentUploadPath);
          } catch (_) {
            // Best effort cleanup.
          }
        }
      } else {
        convertStatus.textContent = `Upload failed: ${err?.message || err}`;
      }
    }
    uploadInProgress = false;
    uploadCancelRequested = false;
    currentUploadPath = null;
    convertBtn.textContent = "Convert";
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    convertStatus.textContent = "Downloaded.";
  }
}

function bindDropZone() {
  dropZone.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) setFile(file);
  });

  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("active");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("active");
  });

  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("active");
    const file = event.dataTransfer.files[0];
    if (file) setFile(file);
  });
}

async function loadLatestFirmware() {
  try {
    const response = await fetch("/api/firmware/latest");
    if (!response.ok) {
      fwName.textContent = "Unable to load firmware";
      return null;
    }
    const data = await response.json();
    fwName.textContent = data.asset_name;
    fwTag.textContent = data.tag;
    fwSize.textContent = `${(data.size / (1024 * 1024)).toFixed(2)} MB`;
    return data;
  } catch (err) {
    fwName.textContent = "Unable to load firmware";
    fwTag.textContent = "—";
    fwSize.textContent = "—";
    return null;
  }
}

async function ensureEsptool() {
  if (esptoolModule) return esptoolModule;
  esptoolModule = await import("/esptool.bundle.js");
  return esptoolModule;
}

async function closeOpenPorts() {
  if (!navigator.serial) return;
  const ports = await navigator.serial.getPorts();
  for (const port of ports) {
    if (port.readable || port.writable) {
      try {
        await port.close();
      } catch (_) {}
    }
  }
}

async function connectDevice() {
  if (connecting) {
    logFlash("Connection already in progress.");
    return;
  }
  if (connectedLoader) {
    logFlash("Already connected.");
    return;
  }
  try {
    connecting = true;
    connectBtn.disabled = true;
    if (!navigator.serial) {
      logFlash("WebSerial is not supported in this browser.");
      return;
    }

    await closeOpenPorts();
    if (currentTransport && typeof currentTransport.disconnect === "function") {
      await currentTransport.disconnect();
      currentTransport = null;
    }
    if (currentPort) {
      try {
        await currentPort.close();
      } catch (_) {}
      currentPort = null;
    }

    const { ESPLoader, Transport } = await ensureEsptool();
    const port = await navigator.serial.requestPort();
    currentPort = port;
    const transport = new Transport(port);
    currentTransport = transport;
    const loader = new ESPLoader({
      transport,
      baudrate: 115200,
      terminal: {
        clean() {},
        writeLine(data) {
          logFlash(data);
        },
        write(data) {
          logFlash(data);
        },
      },
    });
    await loader.main();
    connectedLoader = loader;
    flashBtn.disabled = false;
    logFlash("Connected. Ready to flash.");
  } catch (err) {
    logFlash(`Connection failed: ${err?.message || err}`);
    connectBtn.disabled = false;
    if (currentTransport && typeof currentTransport.disconnect === "function") {
      try {
        await currentTransport.disconnect();
      } catch (_) {}
      currentTransport = null;
    }
    if (currentPort) {
      try {
        await currentPort.close();
      } catch (_) {}
      currentPort = null;
    }
  } finally {
    connecting = false;
  }
}

async function flashFirmware() {
  if (!connectedLoader) {
    logFlash("Connect a device first.");
    return;
  }
  if (flashing) {
    logFlash("Flash already in progress.");
    return;
  }

  try {
    flashing = true;
    flashBtn.disabled = true;
    connectBtn.disabled = true;
    downloadBtn.disabled = true;

    logFlash("Downloading firmware...");
    const response = await fetch("/api/firmware/app");
    if (!response.ok) {
      logFlash("Failed to download firmware.");
      return;
    }
    const data = new Uint8Array(await response.arrayBuffer());
    const dataBstr = uint8ToBinaryString(data);

    logFlash("Flashing app image at 0x10000...");
    await connectedLoader.writeFlash({
      fileArray: [{ address: 0x10000, data: dataBstr }],
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_fileIndex, written, total) => {
        const percent = ((written / total) * 100).toFixed(1);
        setProgress(Number(percent));
      },
    });
    setProgress(100);
    logFlash("Flash complete. Reset the device.");
  } catch (err) {
    logFlash(`Flash failed: ${err?.message || err}`);
  } finally {
    flashing = false;
    connectBtn.disabled = false;
    flashBtn.disabled = !connectedLoader;
    downloadBtn.disabled = false;
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let j = 0; j < 8; j++) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (~crc) >>> 0;
}

function writeU16(buf, value) {
  buf.push(value & 0xff, (value >> 8) & 0xff);
}

function writeU32(buf, value) {
  buf.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
}

function encodeFrame(cmd, reqId, payload, flags = 0x00) {
  const out = [];
  writeU16(out, 0x5452);
  out.push(0x01);
  out.push(flags);
  out.push(cmd);
  writeU16(out, reqId);
  writeU32(out, payload.length);
  out.push(...payload);
  const crc = crc32(Uint8Array.from(out));
  writeU32(out, crc);
  return Uint8Array.from(out);
}

function parseFrames() {
  const frames = [];
  const findNextMagic = (buf, start) => {
    for (let i = start; i + 1 < buf.length; i++) {
      if (buf[i] === 0x52 && buf[i + 1] === 0x54) {
        return i;
      }
    }
    return -1;
  };
  while (usbBuffer.length >= 15) {
    const magic = usbBuffer[0] | (usbBuffer[1] << 8);
    if (magic !== 0x5452) {
      usbStats.badMagic += 1;
      const next = findNextMagic(usbBuffer, 1);
      if (next === -1) {
        usbBuffer = new Uint8Array(0);
      } else {
        usbBuffer = usbBuffer.slice(next);
      }
      continue;
    }
    const version = usbBuffer[2];
    if (version !== 0x01) {
      usbStats.badVersion += 1;
      const next = findNextMagic(usbBuffer, 1);
      if (next === -1) {
        usbBuffer = new Uint8Array(0);
      } else {
        usbBuffer = usbBuffer.slice(next);
      }
      continue;
    }
    const flags = usbBuffer[3];
    const cmd = usbBuffer[4];
    const reqId = usbBuffer[5] | (usbBuffer[6] << 8);
    const len = usbBuffer[7] | (usbBuffer[8] << 8) | (usbBuffer[9] << 16) | (usbBuffer[10] << 24);
    const total = 11 + len + 4;
    if (usbBuffer.length < total) break;
    const payload = usbBuffer.slice(11, 11 + len);
    const crcStart = 11 + len;
    const expectedCrc = usbBuffer[crcStart] | (usbBuffer[crcStart + 1] << 8) | (usbBuffer[crcStart + 2] << 16) | (usbBuffer[crcStart + 3] << 24);
    const actualCrc = crc32(usbBuffer.slice(0, 11 + len));
    const crcOk = expectedCrc === actualCrc;
    if (!crcOk) {
      usbStats.crcErrors += 1;
      if (usbStats.crcErrors % 5 === 1) {
        logUsb(`CRC mismatch (${usbStats.crcErrors})`);
      }
    }
    usbBuffer = usbBuffer.slice(total);
    frames.push({ flags, cmd, reqId, payload, crcOk });
  }
  return frames;
}

function decodeError(payload) {
  if (payload.length < 4) return "unknown error";
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const code = view.getUint16(0, true);
  const len = view.getUint16(2, true);
  const msgBytes = payload.slice(4, 4 + len);
  const msg = new TextDecoder().decode(msgBytes);
  return `code ${code}: ${msg}`;
}

function dispatchUsbFrame(frame) {
  const isErr = (frame.flags & 0x02) !== 0;
  const isResp = (frame.flags & 0x01) !== 0;
  const flagText = `${isResp ? "RESP" : "REQ"}${isErr ? "|ERR" : ""}${frame.crcOk === false ? "|CRC" : ""}`;
  logUsb(`RX ${flagText} cmd=0x${frame.cmd.toString(16)} req=${frame.reqId} len=${frame.payload.length}`);
  if (isErr) {
    logUsb(`ERR ${decodeError(frame.payload)}`);
  }
  let delivered = false;
  for (let i = 0; i < pendingUsbFrames.length; i++) {
    if (pendingUsbFrames[i](frame)) {
      delivered = true;
    }
  }
  if (!delivered) {
    const queued = usbInbox.get(frame.reqId) || [];
    queued.push(frame);
    usbInbox.set(frame.reqId, queued);
  }
}

async function usbReadLoop() {
  while (usbReader) {
    const { value, done } = await usbReader.read();
    if (done) break;
    if (value) {
      usbStats.rxBytes += value.length;
      const merged = new Uint8Array(usbBuffer.length + value.length);
      merged.set(usbBuffer, 0);
      merged.set(value, usbBuffer.length);
      usbBuffer = merged;
      parseFrames().forEach(dispatchUsbFrame);
    }
  }
}

async function usbSend(cmd, payload) {
  if (!usbWriter) throw new Error("USB not connected");
  const reqId = usbReqId++ & 0xffff;
  const frame = encodeFrame(cmd, reqId, payload);
  logUsb(`TX cmd=0x${cmd.toString(16)} req=${reqId} len=${payload.length}`);
  await usbWriter.write(frame);
  return reqId;
}

function encodePathPayload(path) {
  const encoder = new TextEncoder();
  const pathBytes = encoder.encode(path);
  const payload = [];
  writeU16(payload, pathBytes.length);
  payload.push(...pathBytes);
  return { payload, pathBytes };
}

async function usbWaitForResponse(reqId, timeoutMs = 2000, allowCrcBad = false) {
  return new Promise((resolve, reject) => {
    const handler = (frame) => {
      if (frame.reqId !== reqId) return false;
      if (frame.crcOk === false && !allowCrcBad) return false;
      const idx = pendingUsbFrames.indexOf(handler);
      if (idx !== -1) pendingUsbFrames.splice(idx, 1);
      resolve(frame);
      return true;
    };
    pendingUsbFrames.push(handler);
    const queued = usbInbox.get(reqId);
    if (queued) {
      usbInbox.delete(reqId);
      queued.forEach((frame) => handler(frame));
    }
    setTimeout(() => {
      const idx = pendingUsbFrames.indexOf(handler);
      if (idx !== -1) pendingUsbFrames.splice(idx, 1);
      reject(new Error("USB timeout"));
    }, timeoutMs);
  });
}

async function usbInfo() {
  const reqId = await usbSend(0x02, []);
  const frame = await usbWaitForResponse(reqId, 2000);
  const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, frame.payload.byteLength);
  const maxPayload = view.getUint32(0, true);
  usbMaxPayload = maxPayload || usbMaxPayload;
  return usbMaxPayload;
}

async function usbList(path) {
  const { payload } = encodePathPayload(path);
  const reqId = await usbSend(0x10, payload);
  return new Promise((resolve, reject) => {
    let chunks = [];
    const timeoutId = setTimeout(() => {
      const idx = pendingUsbFrames.indexOf(handler);
      if (idx !== -1) pendingUsbFrames.splice(idx, 1);
      logUsb(`USB stats: rx=${usbStats.rxBytes} crc=${usbStats.crcErrors} magic=${usbStats.badMagic} ver=${usbStats.badVersion}`);
      reject(new Error("LIST timeout"));
    }, 5000);
    const handler = (frame) => {
      if (frame.reqId !== reqId) return false;
      const idx = pendingUsbFrames.indexOf(handler);
      if (idx !== -1 && (frame.flags & 0x02) !== 0) {
        pendingUsbFrames.splice(idx, 1);
      }
      const isErr = (frame.flags & 0x02) !== 0;
      if (isErr) {
        clearTimeout(timeoutId);
        reject(new Error(decodeError(frame.payload)));
        return true;
      }
      chunks.push(frame.payload);
      const isEof = (frame.flags & 0x04) !== 0 || (frame.flags & 0x08) === 0;
      if (isEof) {
        const idx = pendingUsbFrames.indexOf(handler);
        if (idx !== -1) pendingUsbFrames.splice(idx, 1);
        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        chunks.forEach((c) => {
          out.set(c, offset);
          offset += c.length;
        });
        clearTimeout(timeoutId);
        resolve(out);
      }
      return true;
    };
    pendingUsbFrames.push(handler);
    const queued = usbInbox.get(reqId);
    if (queued) {
      usbInbox.delete(reqId);
      queued.forEach((frame) => handler(frame));
    }
  });
}

async function usbDelete(path) {
  const { payload } = encodePathPayload(path);
  for (let attempt = 0; attempt < 3; attempt++) {
    const reqId = await usbSend(0x13, payload);
    const frame = await usbWaitForResponse(reqId, 2000);
    if (frame.crcOk === false) {
      continue;
    }
    const isErr = (frame.flags & 0x02) !== 0;
    if (isErr) {
      throw new Error(decodeError(frame.payload));
    }
    return;
  }
  throw new Error("Delete CRC retry failed");
}

async function usbMkdir(path) {
  const { payload } = encodePathPayload(path);
  const reqId = await usbSend(0x14, payload);
  const frame = await usbWaitForResponse(reqId, 2000);
  const isErr = (frame.flags & 0x02) !== 0;
  if (isErr) {
    throw new Error(decodeError(frame.payload));
  }
}

async function usbWriteStream(path, buffer, onProgress) {
  const encoded = new TextEncoder().encode(path);
  const headerOverhead = 2 + encoded.length + 4 + 8; // path + total + offset
  const maxChunk = Math.max(512, usbMaxPayload - headerOverhead);
  if (maxChunk <= 0) {
    throw new Error("USB payload too small");
  }

  const reqId = usbReqId++ & 0xffff;
  let offset = 0;
  let first = true;

  while (offset < buffer.length) {
    if (uploadCancelRequested) {
      throw new Error("Upload canceled");
    }
    const remaining = buffer.length - offset;
    const chunkSize = Math.min(maxChunk, remaining);
    const chunk = buffer.slice(offset, offset + chunkSize);

    let payload = [];
    if (first) {
      payload = encodePathPayload(path).payload;
      writeU32(payload, buffer.length);
      const offsetBytes = new Uint8Array(8);
      const view = new DataView(offsetBytes.buffer);
      view.setBigUint64(0, BigInt(offset), true);
      payload.push(...offsetBytes);
      payload.push(...chunk);
    } else {
      const offsetBytes = new Uint8Array(8);
      const view = new DataView(offsetBytes.buffer);
      view.setBigUint64(0, BigInt(offset), true);
      payload.push(...offsetBytes);
      payload.push(...chunk);
    }

    const isLast = offset + chunkSize >= buffer.length;
    const flags = isLast ? 0x04 : 0x08; // EOF or CONT
    const frame = encodeFrame(0x12, reqId, payload, flags);
    logUsb(`TX cmd=0x12 req=${reqId} len=${payload.length}`);
    let ack = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await usbWriter.write(frame);
      try {
        ack = await usbWaitForResponse(reqId, 8000, true);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        logUsb("Retrying chunk after timeout...");
      }
    }
    const ackErr = (ack.flags & 0x02) !== 0;
    if (ackErr) {
      throw new Error(decodeError(ack.payload));
    }
    const view = new DataView(ack.payload.buffer, ack.payload.byteOffset, ack.payload.byteLength);
    const written = ack.payload.length >= 4 ? view.getUint32(0, true) : offset + chunkSize;
    offset = Math.min(written, buffer.length);
    if (onProgress) {
      onProgress((offset / buffer.length) * 100);
      updateUploadMetrics(offset);
    }

    first = false;
  }
  return true;
}

async function usbUploadBlob(path, blob, onProgress) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  await usbWriteStream(path, buffer, onProgress);
}

async function waitForResponse(reqId, timeoutMs) {
  return new Promise((resolve) => {
    const handler = (frame) => {
      if (frame.reqId !== reqId) return false;
      const idx = pendingUsbFrames.indexOf(handler);
      if (idx !== -1) pendingUsbFrames.splice(idx, 1);
      resolve(true);
      return true;
    };
    pendingUsbFrames.push(handler);
    const queued = usbInbox.get(reqId);
    if (queued) {
      usbInbox.delete(reqId);
      queued.forEach((frame) => handler(frame));
    }
    setTimeout(() => {
      const idx = pendingUsbFrames.indexOf(handler);
      if (idx !== -1) pendingUsbFrames.splice(idx, 1);
      resolve(false);
    }, timeoutMs);
  });
}

async function connectUsb() {
  if (!navigator.serial) {
    logUsb("WebSerial not available.");
    return;
  }
  await closeOpenPorts();
  usbPort = await navigator.serial.requestPort();
  await usbPort.open({ baudRate: 16777216 });
  usbWriter = usbPort.writable.getWriter();
  usbReader = usbPort.readable.getReader();
  usbBuffer = new Uint8Array(0);
  logUsb("USB connected. Sending PING...");
  usbReadLoop();
  const pingReq = await usbSend(0x01, []);
  const pingOk = await waitForResponse(pingReq, 2000);
  if (!pingOk) {
    logUsb("No PING response (is USB mode enabled on device?)");
  }
  usbConnected = true;
  usbConnectBtn.textContent = "USB Connected";
  usbRefreshBtn.disabled = false;
  usbNewBtn.disabled = false;
  usbAddBtn.disabled = false;
  setFileManagerStatus("Connected. Fetching device info...");
  try {
    await usbInfo();
    setFileManagerStatus(`Connected. Max payload ${usbMaxPayload} bytes.`);
  } catch (err) {
    setFileManagerStatus(`Connected. Info failed: ${err?.message || err}`);
  }
  await listDirectory(currentPath);
}

function parseListPayload(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let offset = 0;
  const count = view.getUint16(offset, true);
  offset += 2;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const kind = view.getUint8(offset); offset += 1;
    const nameLen = view.getUint16(offset, true); offset += 2;
    const nameBytes = payload.slice(offset, offset + nameLen);
    offset += nameLen;
    const size = Number(view.getBigUint64(offset, true)); offset += 8;
    const name = new TextDecoder().decode(nameBytes);
    entries.push({
      name,
      isDir: kind === 1,
      size,
    });
  }
  return entries;
}

async function listDirectory(path) {
  try {
    const normalized = normalizePath(path);
    currentPath = normalized;
    renderBreadcrumbs(currentPath);
    setFileManagerStatus(`Listing ${currentPath} ...`);
    logUsb(`Listing ${currentPath} ...`);
    const payload = await usbList(currentPath);
    const entries = parseListPayload(payload);
    renderFileList(entries);
    setFileManagerStatus(`Showing ${entries.length} entries in ${currentPath}.`);
  } catch (err) {
    setFileManagerStatus(`List failed: ${err?.message || err}`);
    logUsb(`List failed: ${err?.message || err}`);
  }
}

async function deleteEntry(entry) {
  if (!confirm(`Delete ${entry.name}?`)) return;
  try {
    const path = joinPath(currentPath, entry.name);
    setFileManagerStatus(`Deleting ${path} ...`);
    await usbDelete(path);
    await listDirectory(currentPath);
  } catch (err) {
    setFileManagerStatus(`Delete failed: ${err?.message || err}`);
    await listDirectory(currentPath);
  }
}

async function createFolder() {
  const name = prompt("Folder name:");
  if (!name) return;
  const trimmed = name.trim();
  if (!trimmed) return;
  const target = joinPath(currentPath, trimmed);
  try {
    setFileManagerStatus(`Creating ${target} ...`);
    await usbMkdir(target);
    await listDirectory(currentPath);
  } catch (err) {
    setFileManagerStatus(`Create failed: ${err?.message || err}`);
  }
}

async function downloadFirmware() {
  const response = await fetch("/api/firmware/app");
  if (!response.ok) {
    logFlash("Failed to download firmware.");
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const contentDisp = response.headers.get("Content-Disposition");
  const name = contentDisp && contentDisp.includes("filename=")
    ? contentDisp.split("filename=")[1]
    : "tern-fw.bin";
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

bindDropZone();
convertBtn.addEventListener("click", handleConvert);
connectBtn.addEventListener("click", connectDevice);
flashBtn.addEventListener("click", flashFirmware);
downloadBtn.addEventListener("click", downloadFirmware);
usbConnectBtn.addEventListener("click", connectUsb);
usbRefreshBtn.addEventListener("click", () => listDirectory(currentPath));
usbNewBtn.addEventListener("click", createFolder);
usbAddBtn.addEventListener("click", () => {
  convertStatus.textContent = "";
  hideUploadProgress();
  if (!usbConnected) {
    convertTarget.textContent = "Connect USB to upload. Conversion will download instead.";
  } else {
    convertTarget.textContent = `Upload target: ${currentPath}`;
  }
  convertModal.classList.add("open");
});
convertClose.addEventListener("click", () => convertModal.classList.remove("open"));
convertModal.addEventListener("click", (event) => {
  if (event.target === convertModal) {
    convertModal.classList.remove("open");
  }
});

imageOptions.style.display = "none";
bookOptions.style.display = "none";
imageOptions.classList.add("hidden");
bookOptions.classList.add("hidden");
setProgress(0);
hideUploadProgress();
if (!navigator.serial) {
  connectBtn.disabled = true;
  flashBtn.disabled = true;
  logFlash("WebSerial not available. Use Chrome/Edge on localhost.");
  usbConnectBtn.disabled = true;
  usbRefreshBtn.disabled = true;
  usbNewBtn.disabled = true;
  usbAddBtn.disabled = true;
  logUsb("WebSerial not available. USB file access disabled.");
}
loadLatestFirmware();
