const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");
const fileName = document.getElementById("file-name");
const convertBtn = document.getElementById("convert-btn");
const convertStatus = document.getElementById("convert-status");
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

let selectedFile = null;
let connectedLoader = null;
let esptoolModule = null;
let connecting = false;
let currentPort = null;
let currentTransport = null;
let flashing = false;

function logFlash(message) {
  flashLog.textContent += `${message}\n`;
  flashLog.scrollTop = flashLog.scrollHeight;
}

function setProgress(percent) {
  const clamped = Math.max(0, Math.min(100, percent));
  flashProgress.style.width = `${clamped}%`;
  flashPercent.textContent = `${clamped.toFixed(1)}%`;
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
  const response = await fetch(endpoint, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    convertStatus.textContent = `Conversion failed: ${response.status}`;
    return;
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const defaultName = isEpub(selectedFile) ? "converted.trbk" : "converted.tri";
  const contentDisp = response.headers.get("Content-Disposition");
  const name = contentDisp && contentDisp.includes("filename=")
    ? contentDisp.split("filename=")[1]
    : defaultName;
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  convertStatus.textContent = "Done.";
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

imageOptions.style.display = "none";
bookOptions.style.display = "none";
imageOptions.classList.add("hidden");
bookOptions.classList.add("hidden");
setProgress(0);
if (!navigator.serial) {
  connectBtn.disabled = true;
  flashBtn.disabled = true;
  logFlash("WebSerial not available. Use Chrome/Edge on localhost.");
}
loadLatestFirmware();
