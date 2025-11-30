// storage/webdav.js
const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'storage/webdav.js';
let client = null;
// 修改：使用 Map 存储正在进行的 Promise，而不是 Set
const creatingDirs = new Map(); 

// --- 日志辅助函数 ---
const log = (level, func, message, ...args) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [WEBDAV:${level}] [${func}] - ${message}`, ...args);
};

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

// --- 路径规范化 ---
function normalizePath(p) {
    if (!p) return '/';
    let normalized = p.replace(/\\/g, '/');
    normalized = path.posix.normalize(normalized);
    if (!normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }
    if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
}

// 核心修复：防止并发创建目录时的竞争条件
async function ensureDirectoryExists(fullPath) {
    const FUNC_NAME = 'ensureDirectoryExists';
    const remotePath = normalizePath(fullPath);
    
    if (remotePath === "/") return;
    
    // 如果已经有正在进行的创建任务，则等待它完成
    if (creatingDirs.has(remotePath)) {
        // log('DEBUG', FUNC_NAME, `等待目录创建: ${remotePath}`);
        return creatingDirs.get(remotePath);
    }

    // 创建一个新的 Promise 任务
    const creationPromise = (async () => {
        try {
            const client = getClient();
            const parts = remotePath.split('/').filter(p => p);
            let current = '';

            for (const part of parts) {
                current += '/' + part;
                // 再次检查 Map，防止父级目录并发冲突 (虽然 WebDAV 客户端通常能处理)
                // 但这里我们主要依赖外部的 exists 检查
                
                // 优化：只有当 WebDAV 服务器返回目录不存在时才尝试创建
                // 注意：高并发下 client.exists 也可能产生额外开销，但在本逻辑中
                // 同一路径的并发已被 Promise 合并，所以是安全的。
                const exists = await client.exists(current);
                if (!exists) {
                    log('INFO', FUNC_NAME, `创建目录: "${current}"`);
                    try {
                        await client.createDirectory(current);
                    } catch (e) {
                        // 忽略 405 (Method Not Allowed - 通常意味着已存在)
                        if (e.response && e.response.status !== 405) {
                            // 记录警告但不抛出，尝试继续上传
                            log('WARN', FUNC_NAME, `创建目录可能有误 (可能是并发导致已存在): ${e.message}`);
                        }
                    }
                }
            }
        } finally {
            // 任务完成后（无论成功失败），从 Map 中移除
            creatingDirs.delete(remotePath);
        }
    })();

    // 将 Promise 存入 Map
    creatingDirs.set(remotePath, creationPromise);
    
    // 等待执行
    return creationPromise;
}

async function getFolderPath(folderId, userId) {
    const pathParts = await data.getFolderPath(folderId, userId);
    const fullPath = path.posix.join('/', ...pathParts.slice(1).map(p => p.name));
    return normalizePath(fullPath);
}

async function upload(fileStreamOrBuffer, fileName, mimetype, userId, folderId, caption = '', existingItem = null) {
    const FUNC_NAME = 'upload';
    // log('INFO', FUNC_NAME, `开始上传: "${fileName}"`);
    
    return new Promise(async (resolve, reject) => {
        let remotePath = ''; 
        try {
            const client = getClient();
            const folderPath = await getFolderPath(folderId, userId);
            
            // 等待目录确保逻辑完成
            await ensureDirectoryExists(folderPath);

            remotePath = normalizePath(path.posix.join(folderPath, fileName));
            
            let options = { overwrite: true };
            if (fileStreamOrBuffer && fileStreamOrBuffer.path) {
                try {
                    const stats = fs.statSync(fileStreamOrBuffer.path);
                    options.contentLength = stats.size;
                } catch (e) { }
            }

            log('DEBUG', FUNC_NAME, `PUT: ${remotePath}`);
            
            // 增加简单的重试机制，应对短暂的 403/429/Network Error
            let retries = 1;
            while (retries >= 0) {
                try {
                    const result = await client.putFileContents(remotePath, fileStreamOrBuffer, options);
                    if (result === false) throw new Error('WebDAV putFileContents returned false');
                    break; // 成功则跳出循环
                } catch (err) {
                    if (retries > 0) {
                        log('WARN', FUNC_NAME, `上传失败，正在重试 (${retries}次剩余): ${err.message}`);
                        await new Promise(r => setTimeout(r, 1000)); // 等待 1 秒
                        retries--;
                        // 如果是 Stream，可能无法重试（除非是文件流且重新创建），
                        // 但 Busboy 传入 Buffer 模式下是 Buffer/FileStream，
                        // 在 server.js 的 buffer 模式下是 fs.createReadStream，可以重试吗？
                        // fs.createReadStream 一旦消耗就没了。
                        // 所以这里如果是 Stream 且报错，重试可能会再次失败。
                        // 但是 server.js 现在的 Buffer 模式我们传的是 fs.createReadStream(tempPath)。
                        // 如果流被消耗了，重试需要重新创建流。
                        
                        // 简单修复：如果是流且已出错，直接抛出，只重试 Buffer
                        if (typeof fileStreamOrBuffer.pipe === 'function') {
                             throw err; 
                        }
                    } else {
                        throw err;
                    }
                }
            }
            
            const stats = await client.stat(remotePath);
            if (stats.size === 0 && options.contentLength > 0) {
                 throw new Error('上传验证失败: 远端文件为 0 字节');
            }

            if (existingItem) {
                await data.updateFile(existingItem.id, {
                    mimetype: mimetype,
                    file_id: remotePath,
                    size: stats.size,
                    date: Date.now(),
                }, userId);
                resolve({ success: true, message: '覆盖成功', fileId: existingItem.id });
            } else {
                const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
                const dbResult = await data.addFile({
                    message_id: messageId,
                    fileName,
                    mimetype,
                    size: stats.size,
                    file_id: remotePath, 
                    date: Date.now(),
                }, folderId, userId, 'webdav');
                resolve({ success: true, message: '上传成功', fileId: dbResult.fileId });
            }

        } catch (error) {
            log('ERROR', FUNC_NAME, `失败: ${error.message}`);
            // if (remotePath) { try { await getClient().deleteFile(remotePath); } catch (e) {} } // 失败通常意味着文件没上去，删除多余
            reject(error);
        }
    });
}

async function remove(files, folders, userId) {
    const client = getClient();
    const results = { success: true, errors: [] };
    const allItemsToDelete = [];
    
    files.forEach(file => {
        const p = normalizePath(file.file_id);
        if (p !== '/' && p !== '') { 
            allItemsToDelete.push({ path: p, type: 'file' });
        }
    });
    folders.forEach(folder => {
        let p = normalizePath(folder.path);
        if (p === '/' || p === '') {
            log('WARN', 'remove', '尝试删除根目录被阻止');
            return;
        }
        if (!p.endsWith('/')) { p += '/'; }
        allItemsToDelete.push({ path: p, type: 'folder' });
    });
    
    allItemsToDelete.sort((a, b) => b.path.length - a.path.length);
    for (const item of allItemsToDelete) {
        try {
            log('INFO', 'remove', `删除: ${item.path}`);
            await client.deleteFile(item.path);
        } catch (error) {
            if (!(error.response && error.response.status === 404)) {
                results.errors.push(`删除失败 [${item.path}]: ${error.message}`);
                results.success = false;
            }
        }
    }
    return results;
}

async function stream(file_id, userId, options = {}) {
    const remotePath = normalizePath(file_id);
    log('INFO', 'stream', `请求流: ${remotePath}`);
    
    const webdavConfig = getWebdavConfig();
    const streamClient = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });

    return streamClient.createReadStream(remotePath, options);
}

async function getUrl(file_id, userId) {
    const client = getClient();
    const remotePath = normalizePath(file_id);
    return client.getFileDownloadLink(remotePath);
}

async function createDirectory(fullPath) {
    const client = getClient();
    const remotePath = normalizePath(fullPath);
    try {
        if (await client.exists(remotePath)) return true;
        await client.createDirectory(remotePath, { recursive: true });
        return true;
    } catch (e) {
        if (e.response && (e.response.status === 405 || e.response.status === 501)) return true;
        throw new Error(`建立目录失败: ${e.message}`);
    }
}

module.exports = { upload, remove, getUrl, stream, resetClient, getClient, createDirectory, type: 'webdav' };
