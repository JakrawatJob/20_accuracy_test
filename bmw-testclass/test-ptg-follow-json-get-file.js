const fs = require("node:fs");
const path = require("node:path");
const { PDFDocument } = require("pdf-lib");

// Configuration
const JSON_RESULT_DIR = path.join(__dirname, "jsonResult");
const SOURCE_DIR = path.join(__dirname, "BMW_FILE"); // Source directory for PDF files
const OUTPUT_DIR = path.join(__dirname, "downloads", "01_pdf_page_use"); // Directory to save extracted PDF pages

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
 * Extract and save a single page from PDF
 */
async function extractAndSavePage(pdfPath, pageNumber, documentType, baseFileName) {
  try {
    const extractedPdfBytes = await extractPagesFromPdf(pdfPath, [pageNumber]);
    
    // Create directory for document type
    const docTypeDir = path.join(OUTPUT_DIR, documentType);
    createDirectory(docTypeDir);
    
    // Create filename: {pdfname}_{page}__schema_{document_type}.pdf
    const outputFileName = `${baseFileName}_${pageNumber}__schema_${documentType}.pdf`;
    const outputFilePath = path.join(docTypeDir, sanitizeFileName(outputFileName));
    
    fs.writeFileSync(outputFilePath, extractedPdfBytes);
    
    console.log(`  ✓ Saved: ${documentType}/${outputFileName}`);
    
    return {
      success: true,
      fileName: outputFileName,
      filePath: outputFilePath,
      pageNumber,
      documentType
    };
  } catch (error) {
    console.error(`  ✗ Error extracting page ${pageNumber} from ${baseFileName}:`, error.message);
    return {
      success: false,
      fileName: baseFileName,
      pageNumber,
      documentType,
      error: error.message
    };
  }
}


/**
 * Main function to extract PDF pages based on JSON results
 */
async function processAllPdfs() {
  console.log("=== Starting PDF Page Extraction ===");
  console.log(`JSON Results: ${JSON_RESULT_DIR}`);
  console.log(`Source PDFs: ${SOURCE_DIR}`);
  console.log(`Output Directory: ${OUTPUT_DIR}\n`);
  
  // Ensure output directory exists
  createDirectory(OUTPUT_DIR);
  
  // Extract page numbers from JSON results
  const pageMap = extractPageNumbersFromJsonResults();
  
  if (Object.keys(pageMap).length === 0) {
    console.log("No PDF/page mappings found in JSON results.");
    return;
  }
  
  const results = { success: [], failed: [] };
  
  // Process each PDF and extract required pages
  for (const baseFileName of Object.keys(pageMap)) {
    const { pages, pageToDir } = pageMap[baseFileName];
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
    console.log(`  Pages to extract: ${pages.join(", ")}`);
    
    for (const pageNumber of pages) {
      const documentType = pageToDir[pageNumber] || "unknown";
      
      const result = await extractAndSavePage(pdfPath, pageNumber, documentType, baseFileName);
      
      if (result.success) {
        results.success.push(result);
      } else {
        results.failed.push(result);
      }
    }
  }
  
  // Print summary
  console.log("\n=== Processing Summary ===");
  console.log(`Total successful: ${results.success.length}`);
  console.log(`Total failed: ${results.failed.length}`);
  
  if (results.failed.length > 0) {
    console.log("\nFailed extractions:");
    results.failed.forEach(result => {
      console.log(`  - ${result.fileName} page ${result.pageNumber} (${result.documentType || 'N/A'}): ${result.error}`);
    });
  }
  
  console.log(`\n=== Extraction Complete ===`);
  console.log(`Output saved to: ${OUTPUT_DIR}`);
}

// Run the script
processAllPdfs().catch(error => {
  console.error("Fatal error:", error);
  process.exit(1);
});

