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

// --- 日志辅助函数 (带时间戳) ---
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
            const exists = await client.exists(currentPath);
            if (!exists) {
                log('INFO', FUNC_NAME, `创建目录: "${currentPath}"`);
                try {
                    await client.createDirectory(currentPath);
                } catch (e) {
                    if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                         log('WARN', FUNC_NAME, `创建目录可能失败: ${e.message}`);
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

async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '', existingItem = null) {
    const FUNC_NAME = 'upload';
    log('INFO', FUNC_NAME, `开始处理文件: "${fileName}"`);
    
    return new Promise(async (resolve, reject) => {
        let client; 
        let remotePath; 
        try {
            const webdavConfig = getWebdavConfig();
            // 为每个上传创建独立客户端实例，避免并发干扰
            client = createClient(webdavConfig.url, {
                username: webdavConfig.username,
                password: webdavConfig.password
            });

            const folderPath = await getFolderPath(folderId, userId);
            remotePath = (folderPath === '/' ? '' : folderPath) + '/' + fileName;
            
            if (folderPath && folderPath !== "/") {
                await ensureDirectoryExists(folderPath);
            }

            fileStream.on('error', err => {
                log('ERROR', FUNC_NAME, `输入流错误 "${fileName}":`, err);
                reject(new Error(`Stream Error: ${err.message}`));
            });

            log('DEBUG', FUNC_NAME, `执行 putFileContents: "${remotePath}"`);
            
            // 使用 createWriteStream 进行更底层的控制 (webdav 库支持)
            // 或者使用 putFileContents，但要确保它处理流错误
            const success = await client.putFileContents(remotePath, fileStream, { 
                overwrite: true, 
                onUploadProgress: (progress) => {
                    if (fileStream.destroyed) {
                        // 主动检测流是否被销毁
                        log('WARN', FUNC_NAME, `检测到流销毁: "${fileName}"`);
                    }
                }
            });

            if (!success) {
                throw new Error('WebDAV putFileContents 返回 false');
            }
            
            // --- 关键校验：检查上传后的文件大小 ---
            const stats = await client.stat(remotePath);
            log('DEBUG', FUNC_NAME, `上传后检查: "${fileName}", Size: ${stats.size}`);
            
            if (stats.size === 0) {
                // 如果远端文件是 0 字节，说明上传失败（可能是 Premature close 且被吞掉了）
                throw new Error('上传验证失败: 远端文件大小为 0 字节');
            }

            if (existingItem) {
                log('INFO', FUNC_NAME, `更新数据库 (覆盖): ${existingItem.id}`);
                await data.updateFile(existingItem.id, {
                    mimetype: mimetype,
                    file_id: remotePath,
                    size: stats.size,
                    date: Date.now(),
                }, userId);
                resolve({ success: true, message: '覆盖成功', fileId: existingItem.id });
            } else {
                const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
                log('INFO', FUNC_NAME, `写入数据库 (新增): ${messageId}`);
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
            log('ERROR', FUNC_NAME, `流程失败 for "${fileName}": ${error.message}`);
            if (fileStream && typeof fileStream.resume === 'function') {
                fileStream.resume();
            }
            
            // 发生错误时，尝试清理可能存在的 0KB 残留文件
            if (client && remotePath) {
                try {
                    log('INFO', FUNC_NAME, `清理残留文件: "${remotePath}"`);
                    await client.deleteFile(remotePath);
                } catch (e) { }
            }
            reject(error);
        }
    });
}

// ... remove, stream, getUrl, createDirectory 保持不变 ...
async function remove(files, folders, userId) {
    const client = getClient();
    const results = { success: true, errors: [] };
    const allItemsToDelete = [];
    files.forEach(file => {
        let p = file.file_id.startsWith('/') ? file.file_id : '/' + file.file_id;
        allItemsToDelete.push({ path: path.posix.normalize(p), type: 'file' });
    });
    folders.forEach(folder => {
        if (folder.path && folder.path !== '/') {
            let p = folder.path.startsWith('/') ? folder.path : '/' + folder.path;
            if (!p.endsWith('/')) { p += '/'; }
            allItemsToDelete.push({ path: p, type: 'folder' });
        }
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
        if (await client.exists(remotePath)) return true;
        await client.createDirectory(remotePath, { recursive: true });
        return true;
    } catch (e) {
        if (e.response && (e.response.status === 405 || e.response.status === 501)) return true;
        throw new Error(`建立目录失败: ${e.message}`);
    }
}

module.exports = { upload, remove, getUrl, stream, resetClient, getClient, createDirectory, type: 'webdav' };
