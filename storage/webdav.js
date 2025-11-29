// storage/webdav.js
const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'storage/webdav.js';
let client = null;
const creatingDirs = new Set();

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
// 确保路径始终以 / 开头，符合 WebDAV 绝对路径标准
function normalizePath(p) {
    if (!p) return '/';
    // 统一使用正斜杠
    let normalized = p.replace(/\\/g, '/');
    // 解析 . 和 ..
    normalized = path.posix.normalize(normalized);
    // 强制以 / 开头
    if (!normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }
    // 移除末尾的 / (除非是根目录)
    if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
}

async function ensureDirectoryExists(fullPath) {
    const FUNC_NAME = 'ensureDirectoryExists';
    const remotePath = normalizePath(fullPath);
    
    if (remotePath === "/") return;
    
    if (creatingDirs.has(remotePath)) return;
    creatingDirs.add(remotePath);

    try {
        const client = getClient();
        const parts = remotePath.split('/').filter(p => p);
        let current = '';

        for (const part of parts) {
            current += '/' + part;
            const exists = await client.exists(current);
            if (!exists) {
                log('INFO', FUNC_NAME, `创建目录: "${current}"`);
                try {
                    await client.createDirectory(current);
                } catch (e) {
                    // 忽略特定错误 (405 Method Not Allowed)
                    if (e.response && e.response.status !== 405) {
                        log('WARN', FUNC_NAME, `创建目录可能有误: ${e.message}`);
                    }
                }
            }
        }
    } finally {
        creatingDirs.delete(remotePath);
    }
}

async function getFolderPath(folderId, userId) {
    const pathParts = await data.getFolderPath(folderId, userId);
    // 强制使用绝对路径构建
    const fullPath = path.posix.join('/', ...pathParts.slice(1).map(p => p.name));
    return normalizePath(fullPath);
}

async function upload(fileStreamOrBuffer, fileName, mimetype, userId, folderId, caption = '', existingItem = null) {
    const FUNC_NAME = 'upload';
    log('INFO', FUNC_NAME, `开始上传: "${fileName}"`);
    
    return new Promise(async (resolve, reject) => {
        let remotePath = ''; 
        try {
            const client = getClient();
            const folderPath = await getFolderPath(folderId, userId);
            
            await ensureDirectoryExists(folderPath);

            // 构造完整绝对路径
            remotePath = normalizePath(path.posix.join(folderPath, fileName));
            
            let options = { overwrite: true };
            if (fileStreamOrBuffer && fileStreamOrBuffer.path) {
                try {
                    const stats = fs.statSync(fileStreamOrBuffer.path);
                    options.contentLength = stats.size;
                } catch (e) { }
            }

            log('DEBUG', FUNC_NAME, `PUT: ${remotePath}`);
            const result = await client.putFileContents(remotePath, fileStreamOrBuffer, options);
            if (result === false) throw new Error('WebDAV putFileContents returned false');
            
            const stats = await client.stat(remotePath);
            if (stats.size === 0 && options.contentLength > 0) {
                 throw new Error('上传验证失败: 远端文件为 0 字节');
            }

            if (existingItem) {
                await data.updateFile(existingItem.id, {
                    mimetype: mimetype,
                    file_id: remotePath, // 存入 DB 的是绝对路径
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
                    file_id: remotePath, // 存入 DB 的是绝对路径
                    date: Date.now(),
                }, folderId, userId, 'webdav');
                resolve({ success: true, message: '上传成功', fileId: dbResult.fileId });
            }

        } catch (error) {
            log('ERROR', FUNC_NAME, `失败: ${error.message}`);
            if (remotePath) { try { await getClient().deleteFile(remotePath); } catch (e) {} }
            reject(error);
        }
    });
}

async function remove(files, folders, userId) {
    const client = getClient();
    const results = { success: true, errors: [] };
    const allItemsToDelete = [];
    
    files.forEach(file => {
        allItemsToDelete.push({ path: normalizePath(file.file_id), type: 'file' });
    });
    folders.forEach(folder => {
        let p = normalizePath(folder.path);
        if (!p.endsWith('/')) { p += '/'; }
        allItemsToDelete.push({ path: p, type: 'folder' });
    });
    
    allItemsToDelete.sort((a, b) => b.path.length - a.path.length);
    for (const item of allItemsToDelete) {
        try {
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
    // 关键修正：不做任何去前缀操作，完全信任 normalizePath 产生的绝对路径
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
