import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import {
  cwd,
  env as processEnv,
  stdin as terminalInput,
  stdout as terminalOutput,
} from "node:process";

const RESULT_DIR_NAME = "result";

function sanitizeFileName(input) {
  const cleaned = (input || "merged")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned || "merged";
}

function resolveInputDir(inputPath) {
  const normalized = (inputPath || "").trim();
  if (!normalized) {
    return null;
  }

  return path.resolve(cwd(), normalized);
}

async function ensureReadableDirectory(targetDir) {
  try {
    const stat = await fs.stat(targetDir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function promptForSourceDirectory() {
  const envDir = resolveInputDir(processEnv.SOURCE_DIR || "");
  if (envDir && (await ensureReadableDirectory(envDir))) {
    return envDir;
  }

  const rl = readline.createInterface({
    input: terminalInput,
    output: terminalOutput,
  });

  try {
    while (true) {
      const answer = (await rl.question(
        "Nhap thu muc chua cac chuong .txt (duong dan tuyet doi hoac tuong doi): ",
      )).trim();

      if (!answer) {
        console.log("Ban can nhap duong dan thu muc.");
        continue;
      }

      const targetDir = resolveInputDir(answer);
      if (!targetDir) {
        console.log("Thu muc khong hop le, vui long thu lai.");
        continue;
      }

      if (await ensureReadableDirectory(targetDir)) {
        return targetDir;
      }

      console.log(`Khong tim thay thu muc hop le: ${targetDir}`);
    }
  } finally {
    rl.close();
  }
}

async function collectTxtFilesRecursively(targetDir) {
  const results = [];
  const stack = [targetDir];
  const resultDirPath = path.resolve(cwd(), RESULT_DIR_NAME);

  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (path.resolve(fullPath) === resultDirPath) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".txt") {
        results.push(fullPath);
      }
    }
  }

  return results;
}

function extractChapterOrderFromName(filePath) {
  const baseName = path.basename(filePath, path.extname(filePath));
  const normalizedBaseName = baseName
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\u0111/g, "d")
    .replace(/\u0110/g, "D")
    .toLowerCase();
  const chapterMatch = normalizedBaseName.match(/(?:chuong|chapter)\s*(\d+)/i);
  if (chapterMatch) {
    return Number(chapterMatch[1]);
  }

  const anyNumber = baseName.match(/\d+/);
  if (anyNumber) {
    return Number(anyNumber[0]);
  }

  return Number.POSITIVE_INFINITY;
}

function sortChapterFiles(filePaths) {
  return [...filePaths].sort((left, right) => {
    const leftOrder = extractChapterOrderFromName(left);
    const rightOrder = extractChapterOrderFromName(right);

    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }

    const leftBase = path.basename(left);
    const rightBase = path.basename(right);
    return leftBase.localeCompare(rightBase, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

function buildOutputFilePath(sourceDir) {
  const resultDir = path.resolve(cwd(), RESULT_DIR_NAME);
  const safeDirName = sanitizeFileName(path.basename(sourceDir));
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputName = `${safeDirName}-${timestamp}.txt`;

  return {
    resultDir,
    outputPath: path.join(resultDir, outputName),
  };
}

async function mergeTextFiles(sourceDir, sortedFiles, outputPath) {
  const chunks = [];
  let mergedCount = 0;

  for (const filePath of sortedFiles) {
    const content = await fs.readFile(filePath, "utf8");
    const trimmed = content.trim();

    if (!trimmed) {
      continue;
    }

    chunks.push(trimmed);
    mergedCount += 1;
  }

  const mergedContent = chunks.join("\n\n\n");
  await fs.writeFile(outputPath, mergedContent, "utf8");

  return {
    mergedCount,
    sourceDir,
    outputPath,
  };
}

async function main() {
  const sourceDir = await promptForSourceDirectory();
  console.log(`Dang quet thu muc: ${sourceDir}`);

  const allTxtFiles = await collectTxtFilesRecursively(sourceDir);
  if (allTxtFiles.length === 0) {
    console.log("Khong tim thay file .txt nao de gop.");
    return;
  }

  const sortedFiles = sortChapterFiles(allTxtFiles);
  const { resultDir, outputPath } = buildOutputFilePath(sourceDir);
  await fs.mkdir(resultDir, { recursive: true });

  const result = await mergeTextFiles(sourceDir, sortedFiles, outputPath);
  console.log(`Da quet: ${allTxtFiles.length} file .txt`);
  console.log(`Da gop: ${result.mergedCount} file co noi dung`);
  console.log(`File ket qua: ${result.outputPath}`);
}

main().catch((error) => {
  console.error("Co loi khi gop chuong:", error?.message || error);
  process.exitCode = 1;
});
