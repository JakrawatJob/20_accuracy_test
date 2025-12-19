const fs = require("node:fs");
const path = require("node:path");
const axios = require("axios");
const FormData = require("form-data");
const { PassThrough } = require("stream");
const { PDFDocument } = require("pdf-lib");

// Configuration
const JSON_RESULT_DIR = path.join(__dirname, "jsonResult");
const SOURCE_DIR = path.join(__dirname, "BMW_FILE"); // Source directory for PDF files
const DOWNLOADS_DIR = path.join(__dirname, "downloads", "res"); // Directory to save API responses
const API_URL = "https://playground2-3052.space.aigen.dev/api/ocr-extract";
const AUTH_TOKEN = process.env.AIGEN_TOKEN || "YOUR_TOKEN"; // Set via environment variable or replace with your token
const MAX_CONCURRENT_REQUESTS = 1;
const DELAY_BETWEEN_REQUESTS = 1000; // 1 second

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Ensure directory exists
const createDirectory = (dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

// Sanitize filename for filesystem
const sanitizeFileName = (name = "") =>
  name.replace(/[<>:"/\\|?*\u0000]/g, "_");

/**
 * Extract page numbers from JSON result filenames
 * Filename format: {baseFilename}_{pageNumber}__schema_{type}.json
 * Example: AS-AMR_530913.pdf_1__schema_amr.json -> { baseFile: "AS-AMR_530913.pdf", page: 1, folder: "amr" }
 * Returns: Map of PDF filename -> { pages: number[], pageToDir: { pageNum: dir } }
 */
function extractPageNumbersFromJsonResults() {
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
        entry.name.includes("__schema_")
      ) {
        files.push(fullPath);
      }
    }
    return files;
  };

  try {
    if (!fs.existsSync(JSON_RESULT_DIR)) {
      console.warn(`JSON results folder not found: ${JSON_RESULT_DIR}`);
      return pageMap;
    }

    const jsonFiles = collectJsonFilesRecursive(JSON_RESULT_DIR);

    console.log(`\n=== Scanning JSON Results ===`);
    console.log(`Found ${jsonFiles.length} JSON result files`);

    for (const jsonFileFullPath of jsonFiles) {
      const jsonFile = path.basename(jsonFileFullPath);
      const relativeDir = path.relative(JSON_RESULT_DIR, path.dirname(jsonFileFullPath)); // e.g., "amr"
      
      // Parse filename: AS-AMR_530913.pdf_1__schema_amr.json
      // Pattern: {baseFile}_{page}__schema_<type>.json
      const match = jsonFile.match(/^(.+\.pdf)_(\d+)__schema_[^.]+\.json$/);

      if (match) {
        const baseFile = match[1]; // e.g., "AS-AMR_530913.pdf"
        const pageNumber = parseInt(match[2], 10); // e.g., 1

        if (!pageMap[baseFile]) {
          pageMap[baseFile] = { pages: [], pageToDir: {} };
        }

        if (!pageMap[baseFile].pages.includes(pageNumber)) {
          pageMap[baseFile].pages.push(pageNumber);
        }

        // Store folder for each page
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
 * Returns paths relative to the source root.
 */
function collectPdfFilesRecursive(dir, relativeBase = "") {
  if (!fs.existsSync(dir)) {
    return [];
  }

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

/**
 * Find PDF file in source directory by filename
 */
function findPdfFile(fileName) {
  const allPdfs = collectPdfFilesRecursive(SOURCE_DIR);
  const found = allPdfs.find(relPath => path.basename(relPath) === fileName);
  return found ? path.join(SOURCE_DIR, found) : null;
}

/**
 * Extract specific pages from a PDF
 */
async function extractPagesFromPdf(pdfPath, pageNumbers) {
  try {
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    const newPdfDoc = await PDFDocument.create();
    
    for (const pageNumber of pageNumbers) {
      const pageIndex = pageNumber - 1;
      if (pageIndex >= 0 && pageIndex < pdfDoc.getPageCount()) {
        const [copiedPage] = await newPdfDoc.copyPages(pdfDoc, [pageIndex]);
        newPdfDoc.addPage(copiedPage);
      } else {
        console.warn(`Page ${pageNumber} doesn't exist in the document (total pages: ${pdfDoc.getPageCount()})`);
      }
    }
    
    const newPdfBytes = await newPdfDoc.save();
    return newPdfBytes;
  } catch (error) {
    console.error("Error extracting pages:", error);
    throw error;
  }
}

/**
 * Call the OCR API for a PDF file (or specific pages)
 */
async function callOcrApi(pdfPath, documentType, pageNumbers = []) {
  try {
    const fileName = path.basename(pdfPath);
    let fileToSend;
    let displayName = fileName;
    
    // Create form data
    const formData = new FormData();
    const fileNameForUpload = pageNumbers.length > 0 
      ? `${path.parse(fileName).name}_pages_${pageNumbers.join("-")}.pdf`
      : fileName;
    
    if (pageNumbers.length > 0) {
      displayName = `${fileName} (pages ${pageNumbers.join(", ")})`;
      console.log(`\nProcessing: ${displayName} (document_type: ${documentType})`);
      
      // Extract specific pages
      const extractedPdfBytes = await extractPagesFromPdf(pdfPath, pageNumbers);
      // Convert Uint8Array to Buffer
      const pdfBuffer = Buffer.from(extractedPdfBytes);
      
      // Use PassThrough stream for FormData compatibility
      const stream = new PassThrough();
      stream.end(pdfBuffer);
      
      formData.append('file', stream, {
        filename: fileNameForUpload,
        contentType: 'application/pdf'
      });
    } else {
      console.log(`\nProcessing: ${displayName} (document_type: ${documentType})`);
      // Use file stream for whole file
      fileToSend = fs.createReadStream(pdfPath);
      formData.append('file', fileToSend, {
        filename: fileNameForUpload,
        contentType: 'application/pdf'
      });
    }
    
    // Make API request
    const response = await axios.post(
      `${API_URL}?document_type=${documentType}`,
      formData,
      {
        headers: {
          'Authorization': `Bearer ${AUTH_TOKEN}`,
          ...formData.getHeaders()
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );
    
    console.log(`✓ Success: ${displayName}`);
    console.log(`  Response status: ${response.status}`);
    
    // Save response to file
    try {
      // Use the same filename format as JSON results: {pdfname}_{page}__schema_{document_type}.json
      const responseFileName = pageNumbers.length > 0
        ? `${fileName}_${pageNumbers[0]}__schema_${documentType}.json`
        : `${path.parse(fileName).name}__schema_${documentType}.json`;
      
      // Create directory for document type
      const docTypeDir = path.join(DOWNLOADS_DIR, documentType);
      createDirectory(docTypeDir);
      
      const responseFilePath = path.join(docTypeDir, sanitizeFileName(responseFileName));
      fs.writeFileSync(
        responseFilePath,
        JSON.stringify(response.data, null, 2)
      );
      console.log(`  Saved response to: ${responseFilePath}`);
    } catch (saveError) {
      console.warn(`  Warning: Failed to save response: ${saveError.message}`);
    }
    
    return {
      success: true,
      fileName: displayName,
      documentType,
      pageNumbers,
      status: response.status,
      data: response.data
    };
  } catch (error) {
    const displayName = pageNumbers.length > 0 
      ? `${path.basename(pdfPath)} (pages ${pageNumbers.join(", ")})`
      : path.basename(pdfPath);
    
    console.error(`✗ Error processing ${displayName}:`, error.message);
    if (error.response) {
      console.error(`  Status: ${error.response.status}`);
      console.error(`  Data:`, error.response.data);
      
      // Save error response to file
      try {
        const pdfFileName = path.basename(pdfPath);
        // Use the same filename format as JSON results: {pdfname}_{page}__schema_{document_type}_error.json
        const errorFileName = pageNumbers.length > 0
          ? `${pdfFileName}_${pageNumbers[0]}__schema_${documentType}_error.json`
          : `${path.parse(pdfFileName).name}__schema_${documentType}_error.json`;
        
        // Create directory for document type
        const docTypeDir = path.join(DOWNLOADS_DIR, documentType);
        createDirectory(docTypeDir);
        
        const errorFilePath = path.join(docTypeDir, sanitizeFileName(errorFileName));
        const errorData = {
          error: error.message,
          status: error.response.status,
          data: error.response.data,
          timestamp: new Date().toISOString()
        };
        fs.writeFileSync(
          errorFilePath,
          JSON.stringify(errorData, null, 2)
        );
        console.error(`  Saved error response to: ${errorFilePath}`);
      } catch (saveError) {
        console.warn(`  Warning: Failed to save error response: ${saveError.message}`);
      }
    }
    
    return {
      success: false,
      fileName: displayName,
      documentType,
      pageNumbers,
      error: error.message,
      status: error.response?.status
    };
  }
}

/**
 * Main function to process all PDFs based on JSON results
 */
async function processAllPdfs() {
  console.log("=== Starting PDF Processing ===");
  console.log(`JSON Results: ${JSON_RESULT_DIR}`);
  console.log(`Source PDFs: ${SOURCE_DIR}`);
  console.log(`Response Output: ${DOWNLOADS_DIR}\n`);
  
  // Ensure downloads directory exists
  createDirectory(DOWNLOADS_DIR);
  
  // Check if token is set
  if (AUTH_TOKEN === "YOUR_TOKEN") {
    console.warn("⚠ Warning: AUTH_TOKEN is not set!");
    console.warn("Please set AIGEN_TOKEN environment variable or update the script with your token.\n");
  }
  
  // Extract page numbers from JSON results
  const pageMap = extractPageNumbersFromJsonResults();
  
  if (Object.keys(pageMap).length === 0) {
    console.log("No PDF/page mappings found in JSON results.");
    return;
  }
  
  const results = {
    success: [],
    failed: []
  };
  
  // Process each PDF file found in JSON results
  for (const baseFileName of Object.keys(pageMap)) {
    const { pages, pageToDir } = pageMap[baseFileName];
    
    // Find the PDF file in source directory
    const pdfPath = findPdfFile(baseFileName);
    
    if (!pdfPath) {
      console.warn(`\n⚠ PDF file not found: ${baseFileName}`);
      console.warn(`  Searched in: ${SOURCE_DIR}`);
      results.failed.push({
        success: false,
        fileName: baseFileName,
        error: "PDF file not found in source directory"
      });
      continue;
    }
    
    console.log(`\n--- Processing PDF: ${baseFileName} ---`);
    console.log(`  Found at: ${pdfPath}`);
    console.log(`  Pages to process: ${pages.join(", ")}`);
    
    // Process each page separately (each page may have different document_type)
    for (const pageNumber of pages) {
      const documentType = pageToDir[pageNumber] || "unknown";
      
      const result = await callOcrApi(pdfPath, documentType, [pageNumber]);
      
      if (result.success) {
        results.success.push(result);
      } else {
        results.failed.push(result);
      }
      
      // Delay between requests
      await delay(DELAY_BETWEEN_REQUESTS);
    }
  }
  
  // Print summary
  console.log("\n=== Processing Summary ===");
  console.log(`Total successful: ${results.success.length}`);
  console.log(`Total failed: ${results.failed.length}`);
  
  if (results.failed.length > 0) {
    console.log("\nFailed files:");
    results.failed.forEach(result => {
      console.log(`  - ${result.fileName} (${result.documentType || 'N/A'}): ${result.error}`);
    });
  }
  
  console.log("\n=== Processing Complete ===");
}

// Run the script
processAllPdfs().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});
