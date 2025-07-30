const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');
const storageManager = require('./index.js');

// 客户端缓存：用 Map 来储存不同 ID 对应的客户端实例
const clientsCache = new Map();

// 获取特定 WebDAV 设定的客户端，并进行快取
function getClient(storageId) {
    if (clientsCache.has(storageId)) {
        return clientsCache.get(storageId);
    }
    
    const config = storageManager.readConfig();
    const webdavConfig = config.webdav.find(c => c.id === storageId);

    if (!webdavConfig) {
        throw new Error(`找不到 ID 为 "${storageId}" 的 WebDAV 设定`);
    }

    const client = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
    
    clientsCache.set(storageId, client);
    return client;
}

// 当设定变更时，清空所有快取的客户端
function resetClient() {
    clientsCache.clear();
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

// 上传函数现在需要知道要上传到哪个 storageId
async function upload(tempFilePath, fileName, mimetype, userId, folderId, storage_id) {
    if (!storage_id) {
        throw new Error("上传时未提供 storage_id");
    }
    const client = getClient(storage_id);
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

    const fileBuffer = await fsp.readFile(tempFilePath);
    const success = await client.putFileContents(remotePath, fileBuffer, { overwrite: true });

    if (!success) {
        throw new Error('WebDAV putFileContents 操作失败');
    }

    const stat = await client.stat(remotePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    // **重要**：将 storage_id 存入数据库
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stat.size,
        file_id: remotePath,
        date: new Date(stat.lastmod).getTime(),
        storage_id: storage_id // 储存来源ID
    }, folderId, userId, 'webdav');
    
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}


async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };

    // **新生**：按 storage_id 对档案和资料夹进行分组
    const groupedItems = {};
    const allItems = [
        ...files.map(f => ({ ...f, itemType: 'file' })),
        ...folders.map(f => ({ ...f, itemType: 'folder' }))
    ];
    
    for (const item of allItems) {
        const sid = item.storage_id;
        if (!sid) {
            console.warn(`项目 ${item.file_id || item.path} 缺少 storage_id，无法删除。`);
            continue;
        }
        if (!groupedItems[sid]) {
            groupedItems[sid] = [];
        }
        groupedItems[sid].push(item);
    }
    
    // 针对每个 WebDAV 伺服器分别执行删除
    for (const storageId in groupedItems) {
        try {
            const client = getClient(storageId);
            const itemsToDelete = groupedItems[storageId];

            const allPaths = itemsToDelete.map(item => {
                let p = item.itemType === 'file' ? item.file_id : item.path;
                p = p.startsWith('/') ? p : '/' + p;
                if (item.itemType === 'folder' && !p.endsWith('/')) {
                    p += '/';
                }
                return { path: path.posix.normalize(p), type: item.itemType };
            });

            allPaths.sort((a, b) => b.path.length - a.path.length);

            for (const item of allPaths) {
                try {
                    await client.deleteFile(item.path);
                } catch (error) {
                    if (!(error.response && error.response.status === 404)) {
                         const errorMessage = `删除 WebDAV ${item.type} [${item.path}] 从 ${storageId} 失败: ${error.message}`;
                         console.error(errorMessage);
                         results.errors.push(errorMessage);
                         results.success = false;
                    }
                }
            }
        } catch (e) {
            const errorMessage = `处理储存 ${storageId} 的删除任务失败: ${e.message}`;
            console.error(errorMessage);
            results.errors.push(errorMessage);
            results.success = false;
        }
    }
    return results;
}

// 流式传输和获取 URL 现在也需要 storage_id
async function stream(file_id, storage_id) {
    const client = getClient(storage_id);
    return client.createReadStream(path.posix.join('/', file_id));
}

async function getUrl(file_id, storage_id) {
    const client = getClient(storage_id);
    return client.getFileDownloadLink(path.posix.join('/', file_id));
}

module.exports = { upload, remove, getUrl, stream, resetClient, type: 'webdav' };
