import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const targetUrl = process.argv[2] ?? "http://localhost:4174";
const root = path.resolve(process.cwd());
const reportDir = path.join(root, "reports");

const chromeCandidates = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
];

const findBrowser = async () => {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }

  throw new Error("Chrome ou Edge nao encontrado para validacao visual.");
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const waiters = [];
  const events = [];
  let nextId = 1;

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}: ${message.error.data ?? ""}`));
      else resolve(message.result ?? {});
      return;
    }

    if (message.method) {
      events.push(message);
      for (const waiter of [...waiters]) {
        if (waiter.method === message.method) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message.params ?? {});
        }
      }
    }
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
      }, 15000);
    });
  };

  const waitForEvent = (method, timeoutMs = 15000) =>
    new Promise((resolve, reject) => {
      const waiter = { method, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`Timeout aguardando evento ${method}`));
      }, timeoutMs);
    });

  return { ws, send, waitForEvent, events };
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

const runViewportCheck = async ({ label, width, height, mobile }, debugPort) => {
  const page = await openPage(debugPort);
  const errors = [];

  page.events.push = new Proxy(page.events.push, {
    apply(target, thisArg, args) {
      const event = args[0];
      if (event?.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(event.params?.type)) {
        errors.push({
          type: event.params.type,
          text: event.params.args?.map((arg) => arg.value ?? arg.description ?? "").join(" ")
        });
      }
      if (event?.method === "Runtime.exceptionThrown") {
        errors.push({
          type: "exception",
          text: event.params?.exceptionDetails?.text ?? "Runtime exception"
        });
      }
      if (event?.method === "Log.entryAdded" && ["error", "warning"].includes(event.params?.entry?.level)) {
        errors.push({
          type: event.params.entry.level,
          text: event.params.entry.text
        });
      }
      return Reflect.apply(target, thisArg, args);
    }
  });

  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Network.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: mobile ? 2 : 1,
    mobile
  });

  const loadEvent = page.waitForEvent("Page.loadEventFired");
  await page.send("Page.navigate", { url: targetUrl });
  await loadEvent;

  await page.send("Runtime.evaluate", {
    expression: `
      [...document.images].forEach((image) => {
        image.loading = "eager";
        image.decoding = "sync";
      });
    `
  });

  await page.send("Runtime.evaluate", {
    expression: `
      new Promise(async (resolve) => {
        for (let y = 0; y <= document.documentElement.scrollHeight; y += Math.max(240, window.innerHeight * 0.75)) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 140));
        }
        window.scrollTo(0, 0);
        await Promise.all([...document.images].map((image) => {
          if (image.complete && image.naturalWidth > 0) return true;
          return new Promise((done) => {
            image.addEventListener("load", done, { once: true });
            image.addEventListener("error", done, { once: true });
          });
        }));
        await new Promise((r) => setTimeout(r, 260));
        resolve(true);
      })
    `,
    awaitPromise: true
  });

  const metricsResult = await page.send("Runtime.evaluate", {
    expression: `(() => {
      const doc = document.documentElement;
      const body = document.body;
      const images = [...document.images];
      const anchors = [...document.querySelectorAll("a.hotspot, .faq-dialog__cta")];
      const allHotspots = [...document.querySelectorAll(".hotspot")];
      const faqButtons = [...document.querySelectorAll("[data-faq]")];
      const brokenLinks = anchors
        .map((anchor) => anchor.href)
        .filter((href) => !href || href === "#" || href.includes("undefined"));

      return {
        title: document.title,
        sections: document.querySelectorAll(".template-section").length,
        hotspots: allHotspots.length,
        images: images.length,
        loadedImages: images.filter((image) => image.complete && image.naturalWidth > 0).length,
        clientWidth: doc.clientWidth,
        scrollWidth: Math.max(doc.scrollWidth, body.scrollWidth),
        innerWidth: window.innerWidth,
        documentHeight: doc.scrollHeight,
        horizontalOverflow: Math.max(doc.scrollWidth, body.scrollWidth) - doc.clientWidth,
        brokenLinks,
        faqButtons: faqButtons.map((button) => button.dataset.faq),
        whatsappLinks: anchors.filter((anchor) => anchor.href.includes("wa.me/5577998050796")).length,
        instagramLinks: anchors.filter((anchor) => anchor.href.includes("instagram.com/nayannelisadvocacia")).length
      };
    })()`,
    returnByValue: true
  });

  const faqResult = await page.send("Runtime.evaluate", {
    expression: `new Promise(async (resolve) => {
      const dialog = document.querySelector("#faq-dialog");
      const title = document.querySelector("#faq-dialog-title");
      const answer = document.querySelector("#faq-dialog-answer");
      const results = [];

      for (const button of document.querySelectorAll("[data-faq]")) {
        button.click();
        await new Promise((done) => setTimeout(done, 80));
        results.push({
          key: button.dataset.faq,
          open: Boolean(dialog?.open),
          title: title?.textContent?.trim() ?? "",
          answerLength: answer?.textContent?.trim()?.length ?? 0
        });
        dialog?.close?.();
      }

      resolve(results);
    })`,
    awaitPromise: true,
    returnByValue: true
  });

  await page.send("Runtime.evaluate", {
    expression: "document.activeElement?.blur?.(); window.scrollTo(0, 0); new Promise((resolve) => setTimeout(resolve, 180));",
    awaitPromise: true
  });

  const screenshotResult = await page.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: true,
    clip: {
      x: 0,
      y: 0,
      width,
      height,
      scale: 1
    }
  });
  const screenshotPath = path.join(reportDir, `browser-check-${label}.png`);
  await writeFile(screenshotPath, Buffer.from(screenshotResult.data, "base64"));
  page.ws.close();

  return {
    label,
    viewport: { width, height, mobile },
    ...metricsResult.result.value,
    consoleIssues: errors,
    faqResults: faqResult.result.value,
    screenshot: screenshotPath
  };
};

await mkdir(reportDir, { recursive: true });

const browser = await findBrowser();
const debugPort = 9222 + Math.floor(Math.random() * 1000);
const userDataDir = await mkdtemp(path.join(os.tmpdir(), "nayanne-browser-check-"));
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
  const checks = [];
  checks.push(await runViewportCheck({ label: "desktop", width: 1440, height: 1100, mobile: false }, debugPort));
  checks.push(await runViewportCheck({ label: "mobile", width: 390, height: 844, mobile: true }, debugPort));

  const failures = checks.flatMap((check) => {
    const issues = [];
    if (check.sections !== 12) issues.push(`${check.label}: secoes=${check.sections}`);
    if (check.loadedImages !== 12) issues.push(`${check.label}: imagens carregadas=${check.loadedImages}`);
    if (check.horizontalOverflow > 1) issues.push(`${check.label}: overflow horizontal=${check.horizontalOverflow}`);
    if (check.brokenLinks.length) issues.push(`${check.label}: links quebrados=${check.brokenLinks.join(", ")}`);
    if (check.faqButtons.length !== 5) issues.push(`${check.label}: faqs selecionaveis=${check.faqButtons.length}`);
    if (check.faqResults.some((faq) => !faq.open || faq.answerLength < 40)) {
      issues.push(`${check.label}: algum FAQ nao abriu resposta completa`);
    }
    if (check.consoleIssues.some((issue) => issue.type === "error" || issue.type === "exception")) {
      issues.push(`${check.label}: erros no console`);
    }
    return issues;
  });

  const report = { ok: failures.length === 0, targetUrl, browser, checks, failures };
  await writeFile(path.join(reportDir, "browser-check.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (failures.length) {
    process.exitCode = 1;
  }
} finally {
  browserProcess.kill();
  await delay(800);
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}
