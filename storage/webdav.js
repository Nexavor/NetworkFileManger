const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

let client = null;

function getWebdavConfig() {
    const storageManager = require('./index'); 
    const config = storageManager.readConfig();
    const webdavConfig = config.webdav && Array.isArray(config.webdav) ? config.webdav[0] : config.webdav;
    if (!webdavConfig || !webdavConfig.url) {
        throw new Error('WebDAV 设定不完整或未设定');
    }
    return webdavConfig;
}


function getClient() {
    if (!client) {
        const webdavConfig = getWebdavConfig();
        client = createClient(webdavConfig.url, {
            username: webdavConfig.username,
            password: webdavConfig.password
        });
    }
    return client;
}

function resetClient() {
    client = null;
}

async function getFolderPath(folderId, userId) {
    const userRoot = await new Promise((resolve, reject) => {
        db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId], (err, row) => {
            if (err) return reject(err);
            if (!row) return reject(new Error('找不到使用者根目录'));
            resolve(row);
        });
    });

    if (folderId === userRoot.id) return '/';
    
    const pathParts = await data.getFolderPath(folderId, userId);
    return '/' + pathParts.slice(1).map(p => p.name).join('/');
}

/**
 * [重构] 使用流式上传将档案储存到 WebDAV 伺服器。
 * @param {string} tempFilePath - Multer 暂存盘案的完整路径。
 * @param {string} fileName - 档案的原始名称。
 * @param {string} mimetype - 档案的MIME类型。
 * @param {number} userId - 使用者ID。
 * @param {number} folderId - 目标资料夹ID。
 * @returns {Promise<object>} 上传结果。
 */
async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    console.log(`[调试日志][WebDAV] 开始处理上传: ${fileName} (暂存: ${tempFilePath})`);
    const client = getClient();
    const folderPath = await getFolderPath(folderId, userId);
    const remotePath = (folderPath === '/' ? '' : folderPath) + '/' + fileName;
    console.log(`[调试日志][WebDAV] 目标 WebDAV 路径: ${remotePath}`);

    if (folderPath && folderPath !== "/") {
        try {
            console.log(`[调试日志][WebDAV] 确保远端目录存在: ${folderPath}`);
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
            // 忽略“Method Not Allowed”或“Not Implemented”错误
            console.log(`[调试日志][WebDAV] 建立目录时收到可忽略的错误，继续执行...`);
        }
    }
    
    console.log(`[调试日志][WebDAV] 从暂存盘建立档案读取流: ${tempFilePath}`);
    const readStream = fs.createReadStream(tempFilePath);
    const stats = await fsp.stat(tempFilePath);
    console.log(`[调试日志][WebDAV] 取得档案状态成功, 大小: ${stats.size} bytes`);

    console.log(`[调试日志][WebDAV] 开始将档案流上传至 ${remotePath}`);
    const success = await client.putFileContents(remotePath, readStream, { 
      overwrite: true,
      contentLength: stats.size
    });

    if (!success) {
        console.error(`[调试日志][WebDAV] putFileContents 操作返回 false`);
        throw new Error('WebDAV putFileContents 操作失败');
    }
    console.log(`[调试日志][WebDAV] 档案流式上传成功`);

    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    console.log(`[调试日志][WebDAV] 正在将档案资讯写入资料库: ${fileName}`);
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stats.size,
        file_id: remotePath, // 储存完整 WebDAV 路径作为 file_id
        date: Date.now(),
    }, folderId, userId, 'webdav');
    
    console.log(`[调试日志][WebDAV] 档案 ${fileName} 成功储存并记录到资料库。`);
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}

async function remove(files, folders, userId) {
    // 为保持功能完整性，保留此函数不变
    const client = getClient();
    const results = { success: true, errors: [] };

    const allItemsToDelete = [];
    
    files.forEach(file => {
        let p = file.file_id.startsWith('/') ? file.file_id : '/' + file.file_id;
        allItemsToDelete.push({ 
            path: path.posix.normalize(p), 
            type: 'file' 
        });
    });
    
    folders.forEach(folder => {
        if (folder.path && folder.path !== '/') {
            let p = folder.path.startsWith('/') ? folder.path : '/' + folder.path;
            if (!p.endsWith('/')) {
                p += '/';
            }
            allItemsToDelete.push({ path: p, type: 'folder' });
        }
    });

    allItemsToDelete.sort((a, b) => b.path.length - a.path.length);

    for (const item of allItemsToDelete) {
        try {
            await client.deleteFile(item.path);
        } catch (error) {
            if (!(error.response && error.response.status === 404)) {
                const errorMessage = `删除 WebDAV ${item.type} [${item.path}] 失败: ${error.message}`;
                results.errors.push(errorMessage);
                results.success = false;
            }
        }
    }

    return results;
}

async function stream(file_id, userId) {
    // 为保持功能完整性，保留此函数不变
    const webdavConfig = getWebdavConfig();
    const streamClient = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
    return streamClient.createReadStream(path.posix.join('/', file_id));
}

async function getUrl(file_id, userId) {
    // 为保持功能完整性，保留此函数不变
    const client = getClient();
    return client.getFileDownloadLink(path.posix.join('/', file_id));
}

async function createDirectory(fullPath) {
    // 为保持功能完整性，保留此函数不变
    const client = getClient();
    try {
        const remotePath = path.posix.join('/', fullPath);
        if (await client.exists(remotePath)) {
            return true;
        }
        await client.createDirectory(remotePath, { recursive: true });
        return true;
    } catch (e) {
        if (e.response && (e.response.status === 405 || e.response.status === 501)) {
            return true;
        }
        throw new Error(`建立 WebDAV 目录失败: ${e.message}`);
    }
}

module.exports = { upload, remove, getUrl, stream, resetClient, getClient, createDirectory, type: 'webdav' };
