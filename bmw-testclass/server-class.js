const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const DOWNLOAD_DIR = path.join(__dirname, 'downloads/bmw1');

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

const findPendingFileByRequestId = (requestId) => {
  try {
    // ค้นหาใน subfolder ทั้งหมด (folder ตามชื่อไฟล์)
    const folders = fs.readdirSync(DOWNLOAD_DIR, { withFileTypes: true });
    
    for (const folder of folders) {
      if (folder.isDirectory()) {
        const folderPath = path.join(DOWNLOAD_DIR, folder.name);
        const files = fs.readdirSync(folderPath);
        const foundFile = files.find((file) => file.includes(`_${requestId}.json`));
        if (foundFile) {
          return {
            folder: folder.name,
            filename: foundFile,
            fullPath: path.join(folderPath, foundFile)
          };
        }
      }
    }
    
    // ถ้าไม่เจอใน subfolder ให้ค้นหาใน root directory (backward compatibility)
    const files = fs.readdirSync(DOWNLOAD_DIR);
    const foundFile = files.find((file) => file.includes(`_${requestId}.json`));
    if (foundFile) {
      return {
        folder: null,
        filename: foundFile,
        fullPath: path.join(DOWNLOAD_DIR, foundFile)
      };
    }
    
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

// Extract document_type from final data
const extractDocumentType = (finalData) => {
  if (finalData && typeof finalData === 'object' && finalData.document_type) {
    return finalData.document_type;
  }
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
        const documentType = extractDocumentType(finalData);
        
        let filename;
        let filePath;

        if (requestId) {
            const pendingFileInfo = findPendingFileByRequestId(requestId);
            if (pendingFileInfo) {
                // Remove document_type from finalData before saving
                const dataToSave = { ...finalData };
                delete dataToSave.document_type;
                
                // Save final data (not wrapped in arrays)
                fs.writeFileSync(pendingFileInfo.fullPath, JSON.stringify(dataToSave, null, 2));

                // เปลี่ยนชื่อไฟล์โดยลบ requestId ออก
                let finalFilename = pendingFileInfo.filename.replace(`_${requestId}`, '');
                
                // Add document_type to filename if available
                if (documentType) {
                    // Extract base filename without extension
                    const parsed = path.parse(finalFilename);
                    const baseName = parsed.name; // e.g., "555322.pdf_1"
                    const extension = parsed.ext; // ".json"
                    
                    // Add document_type before extension
                    finalFilename = `${baseName}__schema_${documentType}${extension}`;
                    console.log(`Adding document_type to filename: ${documentType}`);
                }
                
                // ถ้ามี folder ให้เก็บไว้ใน folder เดิม
                if (pendingFileInfo.folder) {
                    const finalPath = path.join(DOWNLOAD_DIR, pendingFileInfo.folder, finalFilename);
                    fs.renameSync(pendingFileInfo.fullPath, finalPath);
                    filename = finalFilename;
                    filePath = finalPath;
                    console.log(`Updated pending file for request_id ${requestId}: ${pendingFileInfo.folder}/${finalFilename}`);
                } else {
                    // Backward compatibility: ไฟล์อยู่ใน root directory
                    const finalPath = path.join(DOWNLOAD_DIR, finalFilename);
                    fs.renameSync(pendingFileInfo.fullPath, finalPath);
                    filename = finalFilename;
                    filePath = finalPath;
                    console.log(`Updated pending file for request_id ${requestId}: ${finalFilename}`);
                }
                
                console.log(`  Extracted final data with document_type: ${documentType || 'N/A'}`);
            } else {
                console.warn(`Pending file for request_id ${requestId} not found. Falling back to new file.`);
            }
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

