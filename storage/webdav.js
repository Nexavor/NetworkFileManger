const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

// 不再维護单一的全域 client
let clientCache = new Map();

function getWebdavConfigs() {
    const storageManager = require('./index'); 
    const config = storageManager.readConfig();
    return config.webdav || [];
}

// *** 新生：根据 ID 获取特定 WebDAV 客户端的函数 ***
function getClient(configId) {
    if (clientCache.has(configId)) {
        return clientCache.get(configId);
    }

    const configs = getWebdavConfigs();
    const webdavConfig = configs.find(c => c.id == configId);

    if (!webdavConfig || !webdavConfig.url) {
        throw new Error(`找不到 ID 为 ${configId} 的 WebDAV 设定`);
    }

    const newClient = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
    clientCache.set(configId, newClient);
    return newClient;
}

// *** 新生：解析 file_id 以获取设定 ID 和真实路径 ***
function parseFileId(fileId) {
    const parts = fileId.split(':');
    if (parts.length < 2) {
        // 为了相容旧资料，如果没有 ID，预设为第一个
        const configs = getWebdavConfigs();
        if (configs.length > 0) {
            return { configId: configs[0].id, remotePath: fileId };
        }
        throw new Error('无法解析 file_id 且没有预设的 WebDAV 设定');
    }
    const configId = parts.shift();
    const remotePath = parts.join(':');
    return { configId, remotePath };
}

function resetClient() {
    clientCache.clear();
}

async function getFolderPath(folderId, userId) {
    // 此函数逻辑不变
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

// *** 修改：Upload 函数现在需要 webdavConfigId 来决定上传到哪里 ***
async function upload(tempFilePath, fileName, mimetype, userId, folderId, caption, webdavConfigId) {
    const configs = getWebdavConfigs();
    if (configs.length === 0) {
        throw new Error('尚未设定任何 WebDAV 伺服器，无法上传。');
    }
    // 如果未指定，则预设上传到第一个设定的伺服器
    const targetConfigId = webdavConfigId || configs[0].id;
    const client = getClient(targetConfigId);

    const folderPath = await getFolderPath(folderId, userId);
    const remotePath = path.posix.join(folderPath, fileName);
    
    if (folderPath && folderPath !== "/") {
        try {
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            // 忽略“目录已存在”的错误
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }

    const fileBuffer = await fsp.readFile(tempFilePath);
    const success = await client.putFileContents(remotePath, fileBuffer, { overwrite: true });

    if (!success) {
        throw new Error('WebDAV putFileContents 操作失败');
    }

    const stat = await client.stat(remotePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
    
    // *** 关键修改：储存包含设定 ID 的新格式 file_id ***
    const fileIdForDb = `${targetConfigId}:${remotePath}`;

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stat.size,
        file_id: fileIdForDb,
        date: new Date(stat.lastmod).getTime(),
    }, folderId, userId, 'webdav');
    
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}

// *** 修改：Remove 函数现在能处理来自不同伺服器的档案 ***
async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const allItemsToDelete = [];

    files.forEach(file => {
        const { configId, remotePath } = parseFileId(file.file_id);
        allItemsToDelete.push({ 
            path: path.posix.normalize(remotePath), 
            type: 'file',
            configId: configId
        });
    });
    
    // 资料夹删除逻辑不变，因为它们只存在于资料库中
    // 物理删除操作只针对档案
    
    allItemsToDelete.sort((a, b) => b.path.length - a.path.length);

    for (const item of allItemsToDelete) {
        try {
            const client = getClient(item.configId);
            await client.deleteFile(item.path);
        } catch (error) {
            if (!(error.response && error.response.status === 404)) {
                const errorMessage = `删除 WebDAV ${item.type} [${item.path}] 失败: ${error.message}`;
                console.error(errorMessage);
                results.errors.push(errorMessage);
                results.success = false;
            }
        }
    }

    return results;
}

// *** 修改：Stream 和 getUrl 都需要解析 file_id ***
async function stream(file_id, userId) {
    const { configId, remotePath } = parseFileId(file_id);
    const webdavConfig = getWebdavConfigs().find(c => c.id == configId);
    if (!webdavConfig) throw new Error(`找不到与档案关联的 WebDAV 设定 (ID: ${configId})`);
    
    // 为每个流操作创建独立的客户端
    const streamClient = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
    return streamClient.createReadStream(remotePath);
}

async function getUrl(file_id, userId) {
    const { configId, remotePath } = parseFileId(file_id);
    const client = getClient(configId);
    return client.getFileDownloadLink(remotePath);
}

module.exports = { upload, remove, getUrl, stream, resetClient, type: 'webdav' };
