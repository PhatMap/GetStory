import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const START_URL = "https://sangtacviet.app/truyen/dich/1/9559/740/";
const OUTPUT_DIR = "output";
const USER_DATA_DIR = ".browser-profile";
const PROGRESS_FILE = "progress.json";
const MAX_CHAPTERS = 2000;
const MAX_LOAD_ATTEMPTS = 2;
const CHAPTER_DELAY_MIN_MS = 0;
const CHAPTER_DELAY_MAX_MS = 0;
const BATCH_SIZE_BEFORE_PAUSE = 3;
const BATCH_PAUSE_MIN_MS = 0;
const BATCH_PAUSE_MAX_MS = 0;
const CAPTCHA_COOLDOWN_MIN_MS = 0;
const CAPTCHA_COOLDOWN_MAX_MS = 0;
const MANUAL_RETRY_INTERVAL_MS = 3000;
const READCHAPTER_TIMEOUT_MS = 8000;
const CONTENT_SELECTORS = [
  ".chapter-content",
  "#chapter-content",
  ".contentbox",
  ".box_doc",
  ".reading-content",
  ".chapter-body",
  '[id*="content"]',
  '[class*="content"]',
];
const SITE_ONLY_TITLES = new Set([
  "sang tac viet",
  "nen tang van hoc mang mo moi",
]);
const BLOCK_KEYWORDS = [
  "captcha",
  "cloudflare",
  "verify you are human",
  "attention required",
  "checking your browser",
  "security check",
  "anti bot",
  "robot",
  "are you human",
  "i am human",
  "xac minh ban la nguoi",
  "vui long xac minh",
];

function sanitizeFileName(input) {
  const cleaned = (input || "untitled")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.slice(0, 120) || "untitled";
}

function randomBetween(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return 0;
  }

  const lower = Math.max(0, Math.min(min, max));
  const upper = Math.max(lower, Math.max(min, max));
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

async function sleep(ms) {
  const duration = Math.max(0, Number(ms) || 0);

  if (duration === 0) {
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, duration));
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0 && seconds > 0) {
    return `${minutes} phut ${seconds} giay`;
  }

  if (minutes > 0) {
    return `${minutes} phut`;
  }

  return `${seconds} giay`;
}

async function waitRandomDelay(min, max, reason) {
  const delayMs = randomBetween(min, max);

  if (delayMs <= 0) {
    return;
  }

  if (reason) {
    console.log(`${reason} ${formatDuration(delayMs)}...`);
  }

  await sleep(delayMs);
}

function normalizeLooseText(text) {
  return (text || "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function extractChapterName(title) {
  const rawTitle = (title || "Untitled").replace(/\s+/g, " ").trim();
  const parts = rawTitle
    .split(/\s(?:\||-|–|—)\s/g)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) {
    return rawTitle;
  }

  const firstPart = parts[0];
  const normalizedFirstPart = normalizeLooseText(firstPart);
  const isBareChapterLabel =
    /^(chuong|chapter|hoi|tap|quyen|phan|episode|ep)\s*[\divxlcdm]+$/i.test(
      normalizedFirstPart,
    );

  if (isBareChapterLabel && parts[1]) {
    return `${firstPart} - ${parts[1]}`;
  }

  return firstPart;
}

function parseChapterUrl(chapterUrl) {
  try {
    const parsedUrl = new URL(chapterUrl);
    const match = parsedUrl.pathname.match(
      /^\/truyen\/([^/]+)\/\d+\/(\d+)\/(\d+)\/?$/i,
    );

    if (!match) {
      return null;
    }

    return {
      origin: parsedUrl.origin,
      bookhost: match[1],
      bookid: match[2],
      chapterid: match[3],
    };
  } catch {
    return null;
  }
}

function isValidChapterId(chapterId) {
  const normalized = String(chapterId ?? "").trim();
  return Boolean(normalized && /^\d+$/.test(normalized) && normalized !== "0");
}

function buildChapterUrl(origin, bookhost, bookid, chapterid) {
  if (!origin || !bookhost || !bookid || !isValidChapterId(chapterid)) {
    return null;
  }

  return new URL(`/truyen/${bookhost}/1/${bookid}/${chapterid}/`, origin).href;
}

function isSameBook(leftUrl, rightUrl) {
  const left = parseChapterUrl(leftUrl);
  const right = parseChapterUrl(rightUrl);

  return Boolean(
    left &&
    right &&
    left.bookhost === right.bookhost &&
    left.bookid === right.bookid,
  );
}

function normalizeChapterUrl(candidateUrl, referenceUrl = null) {
  if (!candidateUrl || candidateUrl === "about:blank") {
    return null;
  }

  try {
    const resolvedUrl = referenceUrl
      ? new URL(candidateUrl, referenceUrl).href
      : new URL(candidateUrl).href;
    const parsedUrl = parseChapterUrl(resolvedUrl);

    if (!parsedUrl || !isValidChapterId(parsedUrl.chapterid)) {
      return null;
    }

    if (referenceUrl && !isSameBook(resolvedUrl, referenceUrl)) {
      return null;
    }

    return resolvedUrl;
  } catch {
    return null;
  }
}

function parseReadChapterPayload(rawText) {
  if (!rawText) {
    return null;
  }

  try {
    return JSON.parse(rawText);
  } catch {
    const jsonStart = rawText.indexOf('{"');

    if (jsonStart < 0) {
      return null;
    }

    try {
      return JSON.parse(rawText.slice(jsonStart));
    } catch {
      return null;
    }
  }
}

async function buildOutputPath(title) {
  const baseName = sanitizeFileName(title);
  let attempt = 0;

  while (true) {
    const suffix = attempt === 0 ? "" : ` (${attempt + 1})`;
    const candidate = path.join(OUTPUT_DIR, `${baseName}${suffix}.txt`);

    try {
      await fs.access(candidate);
      attempt += 1;
    } catch {
      return candidate;
    }
  }
}

async function loadProgress() {
  try {
    const rawText = await fs.readFile(PROGRESS_FILE, "utf8");
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

async function saveProgress(progress) {
  await fs.writeFile(
    PROGRESS_FILE,
    JSON.stringify(
      {
        ...progress,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
}

function hasBlockedKeyword(text) {
  const normalized = normalizeLooseText(text);
  return BLOCK_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function isBlockedChapter(chapter) {
  const chapterName = extractChapterName(chapter.title);
  const normalizedTitle = normalizeLooseText(chapterName);

  if (SITE_ONLY_TITLES.has(normalizedTitle)) {
    return true;
  }

  if (hasBlockedKeyword(chapter.title) || hasBlockedKeyword(chapter.url)) {
    return true;
  }

  const previewContent = (chapter.content || "").slice(0, 3000);
  return hasBlockedKeyword(previewContent);
}

async function closeExtraPages(context, protectedPages = []) {
  const keepPages = new Set(
    (Array.isArray(protectedPages) ? protectedPages : [protectedPages]).filter(
      Boolean,
    ),
  );

  for (const openPage of context.pages()) {
    if (keepPages.has(openPage) || openPage.isClosed()) {
      continue;
    }

    const popupUrl = openPage.url() || "about:blank";

    try {
      await openPage.close();
      console.log(`Da dong tab phu: ${popupUrl}`);
    } catch {
      console.log(`Khong dong duoc tab phu: ${popupUrl}`);
    }
  }
}

function isUsableChapter(chapter) {
  return Boolean(
    chapter?.content &&
      chapter.content.length >= 100 &&
      normalizeChapterUrl(chapter.url),
  );
}

function buildStopResult(page, url, reason, detail = null) {
  if (detail) {
    console.log(`Dung tai ${url}: ${reason} (${detail}).`);
  } else {
    console.log(`Dung tai ${url}: ${reason}.`);
  }

  return {
    chapter: null,
    page,
    stopReason: reason,
    stopDetail: detail,
  };
}

async function waitForManualResume(page, url, reason) {
  console.log(
    `${reason}: ${url}. Giu nguyen tab hien tai de ban xu ly tay. Neu muon dung thi dong tab/browser hoac Ctrl+C.`,
  );

  while (true) {
    if (!page || page.isClosed()) {
      return buildStopResult(page, url, "manual_stop", "tab_da_dong");
    }

    await page.waitForTimeout(MANUAL_RETRY_INTERVAL_MS);
    const chapter = await extractChapter(page).catch(() => null);

    if (!chapter) {
      continue;
    }

    if (isUsableChapter(chapter) && !isBlockedChapter(chapter)) {
      return { chapter, page };
    }

    if (!isBlockedChapter(chapter)) {
      return { chapter: null, page };
    }
  }
}

async function waitForReadChapterPayload(page, chapterUrl) {
  const expectedChapter = parseChapterUrl(chapterUrl);

  const response = await page.waitForResponse(
    (candidate) => {
      try {
        const responseUrl = new URL(candidate.url());

        if (
          responseUrl.pathname !== "/index.php" ||
          responseUrl.searchParams.get("sajax") !== "readchapter"
        ) {
          return false;
        }

        if (!expectedChapter) {
          return true;
        }

        return (
          responseUrl.searchParams.get("h") === expectedChapter.bookhost &&
          responseUrl.searchParams.get("bookid") === expectedChapter.bookid &&
          responseUrl.searchParams.get("c") === expectedChapter.chapterid
        );
      } catch {
        return false;
      }
    },
    { timeout: READCHAPTER_TIMEOUT_MS },
  );

  const payload = parseReadChapterPayload(await response.text());
  return payload;
}

async function convertChapterHtmlToText(page, html) {
  return await page.evaluate((rawHtml) => {
    function cleanupText(text) {
      return (text || "")
        .replace(/\u00a0/g, " ")
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }

    function extractStructuredText(root) {
      const blockTags = new Set([
        "ADDRESS",
        "ARTICLE",
        "ASIDE",
        "BLOCKQUOTE",
        "BR",
        "DD",
        "DIV",
        "DL",
        "DT",
        "FIELDSET",
        "FIGCAPTION",
        "FIGURE",
        "FOOTER",
        "FORM",
        "H1",
        "H2",
        "H3",
        "H4",
        "H5",
        "H6",
        "HEADER",
        "HR",
        "LI",
        "MAIN",
        "NAV",
        "OL",
        "P",
        "PRE",
        "SECTION",
        "TABLE",
        "TBODY",
        "TD",
        "TFOOT",
        "TH",
        "THEAD",
        "TR",
        "UL",
      ]);
      const parts = [];

      function pushText(value) {
        if (value) {
          parts.push(value);
        }
      }

      function lastChunkEndsWithNewline() {
        return parts.length > 0 && /\n$/.test(parts[parts.length - 1]);
      }

      function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          pushText(node.textContent || "");
          return;
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
          return;
        }

        const el = node;
        const tagName = el.tagName.toUpperCase();

        if (tagName === "BR") {
          pushText("\n");
          return;
        }

        const isBlock = blockTags.has(tagName);

        if (isBlock && !lastChunkEndsWithNewline()) {
          pushText("\n");
        }

        for (const child of el.childNodes) {
          walk(child);
        }

        if (isBlock) {
          pushText("\n\n");
        }
      }

      for (const child of root.childNodes) {
        walk(child);
      }

      return parts.join("");
    }

    function restoreParagraphs(text) {
      const normalized = cleanupText(text);
      const nonEmptyLines = normalized
        .split("\n")
        .filter((line) => line.trim().length > 0);

      if (normalized.length < 800 || nonEmptyLines.length > 6) {
        return normalized;
      }

      return cleanupText(
        normalized
          .replace(/([.!?…]["'”’»]*)(?=\p{Lu}|[“"'(\[])/gu, "$1\n\n")
          .replace(/([:;]["'”’»]*)(?=\p{Lu}|[“"'(\[])/gu, "$1\n"),
      );
    }

    const sourceHtml =
      typeof window.preprocess === "function"
        ? window.preprocess(rawHtml || "")
        : rawHtml || "";

    const wrapper = document.createElement("div");
    wrapper.innerHTML = sourceHtml;

    const structuredText = cleanupText(extractStructuredText(wrapper));
    const fallbackText = cleanupText(
      wrapper.innerText || wrapper.textContent || "",
    );
    const lineCount = (text) =>
      text.split("\n").filter((line) => line.trim().length > 0).length;
    const preferredText =
      lineCount(structuredText) >= lineCount(fallbackText)
        ? structuredText
        : fallbackText;

    return restoreParagraphs(preferredText);
  }, html);
}

async function getNavigationLinks(page) {
  return await page.evaluate(() => ({
    nextHref: document.getElementById("navnexttop")?.href || null,
    prevHref: document.getElementById("navprevtop")?.href || null,
  }));
}

async function extractChapterFromPayload(page, chapterUrl, payload) {
  const normalizedChapterUrl = normalizeChapterUrl(chapterUrl, chapterUrl);
  const parsedChapterUrl = parseChapterUrl(chapterUrl);
  const origin = parsedChapterUrl?.origin ?? new URL(chapterUrl).origin;
  const bookhost = payload.bookhost || parsedChapterUrl?.bookhost;
  const bookid = String(payload.bookid || parsedChapterUrl?.bookid || "");
  const title = payload.chaptername || payload.bookname || "Untitled";
  const content = await convertChapterHtmlToText(page, payload.data || "");
  const navigationLinks = await getNavigationLinks(page);

  let nextId = String(payload.next ?? "");
  let prevId = String(payload.prev ?? "");
  const numericNext = Number(nextId);
  const numericPrev = Number(prevId);

  if (
    bookhost !== "qidian" &&
    Number.isFinite(numericNext) &&
    Number.isFinite(numericPrev) &&
    numericNext < numericPrev
  ) {
    [nextId, prevId] = [prevId, nextId];
  }

  const nextHref =
    normalizeChapterUrl(
      buildChapterUrl(origin, bookhost, bookid, nextId) ||
        navigationLinks.nextHref,
      chapterUrl,
    ) || null;
  const prevHref =
    normalizeChapterUrl(
      buildChapterUrl(origin, bookhost, bookid, prevId) ||
        navigationLinks.prevHref,
      chapterUrl,
    ) || null;

  return {
    title,
    chapterName: extractChapterName(title),
    content,
    url: normalizedChapterUrl || chapterUrl,
    nextHref,
    prevHref,
  };
}

async function loadChapterWithRecovery(
  page,
  context,
  url,
  protectedPages = [],
) {
  let activePage = page;
  let attempt = 0;

  while (true) {
    if (!activePage) {
      activePage = await context.newPage();
    } else if (activePage.isClosed()) {
      return buildStopResult(activePage, url, "manual_stop", "tab_da_dong");
    }

    await closeExtraPages(context, [activePage, ...protectedPages]);
    const readChapterPromise = waitForReadChapterPayload(activePage, url).catch(
      () => null,
    );

    if (activePage.url() !== url) {
      await activePage.goto(url, { waitUntil: "domcontentloaded" });
    } else {
      await activePage.reload({ waitUntil: "domcontentloaded" });
    }

    const payload = await readChapterPromise;
    await closeExtraPages(context, [activePage, ...protectedPages]);

    if (payload) {
      const payloadCode = String(payload.code ?? "0");

      if (payloadCode === "0") {
        const chapter = await extractChapterFromPayload(
          activePage,
          url,
          payload,
        );
        const hasUsableContent =
          chapter.content && chapter.content.length >= 100;

        if (hasUsableContent && !isBlockedChapter(chapter)) {
          return { chapter, page: activePage };
        }
      } else if (payloadCode === "21") {
        const resumed = await waitForManualResume(
          activePage,
          url,
          "Phat hien captcha/popup",
        );
        if (resumed.stopReason) {
          return resumed;
        }
        if (resumed.chapter) {
          return resumed;
        }
        attempt = 0;
        continue;
      } else if (payloadCode === "12" || payloadCode === "13") {
        const resumed = await waitForManualResume(
          activePage,
          url,
          "Can dang nhap lai",
        );
        if (resumed.stopReason) {
          return resumed;
        }
        if (resumed.chapter) {
          return resumed;
        }
        attempt = 0;
        continue;
      } else {
        const reason = payload.err || payload.info || `code ${payloadCode}`;
        console.log(`Phan hoi doc chuong chua dung: ${reason}`);
      }
    }

    await activePage.waitForTimeout(250);
    const chapter = await extractChapter(activePage);
    const hasUsableContent = chapter.content && chapter.content.length >= 100;

    if (hasUsableContent && !isBlockedChapter(chapter)) {
      return { chapter, page: activePage };
    }

    if (isBlockedChapter(chapter)) {
      const resumed = await waitForManualResume(
        activePage,
        url,
        "Phat hien captcha/popup",
      );
      if (resumed.stopReason) {
        return resumed;
      }
      if (resumed.chapter) {
        return resumed;
      }
      attempt = 0;
      continue;
    }

    attempt += 1;
    console.log(
      `Khong lay duoc noi dung hop le, thu lai lan ${attempt}/${MAX_LOAD_ATTEMPTS}: ${url}`,
    );

    if (attempt >= MAX_LOAD_ATTEMPTS) {
      return buildStopResult(
        activePage,
        url,
        "load_failed",
        `${MAX_LOAD_ATTEMPTS} lan deu khong lay duoc noi dung`,
      );
    }
  }
}

async function extractChapter(page) {
  return await page.evaluate((selectors) => {
    const title =
      document.querySelector("h1")?.innerText?.trim() ||
      document.title?.trim() ||
      "Untitled";

    let content = "";

    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.innerText.trim().length > 200) {
        content = el.innerText.trim();
        break;
      }
    }

    if (!content) {
      const blocks = [...document.querySelectorAll("div, article, section")]
        .map((el) => ({ text: el.innerText?.trim() || "" }))
        .sort((a, b) => b.text.length - a.text.length);

      content = blocks[0]?.text || "";
    }

    function normalizeText(text) {
      return (text || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/\u0111/g, "d")
        .replace(/\s+/g, " ")
        .trim();
    }

    function findNextHref() {
      const links = [...document.querySelectorAll("a")];
      const next = links.find((a) => {
        const t = normalizeText(a.innerText || a.textContent || "");
        if (
          t.includes("chuong sau") ||
          t.includes("tiep theo") ||
          t.includes("ke tiep") ||
          t === "sau" ||
          t.includes("next")
        ) {
          return true;
        }
        return (
          t.includes("chương sau") || t.includes("next") || t.includes("sau")
        );
      });
      return next?.href || null;
    }

    return {
      title,
      content,
      nextHref: findNextHref(),
      url: location.href,
    };
  }, CONTENT_SELECTORS);
}

if (START_URL === "DAN_LINK_CHUONG_DAU") {
  throw new Error(
    "Hay sua START_URL thanh link chuong dau tien truoc khi chay.",
  );
}

await fs.mkdir(OUTPUT_DIR, { recursive: true });
const savedProgress = await loadProgress();
const savedNextUrl = normalizeChapterUrl(savedProgress?.nextUrl, START_URL);
const resumeUrl = savedNextUrl || START_URL;

if (savedProgress?.nextUrl && !savedNextUrl) {
  console.log(
    `Bo qua nextUrl khong hop le trong progress: ${savedProgress.nextUrl}`,
  );
}

if (
  savedProgress?.finished &&
  !savedNextUrl &&
  savedProgress?.startUrl === START_URL
) {
  console.log("Lan chay truoc da dung o chuong cuoi hop le.");
  console.log("Neu co chuong moi, hay cap nhat START_URL roi chay lai.");
  process.exit(0);
}

const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: false,
});
let page = context.pages()[0] ?? (await context.newPage());

await page.goto(resumeUrl, { waitUntil: "domcontentloaded" });

// đăng nhập tay nếu cần
console.log("Dang dung session trong .browser-profile neu con hieu luc.");
console.log("Script se chay lien tuc, gap captcha/login thi dong va dung ngay.");

const visited = new Set();
let currentUrl = resumeUrl;
let savedCount = Number(savedProgress?.savedCount || 0);
let sessionSavedCount = 0;
let lastSavedUrl = normalizeChapterUrl(savedProgress?.lastSavedUrl, START_URL);
let lastChapterName = savedProgress?.lastChapterName || null;
let stopReason = null;
let stopDetail = null;

if (resumeUrl !== START_URL) {
  console.log(`Dang tiep tuc tu chuong dang do: ${resumeUrl}`);
}
while (savedCount < MAX_CHAPTERS && currentUrl && !visited.has(currentUrl)) {
  visited.add(currentUrl);

  const recovered = await loadChapterWithRecovery(page, context, currentUrl);
  page = recovered.page;
  stopReason = recovered.stopReason || null;
  stopDetail = recovered.stopDetail || null;

  if (stopReason) {
    await saveProgress({
      startUrl: START_URL,
      nextUrl: currentUrl,
      lastSavedUrl,
      lastChapterName,
      savedCount,
      finished: false,
      stopReason,
      stopDetail,
    });
    break;
  }
  const chapter = recovered.chapter || { url: currentUrl };

  if (!isUsableChapter(chapter)) {
    stopReason = "invalid_chapter";
    stopDetail = chapter.url || currentUrl;
    console.log(`Bỏ qua vì content quá ngắn: ${chapter.url}`);
    break;
  }

  const chapterName = extractChapterName(chapter.title);
  const outputPath = await buildOutputPath(chapterName);
  const fileContent = `${chapterName}\n\n${chapter.content}\n`;

  await fs.writeFile(outputPath, fileContent, "utf8");
  const i = ++savedCount;
  console.log(`Da luu: ${outputPath}`);
  console.log(`Đã lấy: ${i} - ${chapterName}`);

  lastSavedUrl = chapter.url;
  lastChapterName = chapterName;
  currentUrl = normalizeChapterUrl(chapter.nextHref, chapter.url);

  if (!currentUrl) {
    console.log("Khong tim thay link chuong tiep theo hop le. Dung lai.");
  }
  await saveProgress({
    startUrl: START_URL,
    nextUrl: currentUrl,
    lastSavedUrl,
    lastChapterName,
    savedCount,
    stopReason: null,
    stopDetail: null,
  });

  await closeExtraPages(context, [page]);
  sessionSavedCount += 1;

  if (sessionSavedCount % BATCH_SIZE_BEFORE_PAUSE === 0) {
    await waitRandomDelay(
      BATCH_PAUSE_MIN_MS,
      BATCH_PAUSE_MAX_MS,
      `Da lay ${sessionSavedCount} chuong trong phien nay, tam nghi`,
    );
  } else {
    await waitRandomDelay(
      CHAPTER_DELAY_MIN_MS,
      CHAPTER_DELAY_MAX_MS,
      "Cho truoc khi qua chuong tiep theo trong",
    );
  }
}

await saveProgress({
  startUrl: START_URL,
  nextUrl: currentUrl,
  lastSavedUrl,
  lastChapterName,
  savedCount,
  finished:
    !stopReason &&
    (!currentUrl || visited.has(currentUrl) || savedCount >= MAX_CHAPTERS),
  stopReason,
  stopDetail,
});

await context.close();

console.log(`Xong. Cac file nam trong thu muc: ${OUTPUT_DIR}`);
