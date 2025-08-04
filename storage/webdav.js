const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const stream = require('stream');

let client = null;
// ... (getClient, resetClient, getFolderPath 函数维持原样) ...

/**
 * [重构] 使用流或 Buffer 将档案储存到 WebDAV 伺服器。
 * @param {stream.Readable|Buffer} fileSource - 档案的资料流或 Buffer。
 * @param {string} fileName - 档案的原始名称。
 * @param {string} mimetype - 档案的MIME类型。
 * @param {number} userId - 使用者ID。
 * @param {number} folderId - 目标资料夹ID。
 * @returns {Promise<object>} 上传结果。
 */
async function upload(fileSource, fileName, mimetype, userId, folderId) {
    console.log(`[调试日志][WebDAV] 开始处理上传: ${fileName}`);
    const client = getClient();
    const folderPath = await getFolderPath(folderId, userId);
    const remotePath = (folderPath === '/' ? '' : folderPath) + '/' + fileName;
    
    if (folderPath && folderPath !== "/") {
        try {
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }
    
    let fileSize;
    if (Buffer.isBuffer(fileSource)) {
        fileSize = fileSource.length;
    } else if (fileSource instanceof stream.Readable) {
        // 对于流，我们无法预先知道大小，除非客户端提供了 Content-Length
        // webdav-client 库可以处理未知长度的流
        fileSize = undefined; 
    } else {
        throw new Error('不支援的上传来源类型');
    }
    
    console.log(`[调试日志][WebDAV] 开始将档案流/Buffer上传至 ${remotePath}`);
    const success = await client.putFileContents(remotePath, fileSource, { 
      overwrite: true,
      contentLength: fileSize // 如果是流，则此项为 undefined
    });

    if (!success) {
        throw new Error('WebDAV putFileContents 操作失败');
    }

    // 从远端获取档案大小，以确保准确性
    const stats = await client.stat(remotePath);
    const finalSize = stats.size;
    
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: finalSize,
        file_id: remotePath,
        date: Date.now(),
    }, folderId, userId, 'webdav');
    
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}
