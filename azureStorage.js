const fs = require('fs');
const path = require('path');

let useAzure = false;
let containerClient = null;

if (process.env.AZURE_STORAGE_CONNECTION_STRING && process.env.AZURE_CONTAINER_NAME) {
    try {
        // lazy require to avoid errors if package not installed in some environments
        const { BlobServiceClient } = require('@azure/storage-blob');
        const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
        containerClient = blobServiceClient.getContainerClient(process.env.AZURE_CONTAINER_NAME);
        useAzure = true;
    } catch (err) {
        console.warn('Azure storage client initialization failed, falling back to local uploads:', err.message || err);
        useAzure = false;
    }
} else {
    console.warn('AZURE_STORAGE_CONNECTION_STRING or AZURE_CONTAINER_NAME not set - using local upload fallback');
}

async function uploadToAzure(filePath, blobName) {
    if (useAzure && containerClient) {
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);
        await blockBlobClient.uploadFile(filePath);
        return blockBlobClient.url;
    }

    // Fallback: copy file to local uploads directory and return a file:// path or relative path
    const uploadsDir = path.join(__dirname, 'uploads');
    await fs.promises.mkdir(uploadsDir, { recursive: true });
    const dest = path.join(uploadsDir, path.basename(blobName));
    await fs.promises.copyFile(filePath, dest);
    // Return a pseudo-URL pointing to the local file
    return `file://${dest}`;
}

async function deleteLocalFile(filePath) {
    try {
        await fs.promises.unlink(filePath);
    } catch (err) {
        // Non-fatal: log and continue
        console.error('Error deleting local file:', err.message || err);
    }
}

module.exports = { uploadToAzure, deleteLocalFile };