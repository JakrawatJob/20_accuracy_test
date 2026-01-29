const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
// Webhook results will be written here (aligned with sender script)
const DOWNLOAD_DIR = path.join(__dirname, 'downloads/ptg1');

// Configuration for data extraction
const DATA_EXTRACTION_CONFIG = {
  enabled: true, // Set to false to save full payload
  path: 'data.data', // JSON path to extract (e.g., 'data.data' extracts payload.data.data - the invoice data object)
  wrapInData: true, // If true, wraps extracted data in { data: ... }, otherwise saves as-is
};

const sanitizeFileName = (name = '') =>
  name.replace(/[<>:"/\\|?*\u0000]/g, '_');

const extractRequestId = (payload = {}) =>
  payload.request_id ||
  payload.requestId ||
  payload.data?.request_id ||
  payload.data?.requestId ||
  payload.data?.data?.request_id ||
  payload.data?.data?.requestId ||
  null;

// Recursive function to search for files with request_id in nested directories
const searchFileRecursive = (dir, requestId, relativePath = '') => {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const currentRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
      
      if (entry.isFile() && entry.name.includes(`_${requestId}.json`)) {
        console.log(`[searchFileRecursive] Found file matching request_id:`);
        console.log(`  - Directory: ${dir}`);
        console.log(`  - Relative path: ${relativePath || 'root'}`);
        console.log(`  - Filename: ${entry.name}`);
        console.log(`  - Full path: ${fullPath}`);
        return {
          folder: relativePath ? relativePath : null,
          filename: entry.name,
          fullPath: fullPath
        };
      }
      
      if (entry.isDirectory()) {
        const result = searchFileRecursive(fullPath, requestId, currentRelativePath);
        if (result) {
          return result;
        }
      }
    }
    
    return null;
  } catch (err) {
    console.error(`[searchFileRecursive] Error searching in directory ${dir}:`, err);
    return null;
  }
};

const findPendingFileByRequestId = (requestId) => {
  try {
    console.log(`[findPendingFileByRequestId] Searching for request_id: ${requestId}`);
    console.log(`[findPendingFileByRequestId] Search directory: ${DOWNLOAD_DIR}`);
    
    // ค้นหาแบบ recursive ใน subfolder ทั้งหมด (รองรับ nested folders)
    const result = searchFileRecursive(DOWNLOAD_DIR, requestId);
    if (result) {
      console.log(`[findPendingFileByRequestId] Found pending file:`);
      console.log(`  - Folder: ${result.folder || 'root'}`);
      console.log(`  - Filename: ${result.filename}`);
      console.log(`  - Full path: ${result.fullPath}`);
      return result;
    }
    
    // ถ้าไม่เจอใน subfolder ให้ค้นหาใน root directory (backward compatibility)
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const foundFile = files.find((file) => file.includes(`_${requestId}.json`));
    if (foundFile) {
      console.log(`[findPendingFileByRequestId] Found pending file in root:`);
      console.log(`  - Filename: ${foundFile}`);
      return {
        folder: null,
        filename: foundFile,
        fullPath: path.join(DOWNLOAD_DIR, foundFile)
      };
    }
    
    console.warn(`[findPendingFileByRequestId] No pending file found for request_id: ${requestId}`);
    return null;
  } catch (err) {
    console.error('Error scanning downloads directory:', err);
    return null;
  }
};

// Extract data from nested path (e.g., 'data.data' -> payload.data.data)
const extractDataByPath = (payload, pathString) => {
  if (!pathString) return payload;
  
  const keys = pathString.split('.');
  let result = payload;
  
  for (const key of keys) {
    if (result && typeof result === 'object' && key in result) {
      result = result[key];
    } else {
      return null; // Path not found
    }
  }
  
  return result;
};

// Extract final data object from webhook payload
// Expected structure: { data: [{ data: { document_type, ... } }] }
const extractFinalData = (payload) => {
  try {
    // Try to extract data.data[0].data (the actual document data)
    if (payload?.data && Array.isArray(payload.data) && payload.data.length > 0) {
      const firstItem = payload.data[0];
      if (firstItem?.data && typeof firstItem.data === 'object') {
        return firstItem.data; // Return the final data object
      }
    }
    
    // Fallback: try data.data path
    const extracted = extractDataByPath(payload, 'data.data');
    if (extracted && typeof extracted === 'object') {
      // If it's an array, get first element's data
      if (Array.isArray(extracted) && extracted.length > 0 && extracted[0]?.data) {
        return extracted[0].data;
      }
      // If it's already the object, return it
      if (!Array.isArray(extracted)) {
        return extracted;
      }
    }
    
    console.warn('Could not extract final data from payload. Returning full payload.');
    return payload;
  } catch (error) {
    console.error('Error extracting final data:', error);
    return payload;
  }
};

// Extract document_type from final data or raw payload
const extractDocumentType = (finalData, rawPayload = null) => {
  // Try to extract from finalData first
  if (finalData && typeof finalData === 'object' && finalData.document_type) {
    console.log(`[extractDocumentType] Found document_type in finalData: ${finalData.document_type}`);
    return finalData.document_type;
  }
  
  // If not found, try to extract from raw payload
  if (rawPayload) {
    // Try data.data[0].document_type
    if (rawPayload?.data && Array.isArray(rawPayload.data) && rawPayload.data.length > 0) {
      const firstItem = rawPayload.data[0];
      if (firstItem?.document_type) {
        console.log(`[extractDocumentType] Found document_type in rawPayload.data[0]: ${firstItem.document_type}`);
        return firstItem.document_type;
      }
      if (firstItem?.data?.document_type) {
        console.log(`[extractDocumentType] Found document_type in rawPayload.data[0].data: ${firstItem.data.document_type}`);
        return firstItem.data.document_type;
      }
    }
    
    // Try data.document_type
    if (rawPayload?.data?.document_type) {
      console.log(`[extractDocumentType] Found document_type in rawPayload.data: ${rawPayload.data.document_type}`);
      return rawPayload.data.document_type;
    }
    
    // Try document_type at root level
    if (rawPayload?.document_type) {
      console.log(`[extractDocumentType] Found document_type in rawPayload root: ${rawPayload.document_type}`);
      return rawPayload.document_type;
    }
  }
  
  console.warn(`[extractDocumentType] document_type not found in payload`);
  return null;
};

// Apply data extraction based on config
const applyDataExtraction = (payload) => {
  if (!DATA_EXTRACTION_CONFIG.enabled) {
    return payload;
  }
  
  const extracted = extractDataByPath(payload, DATA_EXTRACTION_CONFIG.path);
  
  if (extracted === null) {
    console.warn(`Data extraction path '${DATA_EXTRACTION_CONFIG.path}' not found in payload. Saving full payload.`);
    return payload;
  }
  
  console.log(`[Data Extraction] Path: ${DATA_EXTRACTION_CONFIG.path}`);
  console.log(`[Data Extraction] Extracted keys: ${Object.keys(extracted).slice(0, 5).join(', ')}...`);
  
  if (DATA_EXTRACTION_CONFIG.wrapInData) {
    return { data: extracted };
  }
  
  return extracted;
};

// Middleware to parse JSON bodies
app.use(express.json());
// Middleware to parse URL-encoded bodies (optional, but useful)
app.use(express.urlencoded({ extended: true }));

// Ensure download directory exists
if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
    console.log(`Created directory: ${DOWNLOAD_DIR}`);
}

app.post('/webhook', (req, res) => {
    try {
        const rawData = req.body || {};
        const requestId = extractRequestId(rawData);
        
        // Extract final data object (data.data[0].data)
        const finalData = extractFinalData(rawData);
        const documentType = extractDocumentType(finalData, rawData);
        
        console.log(`[Webhook] documentType extracted: ${documentType || 'null'}`);
        
        let filename;
        let filePath;

        if (requestId) {
            console.log(`[Webhook] Received request_id: ${requestId}`);
            const pendingFileInfo = findPendingFileByRequestId(requestId);
            if (pendingFileInfo) {
                console.log(`[Webhook] Found pending file, updating...`);
                console.log(`[Webhook] Current file path: ${pendingFileInfo.fullPath}`);
                
                // Remove document_type from finalData before saving
                const dataToSave = { ...finalData };
                delete dataToSave.document_type;
                
                // Read pending payload to get original filename
                let originalFileName = null;
                let pageNumbers = [];
                try {
                    const pendingContent = fs.readFileSync(pendingFileInfo.fullPath, 'utf8');
                    const pendingPayload = JSON.parse(pendingContent);
                    if (pendingPayload.sent_file) {
                        originalFileName = pendingPayload.sent_file;
                        pageNumbers = pendingPayload.page_numbers || [];
                        console.log(`[Webhook] Found original filename in pending file: ${originalFileName}`);
                        if (pageNumbers.length > 0) {
                            console.log(`[Webhook] Page numbers: ${pageNumbers.join(', ')}`);
                        }
                    }
                } catch (err) {
                    console.warn(`[Webhook] Could not read pending payload, using filename from path: ${err.message}`);
                }

                // Save final data (not wrapped in arrays)
                fs.writeFileSync(pendingFileInfo.fullPath, JSON.stringify(dataToSave, null, 2));
                console.log(`[Webhook] Updated file content with final data`);

                // ใช้ชื่อไฟล์เดิมจาก pending payload ถ้ามี (เพื่อหลีกเลี่ยงชื่อไฟล์ที่ถูก truncate)
                // ถ้าไม่มี ให้ใช้ชื่อไฟล์จาก path (backward compatibility)
                let baseFilename;
                if (originalFileName) {
                    // ใช้ชื่อไฟล์เดิม + page numbers ถ้ามี
                    if (pageNumbers.length > 0) {
                        const pageLabel = pageNumbers.join('-');
                        baseFilename = `${originalFileName}_${pageLabel}`;
                    } else {
                        baseFilename = originalFileName;
                    }
                } else {
                    // Fallback: ใช้ชื่อไฟล์จาก path (ลบ requestId ออก)
                    baseFilename = pendingFileInfo.filename.replace(`_${requestId}`, '');
                }
                
                let finalFilename = baseFilename;
                console.log(`[Webhook] Base filename: ${finalFilename}`);
                
                // Add document_type to filename if available
                if (documentType) {
                    // Extract base filename without extension
                    const parsed = path.parse(finalFilename);
                    let baseName = parsed.name; // e.g., "555322.pdf_1" or "file.pdf_1"
                    let extension = parsed.ext; // ".json" or ""
                    
                    // ถ้าไม่มี extension หรือไม่ใช่ .json ให้ใช้ .json
                    if (!extension || extension !== '.json') {
                        extension = '.json';
                    }
                    
                    // Add document_type before extension
                    finalFilename = `${baseName}__schema_${documentType}${extension}`;
                    console.log(`[Webhook] Adding document_type to filename: ${documentType}`);
                    console.log(`[Webhook] Final filename with document_type: ${finalFilename}`);
                } else {
                    // ถ้าไม่มี document_type แต่ไฟล์ยังไม่มี extension .json ให้เพิ่ม
                    if (!finalFilename.endsWith('.json')) {
                        finalFilename = `${finalFilename}.json`;
                    }
                    console.warn(`[Webhook] documentType is null/undefined, not adding __schema_ suffix`);
                }
                
                // ถ้ามี folder ให้เก็บไว้ใน folder เดิม
                if (pendingFileInfo.folder) {
                    const finalPath = path.join(DOWNLOAD_DIR, pendingFileInfo.folder, finalFilename);
                    console.log(`[Webhook] Renaming file:`);
                    console.log(`  - From: ${pendingFileInfo.fullPath}`);
                    console.log(`  - To: ${finalPath}`);
                    fs.renameSync(pendingFileInfo.fullPath, finalPath);
                    filename = finalFilename;
                    filePath = finalPath;
                    console.log(`[Webhook] Successfully updated pending file for request_id ${requestId}: ${pendingFileInfo.folder}/${finalFilename}`);
                } else {
                    // Backward compatibility: ไฟล์อยู่ใน root directory
                    const finalPath = path.join(DOWNLOAD_DIR, finalFilename);
                    console.log(`[Webhook] Renaming file:`);
                    console.log(`  - From: ${pendingFileInfo.fullPath}`);
                    console.log(`  - To: ${finalPath}`);
                    fs.renameSync(pendingFileInfo.fullPath, finalPath);
                    filename = finalFilename;
                    filePath = finalPath;
                    console.log(`[Webhook] Successfully updated pending file for request_id ${requestId}: ${finalFilename}`);
                }
                
                console.log(`[Webhook] Extracted final data with document_type: ${documentType || 'N/A'}`);
            } else {
                console.warn(`[Webhook] Pending file for request_id ${requestId} not found. Falling back to new file.`);
            }
        } else {
            console.warn(`[Webhook] No request_id found in webhook payload`);
        }

        if (!filename) {
            // Determine fallback filename
            let baseFilename;
            if (rawData && rawData.filename) {
                baseFilename = rawData.filename;
            } else if (rawData && rawData.id) {
                baseFilename = `${rawData.id}.json`;
            } else {
                const now = new Date();
                const timestamp = now.toISOString().replace(/:/g, '-').replace('T', '_').replace('Z', '');
                baseFilename = `${timestamp}.json`;
            }

            if (!baseFilename.endsWith('.json')) {
                baseFilename += '.json';
            }

            // Add document_type to filename if available
            if (documentType) {
                const parsed = path.parse(baseFilename);
                baseFilename = `${parsed.name}_${documentType}${parsed.ext}`;
            }

            filename = sanitizeFileName(baseFilename);
            
            // สร้าง folder ตามชื่อไฟล์ (ตัด extension)
            const fileNameWithoutExt = path.parse(filename).name;
            const fileFolder = path.join(DOWNLOAD_DIR, sanitizeFileName(fileNameWithoutExt));
            if (!fs.existsSync(fileFolder)) {
                fs.mkdirSync(fileFolder, { recursive: true });
            }
            
            filePath = path.join(fileFolder, filename);
            
            // Remove document_type from finalData before saving
            const dataToSave = { ...finalData };
            delete dataToSave.document_type;
            
            fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2));
        }
        
        console.log(`Saved webhook data to: ${filePath}`);
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook received and saved',
            saved_as: filename 
        });

    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Internal Server Error' 
        });
    }
});

app.listen(PORT, () => {
    console.log(`Webhook receiver listening on port ${PORT}`);
    console.log(`Saving files to: ${DOWNLOAD_DIR}`);
});
