const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

// 这个 client 将只用于写入和删除等非流式操作
let client = null;

// 封装一个获取配置的函数，避免重复代码
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

async function removeEmptyDirs(directoryPath) {
    const client = getClient();
    try {
        let currentPath = directoryPath;
        while (currentPath && currentPath !== '/') {
            const contents = await client.getDirectoryContents(currentPath);
            if (contents.length === 0) {
                await client.deleteDirectory(currentPath);
                currentPath = path.dirname(currentPath).replace(/\\/g, '/');
            } else {
                break;
            }
        }
    } catch (error) {
         if (error.response && error.response.status !== 404) {
            console.warn(`清理 WebDAV 空目录失败: ${directoryPath}`, error.message);
         }
    }
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
    const parentDirs = new Set();
    const results = { success: true, errors: [] };
    const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    async function deleteWithRetry(deleteFunc, itemPath) {
        let retries = 3;
        let lastError = null;
        while (retries > 0) {
            try {
                await deleteFunc(itemPath);
                return; // 成功则直接返回
            } catch (error) {
                lastError = error;
                if (error.response && error.response.status === 423 && retries > 1) {
                    console.warn(`[${itemPath}] 被锁定，将在 500ms 后重试... (剩余 ${retries - 1} 次)`);
                    await delay(500); // 增加延迟时间
                    retries--;
                } else {
                    throw error; // 对于其他错误或最后一次重试失败，直接抛出
                }
            }
        }
        throw lastError; // 确保即使重试失败，最终错误也会被抛出
    }

    for (const file of files) {
        try {
            const remotePath = path.posix.join('/', file.file_id);
            await deleteWithRetry(client.deleteFile.bind(client), remotePath);
            parentDirs.add(path.dirname(remotePath).replace(/\\/g, '/'));
        } catch (error) {
            if (error.response && error.response.status !== 404) {
                 const errorMessage = `删除 WebDAV 档案 [${file.file_id}] 失败: ${error.message}`;
                 console.error(errorMessage); // 改为 error 级别，因为这是一个关键失败
                 results.errors.push(errorMessage);
                 results.success = false;
            }
        }
    }

    if (folders && folders.length > 0) {
        const sortedFolders = folders.sort((a, b) => b.path.length - a.path.length);
        for (const folder of sortedFolders) {
            try {
                if (folder.path === '/') continue;
                const remotePath = path.posix.join('/', folder.path);
                await deleteWithRetry(client.deleteDirectory.bind(client), remotePath);
                parentDirs.add(path.dirname(remotePath).replace(/\\/g, '/'));
            } catch (error) {
                if (error.response && error.response.status !== 404) {
                     const errorMessage = `删除 WebDAV 目录 [${folder.path}] 失败: ${error.message}`;
                     console.error(errorMessage);
                     results.errors.push(errorMessage);
                     results.success = false;
                }
            }
        }
    }

    const sortedParentDirs = Array.from(parentDirs).sort((a, b) => b.length - a.length);
    for (const dir of sortedParentDirs) {
        await removeEmptyDirs(dir);
    }

    return results;
}

// 最终修复：为每个流操作创建一个完全独立的客户端实例
async function stream(file_id, userId) {
    const webdavConfig = getWebdavConfig();
    const streamClient = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
    // 使用这个一次性的客户端来创建流
    return streamClient.createReadStream(path.posix.join('/', file_id));
}

async function getUrl(file_id, userId) {
    const client = getClient();
    return client.getFileDownloadLink(path.posix.join('/', file_id));
}

module.exports = { upload, remove, getUrl, stream, resetClient, type: 'webdav' };
