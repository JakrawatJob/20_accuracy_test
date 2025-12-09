const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");
const { PassThrough } = require("stream");
const { PDFDocument } = require("pdf-lib"); 
//const selectedPages = [];  

const selectedPages = [];  
const splitToOcrConfig = {
  enabled: true, // toggle split-to-OCR mode
  pages: [1] // specify individual pages to send (per file)
};
//const webhookUrl = 	"https://aiflow-np.aigen.online/webhook-test/ricoh-webhook"
const webhookUrl = "https://playground2-3001.space.aigen.dev/webhook"
//const serviceUse = "ricoh_invoice"
//const serviceUse = "foodhouse"
//const serviceUse = "bla"
//const serviceUse = "malee_ocr"
//const serviceUse = "custom_create_truth"
//const serviceUse = "bmw_classify"
const serviceUse = "bmw_ocr"
//const serviceUse = "thaihonda_hospital"

const responseType = "webhook";

const source = path.join(__dirname, "BMW_FILE");
const destination = path.join(__dirname, "downloads/result");
const downloadsDir = path.join(__dirname, "downloads/bmw1");
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

async function processFile(fileName, pageNumbers = []) {
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
      // สร้าง folder ตามชื่อไฟล์ (ตัด extension ออก)
      const fileNameWithoutExt = path.parse(originalFileName).name;
      const fileFolder = path.join(downloadsDir, sanitizeFileName(fileNameWithoutExt));
      createDirectory(fileFolder);
      
      const pendingBaseName =
        pageNumbers.length > 0 ? `${originalFileName}_${pageLabel}` : originalFileName;
      const pendingFileName = `${sanitizeFileName(pendingBaseName)}_${requestId}.json`;
      const pendingPath = path.join(fileFolder, pendingFileName);
      const pendingPayload = {
        status: "pending",
        request_id: requestId,
        sent_file: originalFileName,
        page_numbers: pageNumbers,
        created_at: new Date().toISOString(),
        response_preview: response.data,
      };
      fs.writeFileSync(pendingPath, JSON.stringify(pendingPayload, null, 2));
      console.log(`Created pending file: ${pendingFileName} in folder: ${fileNameWithoutExt}`);
    } else {
      console.warn("No request_id found in response; pending file not created.");
    }

    // Save response to JSON
    const jsonFileName = pageNumbers.length > 0 
      ? `${fileNameWithoutExtension}_pages_${pageNumbers.join("-")}.json`
      : `${fileNameWithoutExtension}.json`;
    const jsonPath = path.join(destination, "json", jsonFileName);
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
    const errorPath = path.join(destination, "error", errorFileName);
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
  const files = fs
    .readdirSync(source)
    .filter(file => file.toLowerCase().endsWith('.pdf') && !file.includes("desktop.ini"));
  
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
  // แสดงรายการไฟล์ทั้งหมด
  const files = await listAllPdfFiles();
  
  const splitEnabled = splitToOcrConfig.enabled;
 
  if (splitEnabled) {
    console.log("\n=== Split-to-OCR Mode Enabled ===");
    
    if (splitToOcrConfig.pages.length === 0) {
      console.log(`หน้าที่จะถูกส่ง: ทุกหน้า (1 ถึง จำนวนหน้าของแต่ละไฟล์)`);
    } else {
      console.log(`หน้าที่จะถูกส่ง: ${splitToOcrConfig.pages.join(', ')}`);
    }
    console.log(`จำนวนไฟล์ที่จะประมวลผล: ${files.length} ไฟล์`);
    console.log("=================================\n");
 
    for (const fileName of files) {
      console.log(`\n--- แยกหน้าไฟล์ ${fileName} ---`);
      
      let pagesToProcess = splitToOcrConfig.pages;
      
      // If pages array is empty, process all pages (1 to pageCount)
      if (pagesToProcess.length === 0) {
        const filePath = path.join(source, fileName);
        const pageCount = await getPdfPageCount(filePath);
        pagesToProcess = Array.from({ length: pageCount }, (_, i) => i + 1);
        console.log(`ไฟล์ ${fileName} มี ${pageCount} หน้า จะประมวลผลทุกหน้า`);
      }
      
      for (const pageNumber of pagesToProcess) {
        console.log(`Processing page ${pageNumber} of ${fileName}`);
        await processFile(fileName, [pageNumber]);
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
