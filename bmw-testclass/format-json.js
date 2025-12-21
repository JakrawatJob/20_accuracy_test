const fs = require("node:fs");
const path = require("node:path");

// Configuration
const DOWNLOADS_DIR = path.join(__dirname, "downloads", "res");

/**
 * Recursively collect all JSON files in a directory
 */
function collectJsonFilesRecursive(dir) {
  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsonFilesRecursive(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Format JSON file: extract data object and remove document_type field
 */
function formatJsonFile(filePath) {
  try {
    // Read the JSON file
    const fileContent = fs.readFileSync(filePath, "utf8");
    const jsonData = JSON.parse(fileContent);

    // Extract data object
    let formattedData = {};
    if (jsonData.data && typeof jsonData.data === "object") {
      formattedData = { ...jsonData.data };
    } else {
      // If no data field, use the whole object but remove document_type
      formattedData = { ...jsonData };
    }

    // Remove document_type field if it exists
    if (formattedData.document_type !== undefined) {
      delete formattedData.document_type;
    }

    // Write formatted JSON back to the file
    fs.writeFileSync(
      filePath,
      JSON.stringify(formattedData, null, 2),
      "utf8"
    );

    return {
      success: true,
      filePath,
      fileName: path.basename(filePath)
    };
  } catch (error) {
    return {
      success: false,
      filePath,
      fileName: path.basename(filePath),
      error: error.message
    };
  }
}

/**
 * Main function to format all JSON files
 */
function formatAllJsonFiles() {
  console.log("=== Starting JSON Formatting ===");
  console.log(`Scanning directory: ${DOWNLOADS_DIR}\n`);

  // Collect all JSON files
  const jsonFiles = collectJsonFilesRecursive(DOWNLOADS_DIR);

  if (jsonFiles.length === 0) {
    console.log("No JSON files found.");
    return;
  }

  console.log(`Found ${jsonFiles.length} JSON file(s)\n`);

  const results = {
    success: [],
    failed: []
  };

  // Process each JSON file
  for (const filePath of jsonFiles) {
    const result = formatJsonFile(filePath);

    if (result.success) {
      results.success.push(result);
      console.log(`✓ Formatted: ${result.fileName}`);
    } else {
      results.failed.push(result);
      console.error(`✗ Error formatting ${result.fileName}: ${result.error}`);
    }
  }

  // Print summary
  console.log("\n=== Formatting Summary ===");
  console.log(`Total successful: ${results.success.length}`);
  console.log(`Total failed: ${results.failed.length}`);

  if (results.failed.length > 0) {
    console.log("\nFailed files:");
    results.failed.forEach(result => {
      console.log(`  - ${result.fileName}: ${result.error}`);
    });
  }

  console.log("\n=== Formatting Complete ===");
}

// Run the script
formatAllJsonFiles();

