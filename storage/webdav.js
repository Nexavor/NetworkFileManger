const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
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

async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
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

    const fileBuffer = await fsp.readFile(tempFilePath);
    const success = await client.putFileContents(remotePath, fileBuffer, { overwrite: true });

    if (!success) {
        throw new Error('WebDAV putFileContents 操作失败');
    }

    const stat = await client.stat(remotePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stat.size,
        file_id: remotePath,
        date: new Date(stat.lastmod).getTime(),
    }, folderId, userId, 'webdav');
    
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}


async function remove(files, folders, userId) {
    const client = getClient();
    const results = { success: true, errors: [] };
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    async function deleteWithRetry(deleteFunc, itemPath) {
        let lastError = null;
        for (let i = 0; i < 3; i++) {
            try {
                await deleteFunc(itemPath);
                return; // 成功则直接返回
            } catch (error) {
                lastError = error;
                if (error.response && error.response.status === 423 && i < 2) {
                    console.warn(`[${itemPath}] 被锁定，将在 500ms 后重试...`);
                    await delay(500);
                } else if (error.response && error.response.status === 404) {
                    // 如果是 404，说明已经被删除，视为成功
                    return;
                } else {
                    // 对于其他错误或最后一次重试失败，直接抛出
                    throw error;
                }
            }
        }
        throw lastError; // 确保即使重试失败，最终错误也会被抛出
    }

    // 1. 创建统一的待删除项目列表
    const allItemsToDelete = [];
    files.forEach(file => {
        // Bug 2 修复：确保所有档案路径都是绝对路径
        const cleanPath = file.file_id.startsWith('/') ? file.file_id : '/' + file.file_id;
        allItemsToDelete.push({
            path: path.posix.normalize(cleanPath),
            type: 'file'
        });
    });
    folders.forEach(folder => {
        if (folder.path && folder.path !== '/') {
            allItemsToDelete.push({
                path: path.posix.normalize(folder.path),
                type: 'folder'
            });
        }
    });

    // 2. 按路径深度降序排序，确保先删除子项
    allItemsToDelete.sort((a, b) => b.path.length - a.path.length);

    // 3. 依次执行删除
    for (const item of allItemsToDelete) {
        try {
            const deleteFunc = item.type === 'file'
                ? client.deleteFile.bind(client)
                : client.deleteDirectory.bind(client);
            
            await deleteWithRetry(deleteFunc, item.path);
        } catch (error) {
            // 404 错误已经被 deleteWithRetry 内部处理，这里只记录其他真正失败的错误
            const errorMessage = `删除 WebDAV ${item.type} [${item.path}] 失败: ${error.message}`;
            console.error(errorMessage);
            results.errors.push(errorMessage);
            results.success = false;
        }
    }

    return results;
}

async function stream(file_id, userId) {
    const webdavConfig = getWebdavConfig();
    const streamClient = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
    return streamClient.createReadStream(path.posix.join('/', file_id));
}

async function getUrl(file_id, userId) {
    const client = getClient();
    return client.getFileDownloadLink(path.posix.join('/', file_id));
}

module.exports = { upload, remove, getUrl, stream, resetClient, type: 'webdav' };
