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
    // const timestamp = new Date().toISOString();
    // console.log(`[${timestamp}] [${level}] [${FILE_NAME}:${func}] - ${message}`, ...args);
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

async function ensureDirectoryExists(fullPath) {
    const FUNC_NAME = 'ensureDirectoryExists';
    if (!fullPath || fullPath === "/") return;
    
    while (creatingDirs.has(fullPath)) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    creatingDirs.add(fullPath);

    try {
        const client = getClient();
        const pathParts = fullPath.split('/').filter(p => p);
        let currentPath = '';

        for (const part of pathParts) {
            currentPath += `/${part}`;
            log('DEBUG', FUNC_NAME, `检查目录是否存在: "${currentPath}"`);
            const exists = await client.exists(currentPath);
            if (!exists) {
                log('INFO', FUNC_NAME, `目录不存在，正在创建: "${currentPath}"`);
                try {
                    await client.createDirectory(currentPath);
                } catch (e) {
                    if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                         throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
                    }
                }
            }
        }
    } finally {
        creatingDirs.delete(fullPath);
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

async function upload(fileStream, fileNameObject, mimetype, userId, folderId) {
    const FUNC_NAME = 'upload';
    // --- 关键修正：从物件中解构出原始档名和安全档名 ---
    const { originalFileName, safeFileName } = fileNameObject;
    log('INFO', FUNC_NAME, `开始上传文件: "${originalFileName}" (储存为 "${safeFileName}") 到 WebDAV...`);
    
    return new Promise(async (resolve, reject) => {
        try {
            const client = getClient();
            const folderPath = await getFolderPath(folderId, userId);
            // --- 关键修正：使用安全档名建立储存路径 ---
            const safeStoragePath = (folderPath === '/' ? '' : folderPath) + '/' + safeFileName;
            
            if (folderPath && folderPath !== "/") {
                await ensureDirectoryExists(folderPath);
            }
            
            fileStream.on('error', err => {
                log('ERROR', FUNC_NAME, `输入文件流 (fileStream) 发生错误 for "${originalFileName}":`, err);
                reject(new Error(`输入文件流中断: ${err.message}`));
            });

            log('DEBUG', FUNC_NAME, `正在调用 putFileContents 上传到: "${safeStoragePath}"`);
            const success = await client.putFileContents(safeStoragePath, fileStream, { overwrite: true });

            if (!success) {
                return reject(new Error('WebDAV putFileContents 操作失败'));
            }
            log('INFO', FUNC_NAME, `文件成功上传到 WebDAV: "${safeFileName}"`);

            const stats = await client.stat(safeStoragePath);
            log('DEBUG', FUNC_NAME, `获取 WebDAV 文件状态成功，大小: ${stats.size}`);
            const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

            // --- 关键修正：向 data.js 传入原始档名和安全路径 ---
            const dbResult = await data.addFile({
                message_id: messageId,
                originalFileName: originalFileName,
                mimetype,
                size: stats.size,
                safeStoragePath: safeStoragePath,
                date: Date.now(),
            }, folderId, userId, 'webdav');
            
            log('INFO', FUNC_NAME, `文件 "${originalFileName}" 已成功存入资料库。`);
            resolve({ success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId });

        } catch (error) {
            log('ERROR', FUNC_NAME, `上传到 WebDAV 失败 for "${originalFileName}":`, error);
            if (fileStream && typeof fileStream.resume === 'function') {
                fileStream.resume();
            }
            reject(error);
        }
    });
}


async function remove(files, folders, userId) {
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

async function createDirectory(fullPath) {
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
