const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");
const { PassThrough } = require("stream");
const { PDFDocument } = require("pdf-lib"); 
//const selectedPages = [];  

const selectedPages = [];  
const splitToOcrConfig = {
  enabled: true, // toggle split-to-OCR mode
  pages: [] // specify individual pages to send (per file) - will be overridden by JSON results
};

// Path to JSON results folder
// Root folder containing JSON results (may include multiple subfolders such as "passport", "passport copy", etc.)
const jsonResultPath = path.join(__dirname, "jsonResult");

/**
 * Extract page numbers from JSON result filenames
 * Filename format: {baseFilename}_{pageNumber}__schema_passport.json
 * Example: 508807.pdf_19__schema_passport.json -> { baseFile: "508807.pdf", page: 19 }
 */
function extractPageNumbersFromJsonResults() {
  // Map: PDF filename -> { pages: number[], pageToDir: { pageNum: dir } }
  const pageMap = {};

  const collectJsonFilesRecursive = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    let files = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(collectJsonFilesRecursive(fullPath));
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".json") &&
        // accept any schema type, e.g. __schema_passport, __schema_amr, etc.
        entry.name.includes("__schema_")
      ) {
        files.push(fullPath);
      }
    }
    return files;
  };

  try {
    if (!fs.existsSync(jsonResultPath)) {
      console.warn(`JSON results folder not found: ${jsonResultPath}`);
      return pageMap;
    }

    const jsonFiles = collectJsonFilesRecursive(jsonResultPath);

    console.log(`\n=== Scanning JSON Results ===`);
    console.log(`Found ${jsonFiles.length} JSON result files`);

    for (const jsonFileFullPath of jsonFiles) {
      const jsonFile = path.basename(jsonFileFullPath);
      const relativeDir = path.relative(jsonResultPath, path.dirname(jsonFileFullPath)); // e.g., "passport"
      // Parse filename: 508807.pdf_19__schema_passport.json
      // Pattern: {baseFile}_{page}__schema_<type>.json
      // Match everything up to .pdf, then _pageNumber__schema_<schemaName>.json
      const match = jsonFile.match(/^(.+\.pdf)_(\d+)__schema_[^.]+\.json$/);

      if (match) {
        const baseFile = match[1]; // e.g., "508807.pdf"
        const pageNumber = parseInt(match[2], 10); // e.g., 19

        if (!pageMap[baseFile]) {
          pageMap[baseFile] = { pages: [], pageToDir: {} };
        }

        if (!pageMap[baseFile].pages.includes(pageNumber)) {
          pageMap[baseFile].pages.push(pageNumber);
        }

        // เก็บ folder สำหรับแต่ละหน้า
        pageMap[baseFile].pageToDir[pageNumber] = relativeDir;

        console.log(`  ${baseFile} -> page ${pageNumber} (${relativeDir})`);
      } else {
        console.warn(`  Could not parse filename: ${jsonFile}`);
      }
    }

    // Sort page numbers for each file
    for (const baseFile in pageMap) {
      pageMap[baseFile].pages.sort((a, b) => a - b);
    }

    console.log(`\n=== Page Mapping Summary ===`);
    for (const baseFile in pageMap) {
      const pages = pageMap[baseFile].pages;
      const pageToDir = pageMap[baseFile].pageToDir;
      console.log(`  ${baseFile}:`);
      for (const page of pages) {
        console.log(`    - page ${page} -> ${pageToDir[page]}`);
      }
    }
    console.log("============================\n");
  } catch (error) {
    console.error("Error reading JSON results:", error);
  }

  return pageMap;
}

/**
 * Recursively collect PDF files under a directory.
 * Returns paths relative to the source root so downstream logic can keep using path.join(source, relPath).
 */
function collectPdfFilesRecursive(dir, relativeBase = "") {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryRelativePath = path.join(relativeBase, entry.name);
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectPdfFilesRecursive(fullPath, entryRelativePath));
    } else if (
      entry.isFile() &&
      entry.name.toLowerCase().endsWith(".pdf") &&
      !entry.name.includes("desktop.ini")
    ) {
      files.push(entryRelativePath);
    }
  }

  return files;
}
//const webhookUrl = 	"https://aiflow-np.aigen.online/webhook-test/ricoh-webhook"
const webhookUrl = "https://playground2-3001.space.aigen.dev/webhook"
//const serviceUse = "ricoh_invoice"
//const serviceUse = "foodhouse"
//const serviceUse = "bla"
//const serviceUse = "malee_ocr"
const serviceUse = "custom_create_truth"
//const serviceUse = "bmw_classify"
//const serviceUse = "bmw_ocr"
//const serviceUse = "thaihonda_hospital"

const responseType = "webhook";

const source = path.join(__dirname, "01_PTG_FILE");
const destination = path.join(__dirname, "downloads/result");
const downloadsDir = path.join(__dirname, "downloads/ptg1");
// Remove file_name= from base PATH
const BASE_PATH = `https://playground2-3052.space.aigen.dev/workflow?action=process_document&channel=RPA_AppToOCR&content_encoding=binary&response_type=${responseType}&response_target=${encodeURIComponent(webhookUrl)}&service=${serviceUse}&file_name=`;
const AIGEN_API_KEY = "AGa135fgnbiz63ico4o219shi7hxlobu06";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_CONCURRENT_REQUESTS = 1;

// Ensure result and error directories exist
const createDirectory = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};
createDirectory(path.join(destination, "json"));
createDirectory(path.join(destination, "error"));
createDirectory(path.join(destination, "temp"));
createDirectory(downloadsDir);

const sanitizeFileName = (name = "") =>
  name.replace(/[<>:"/\\|?*\u0000]/g, "_");

const extractRequestId = (payload = {}) =>
  payload.request_id ||
  payload.requestId ||
  payload.data?.request_id ||
  payload.data?.requestId ||
  payload.data?.data?.request_id ||
  payload.data?.data?.requestId ||
  null;

// Function to extract specific pages from a PDF
async function extractPagesFromPdf(pdfPath, pageNumbers) {
  try {
    // Read the PDF file
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    // Create a new PDF document
    const newPdfDoc = await PDFDocument.create();
    
    // Copy the specified pages
    for (const pageNumber of pageNumbers) {
      // PDF pages are zero-based indexed
      const pageIndex = pageNumber - 1;
      if (pageIndex >= 0 && pageIndex < pdfDoc.getPageCount()) {
        const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [pageIndex]);
        newPdfDoc.addPage(copiedPage);
      } else {
        console.warn(`Page ${pageNumber} doesn't exist in the document (total pages: ${pdfDoc.getPageCount()})`);
      }
    }
    
    // Serialize the new PDF document
    const newPdfBytes = await newPdfDoc.save();
    
    return newPdfBytes;
  } catch (error) {
    console.error("Error extracting pages:", error);
    throw error;
  }
}

async function processFile(fileName, pageNumbers = [], targetSubdir = "") {
  try {
    if (fileName.includes("desktop.ini")) return;

    const filePath = path.join(source, fileName);
    const originalFileName = path.basename(fileName);
    let fileNameToEncode = originalFileName;
    let pageLabel = null;
    
    if (pageNumbers.length > 0) {
      pageLabel = pageNumbers.join("-");
      fileNameToEncode = `${originalFileName}_${pageLabel}`;
    }
    
    // Encode filename to base64 (keep extension + page suffix if any)
    const encodedFileName = Buffer.from(fileNameToEncode).toString('base64');
    
    // Create the full PATH with encoded filename
    const PATH = `${BASE_PATH}${encodedFileName}`;
    
    const fileNameWithoutExtension = pageNumbers.length > 0 
      ? `${path.parse(fileName).name}_pages_${pageNumbers.join("-")}`
      : path.parse(fileName).name; // For whole file processing
    
    // Check if we need to select specific pages
    let fileToSend;
    let fileSize;
    
    if (pageNumbers.length > 0) {
      // Extract specified pages
      console.log(`Extracting pages ${pageNumbers.join(", ")} from ${fileName}`);
      const extractedPdfBytes = await extractPagesFromPdf(filePath, pageNumbers);
      
      // Save the extracted PDF to a temporary file
      const tempFilePath = path.join(destination, "temp", `${fileNameWithoutExtension}.pdf`);
      fs.writeFileSync(tempFilePath, extractedPdfBytes);
      
      // Use the temporary file
      fileToSend = fs.createReadStream(tempFilePath);
      fileSize = extractedPdfBytes.length;
    } else {
      // Use the original file (whole file)
      fileToSend = fs.createReadStream(filePath);
      const stats = fs.statSync(filePath);
      fileSize = stats.size;
    }

    // Use PassThrough to prevent the stream from being in flowing mode
    const pass = new PassThrough();
    fileToSend.pipe(pass);

    const headers = {
      "x-aigen-key": AIGEN_API_KEY || "",
      "Content-Type": "application/pdf",
      "Content-Length": fileSize,
      "x-response-target-header": "ewogICAgIngtYXBpLWtleSI6ICJKMWhZcVoyX3FVNlp0S3V5TTdzMHhxWVluMHdZZFlKajl3R1pWYjliY1ZFIgp9"
    };

    console.log(`Sending file: ${fileNameToEncode} (Base64: ${encodedFileName})`);
    
    // Send file to server with encoded filename in URL
    const response = await axios.post(PATH, pass, { headers });
    
    let resultMessage = `Success: ${fileName}`;
    if (pageNumbers.length > 0) {
      resultMessage += ` (pages ${pageNumbers.join(", ")})`;
    }
    console.log(resultMessage);

    const requestId = extractRequestId(response.data);
    if (requestId) {
      // สร้าง folder ตาม parent folder ของ JSON (ถ้ามี) หรือใช้ downloadsDir เดิม
      const fileNameWithoutExt = path.parse(originalFileName).name;
      const parentDir = targetSubdir ? path.join(downloadsDir, targetSubdir) : downloadsDir;
      createDirectory(parentDir);
      
      const pendingBaseName =
        pageNumbers.length > 0 ? `${originalFileName}_${pageLabel}` : originalFileName;
      const pendingFileName = `${sanitizeFileName(pendingBaseName)}_${requestId}.json`;
      const pendingPath = path.join(parentDir, pendingFileName);
      const pendingPayload = {
        status: "pending",
        request_id: requestId,
        sent_file: originalFileName,
        page_numbers: pageNumbers,
        created_at: new Date().toISOString(),
        response_preview: response.data,
      };
      fs.writeFileSync(pendingPath, JSON.stringify(pendingPayload, null, 2));
      const logFolder = targetSubdir || ".";
      console.log(`Created pending file: ${pendingFileName} in folder: ${logFolder}`);
    } else {
      console.warn("No request_id found in response; pending file not created.");
    }

    // Save response to JSON
    const jsonFileName = pageNumbers.length > 0 
      ? `${fileNameWithoutExtension}_pages_${pageNumbers.join("-")}.json`
      : `${fileNameWithoutExtension}.json`;
    const jsonDir = targetSubdir
      ? path.join(destination, "json", targetSubdir)
      : path.join(destination, "json");
    createDirectory(jsonDir);
    const jsonPath = path.join(jsonDir, jsonFileName);
    fs.writeFileSync(jsonPath, JSON.stringify(response.data, null, 2));
  } catch (error) {
    let errorMessage = `Error processing file ${fileName}`;
    if (pageNumbers.length > 0) {
      errorMessage += ` (pages ${pageNumbers.join(", ")})`;
    }
    console.error(errorMessage, error);

    // Log error details
    const errorFileName = pageNumbers.length > 0
      ? `${fileName}_pages_${pageNumbers.join("-")}.error.log`
      : `${fileName}.error.log`;
    const errorDir = targetSubdir
      ? path.join(destination, "error", targetSubdir)
      : path.join(destination, "error");
    createDirectory(errorDir);
    const errorPath = path.join(errorDir, errorFileName);
    fs.writeFileSync(
      errorPath,
      JSON.stringify(error, Object.getOwnPropertyNames(error), 2)
    );
  }
}

// เพิ่มฟังก์ชันสำหรับการอ่านจำนวนหน้าของไฟล์ PDF
async function getPdfPageCount(pdfPath) {
  try {
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    return pdfDoc.getPageCount();
  } catch (error) {
    console.error(`Error getting page count for ${pdfPath}:`, error);
    return 0;
  }
}

// แสดงรายละเอียดของไฟล์ PDF ทั้งหมดพร้อมจำนวนหน้า
async function listAllPdfFiles() {
  console.log("\n=== รายการไฟล์ PDF ทั้งหมด ===");
  const files = collectPdfFilesRecursive(source);
  
  console.log(`พบไฟล์ PDF ทั้งหมด ${files.length} ไฟล์`);
  
  for (const file of files) {
    const filePath = path.join(source, file);
    const pageCount = await getPdfPageCount(filePath);
    console.log(`${file} - จำนวน ${pageCount} หน้า`);
  }
  console.log("============================\n");
  
  return files;
}

// ปรับปรุงฟังก์ชัน processFilesInBatches ให้รองรับการระบุหน้าเดียวกันสำหรับทุกไฟล์
async function processFilesInBatches(selectedPages = []) {
  // Extract page numbers from JSON results
  const pageMap = extractPageNumbersFromJsonResults();
  
  // แสดงรายการไฟล์ทั้งหมด
  const files = await listAllPdfFiles();
  
  const splitEnabled = splitToOcrConfig.enabled;
 
  if (splitEnabled) {
    console.log("\n=== Split-to-OCR Mode Enabled ===");
    
    // Separate files into those with JSON results and those without
    const filesToProcess = [];
    const filesToSkip = [];
    
    for (const fileName of files) {
      const baseName = path.basename(fileName);
      const fileData = pageMap[baseName] || {};
      const pagesToProcess = fileData.pages || [];
      const pageToDir = fileData.pageToDir || {};
      
      if (pagesToProcess.length === 0) {
        filesToSkip.push(fileName);
      } else {
        filesToProcess.push({ fileName, pages: pagesToProcess, pageToDir });
      }
    }
    
    console.log(`\nจำนวนไฟล์ทั้งหมด: ${files.length} ไฟล์`);
    console.log(`  - ไฟล์ที่จะประมวลผล: ${filesToProcess.length} ไฟล์`);
    console.log(`  - ไฟล์ที่จะข้าม: ${filesToSkip.length} ไฟล์`);
    
    if (filesToSkip.length > 0) {
      console.log(`\nไฟล์ที่จะข้าม (ไม่มีข้อมูลใน JSON results):`);
      filesToSkip.forEach(file => console.log(`  - ${file}`));
    }
    
    if (filesToProcess.length > 0) {
      console.log(`\nไฟล์ที่จะประมวลผล:`);
      filesToProcess.forEach(({ fileName, pages, pageToDir }) => {
        console.log(`  - ${fileName}:`);
        pages.forEach(page => {
          console.log(`      page ${page} -> ${pageToDir[page]}`);
        });
      });
    }
    
    console.log("=================================\n");
 
    // Process only files that have JSON results
    for (const { fileName, pages: pagesToProcess, pageToDir } of filesToProcess) {
      console.log(`\n--- แยกหน้าไฟล์ ${fileName} ---`);
      
      for (const pageNumber of pagesToProcess) {
        const targetSubdir = pageToDir[pageNumber] || "";
        console.log(`Processing page ${pageNumber} of ${fileName} -> folder: ${targetSubdir || 'root'}`);
        await processFile(fileName, [pageNumber], targetSubdir);
        await delay(1000);
      }
    }
    return;
  }
 
  if (selectedPages.length === 0) {
    console.log("ไม่มีการระบุหน้า จะประมวลผลทั้งไฟล์ (ทุกหน้า)"); 
    
    // Process each file with all its pages
    for (let i = 0; i < files.length; i += MAX_CONCURRENT_REQUESTS) {
      const batch = files
        .slice(i, i + MAX_CONCURRENT_REQUESTS)
        .map((fileName) => processFile(fileName, [])); // Empty array = whole file
      await Promise.all(batch);
      await delay(1000);
    }
    return;
  }
 
  // แสดงรายการไฟล์และหน้าที่จะประมวลผล
  console.log("\n=== รายการไฟล์และหน้าที่จะประมวลผล ===");
  console.log(`หน้าที่เลือกสำหรับทุกไฟล์: ${selectedPages.join(', ')}`);
  console.log(`จำนวนไฟล์ที่จะประมวลผล: ${files.length} ไฟล์`);
  for (const file of files) {
    console.log(`- ${file}`);
  }
  console.log("===============================\n");
 
  // ยืนยันการประมวลผล
  console.log("เริ่มประมวลผลไฟล์ตามที่ระบุ...\n");
 
  // Process files in batches to limit concurrent requests
  for (let i = 0; i < files.length; i += MAX_CONCURRENT_REQUESTS) {
    const batch = files
      .slice(i, i + MAX_CONCURRENT_REQUESTS)
      .map((fileName) => processFile(fileName, selectedPages));
    await Promise.all(batch);
    await delay(1000);
  }
}

// แทนที่การใช้ pageSelections object ด้วย array ของหน้าที่ต้องการ

// เริ่มการประมวลผล
processFilesInBatches(selectedPages).then(() => {
  console.log("ประมวลผลเสร็จสิ้น");
});
