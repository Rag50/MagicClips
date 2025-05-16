const { BlobServiceClient } = require('@azure/storage-blob');

const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const containerClient = blobServiceClient.getContainerClient(process.env.AZURE_CONTAINER_NAME);

async function uploadToAzure(filePath, blobName) {
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);
    await blockBlobClient.uploadFile(filePath);
    return blockBlobClient.url;
}

async function deleteLocalFile(filePath) {
    try {
        await fs.unlink(filePath);
    } catch (err) {
        console.error('Error deleting local file:', err);
    }
}

module.exports = { uploadToAzure, deleteLocalFile };