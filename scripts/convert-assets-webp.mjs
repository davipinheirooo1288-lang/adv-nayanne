import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const assetsDir = path.join(root, "public", "assets");
const quality = Number(process.env.WEBP_QUALITY ?? 0.86);

const browserCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const findBrowser = async () => {
  for (const candidate of browserCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next browser
    }
  }

  throw new Error("Chrome ou Edge nao encontrado para converter imagens em WebP.");
};

const waitForJson = async (url, timeoutMs = 12000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // browser is still starting
    }
    await delay(150);
  }

  throw new Error(`Timeout aguardando ${url}`);
};

const connectCdp = async (wsUrl) => {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;

    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
    else resolve(message.result ?? {});
  });

  const send = (method, params = {}) => {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`Timeout no comando CDP ${method}`));
        }
      }, 30000);
    });
  };

  return { ws, send };
};

const openPage = async (debugPort) => {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, {
    method: "PUT"
  });

  if (!response.ok) {
    throw new Error(`Nao foi possivel abrir aba no Chrome: ${response.status}`);
  }

  const page = await response.json();
  return connectCdp(page.webSocketDebuggerUrl);
};

const convertInBrowser = async (page, dataUrl) => {
  const result = await page.send("Runtime.evaluate", {
    expression: `new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        resolve({
          dataUrl: canvas.toDataURL("image/webp", ${quality}),
          width: image.naturalWidth,
          height: image.naturalHeight
        });
      };
      image.onerror = () => reject(new Error("Imagem nao carregou no canvas"));
      image.src = ${JSON.stringify(dataUrl)};
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  return result.result.value;
};

await mkdir(assetsDir, { recursive: true });

const pngFiles = (await readdir(assetsDir))
  .filter((file) => file.endsWith(".png"))
  .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));

if (!pngFiles.length) {
  console.log(JSON.stringify({ ok: true, converted: 0, message: "Nenhum PNG encontrado em public/assets." }, null, 2));
  process.exit(0);
}

const browser = await findBrowser();
const debugPort = 9322 + Math.floor(Math.random() * 1000);
const userDataDir = path.join(os.tmpdir(), `nayanne-webp-${Date.now()}`);
await mkdir(userDataDir, { recursive: true });

const browserProcess = spawn(browser, [
  "--headless=new",
  "--disable-gpu",
  "--disable-extensions",
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${debugPort}`,
  `--user-data-dir=${userDataDir}`,
  "about:blank"
]);

try {
  await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
  const page = await openPage(debugPort);
  await page.send("Runtime.enable");

  const converted = [];
  for (const pngFile of pngFiles) {
    const sourcePath = path.join(assetsDir, pngFile);
    const targetFile = pngFile.replace(/\.png$/i, ".webp");
    const targetPath = path.join(assetsDir, targetFile);
    const bytes = await readFile(sourcePath);
    const result = await convertInBrowser(page, `data:image/png;base64,${bytes.toString("base64")}`);
    const webpBytes = Buffer.from(result.dataUrl.replace(/^data:image\/webp;base64,/, ""), "base64");
    await writeFile(targetPath, webpBytes);
    converted.push({
      file: targetFile,
      width: result.width,
      height: result.height,
      originalKb: Math.round(bytes.length / 1024),
      webpKb: Math.round(webpBytes.length / 1024)
    });
  }

  page.ws.close();
  console.log(JSON.stringify({ ok: true, quality, converted }, null, 2));
} finally {
  browserProcess.kill();
  await delay(800);
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}
