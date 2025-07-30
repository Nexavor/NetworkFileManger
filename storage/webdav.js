const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

let clientCache = new Map();

// *** 关键修改：再次引入 storageManager 以便呼叫新函式 ***
const storageManager = require('./index'); 

function getWebdavConfigs() {
    const config = storageManager.readConfig();
    return config.webdav || [];
}

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

function parseFileId(fileId) {
    const parts = fileId.split(':');
    if (parts.length < 2) {
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

// *** 核心修改：实作智慧型轮询和自动重试 ***
async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    const allConfigs = getWebdavConfigs();
    if (allConfigs.length === 0) {
        throw new Error('尚未设定任何 WebDAV 伺服器，无法上传。');
    }

    // 取得轮询的起始点
    const startingConfig = storageManager.getNextWebdavConfig();
    if (!startingConfig) {
      throw new Error('无法决定要上传到哪个 WebDAV 伺服器。');
    }
    const startIndex = allConfigs.findIndex(c => c.id === startingConfig.id);

    let lastError = null;

    // 从起始点开始，循环尝试所有伺服器
    for (let i = 0; i < allConfigs.length; i++) {
        const currentIndex = (startIndex + i) % allConfigs.length;
        const targetConfig = allConfigs[currentIndex];
        const targetConfigId = targetConfig.id;

        console.log(`[WebDAV] 尝试上传档案 "${fileName}" 到伺服器: ${targetConfig.url}`);

        try {
            const client = getClient(targetConfigId);
            const folderPath = await getFolderPath(folderId, userId);
            const remotePath = path.posix.join(folderPath, fileName);
    
            if (folderPath && folderPath !== "/") {
                try {
                    await client.createDirectory(folderPath, { recursive: true });
                } catch (e) {
                    if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                        throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
                    }
                }
            }

            const fileBuffer = await fsp.readFile(tempFilePath);
            const success = await client.putFileContents(remotePath, fileBuffer, { overwrite: true });

            if (!success) {
                // 有些伺服器可能不回传错误但操作失败
                throw new Error('WebDAV putFileContents 操作返回 false。');
            }

            const stat = await client.stat(remotePath);
            const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
            const fileIdForDb = `${targetConfigId}:${remotePath}`;

            const dbResult = await data.addFile({
                message_id: messageId, fileName, mimetype, size: stat.size,
                file_id: fileIdForDb, date: new Date(stat.lastmod).getTime(),
            }, folderId, userId, 'webdav');
            
            console.log(`[WebDAV] 成功上传到伺服器 ID: ${targetConfigId}`);
            
            // *** 关键：上传成功后，更新轮询索引 ***
            storageManager.setLastUsedWebdavIndex(currentIndex);

            return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };

        } catch (error) {
            lastError = error;
            // *** 关键：检查是否为容量不足错误 (HTTP 507) ***
            if (error.response && error.response.status === 507) {
                console.warn(`[WebDAV] 伺服器 ${targetConfig.url} 容量已满 (507)。正在自动尝试下一个...`);
                continue; // 继续循环，尝试下一个伺服器
            } else {
                // 对于其他错误（如认证失败、网路问题），应立即失败并抛出
                console.error(`[WebDAV] 上传到 ${targetConfig.url} 时发生严重错误，已中断操作。`, error.message);
                throw error;
            }
        }
    }

    // 如果循环跑完都没有成功，表示所有伺服器都满了或不可用
    console.error("[WebDAV] 所有伺服器均上传失败。");
    throw new Error(`所有 WebDAV 伺服器均不可用或已满。最后记录的错误: ${lastError.message}`);
}

// remove, stream, getUrl 等函式维持不变
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

async function stream(file_id, userId) {
    const { configId, remotePath } = parseFileId(file_id);
    const webdavConfig = getWebdavConfigs().find(c => c.id == configId);
    if (!webdavConfig) throw new Error(`找不到与档案关联的 WebDAV 设定 (ID: ${configId})`);
    
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
