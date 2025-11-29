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

// 确保远程目录存在
async function ensureDirectoryExists(fullPath) {
    const FUNC_NAME = 'ensureDirectoryExists';
    // 规范化路径，移除多余斜杠
    const normalizedPath = path.posix.normalize(fullPath);
    if (!normalizedPath || normalizedPath === "/") return;
    
    while (creatingDirs.has(normalizedPath)) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    creatingDirs.add(normalizedPath);

    try {
        const client = getClient();
        // 将路径拆分并逐级检查
        const pathParts = normalizedPath.split('/').filter(p => p);
        let currentPath = '';

        for (const part of pathParts) {
            currentPath += `/${part}`;
            const exists = await client.exists(currentPath);
            if (!exists) {
                log('INFO', FUNC_NAME, `创建目录: "${currentPath}"`);
                try {
                    await client.createDirectory(currentPath);
                } catch (e) {
                    // 忽略特定错误代码 (405 Method Not Allowed, 501 Not Implemented 往往意味着目录已存在或父目录问题)
                    if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                         log('WARN', FUNC_NAME, `创建目录可能失败: ${e.message}`);
                    }
                }
            }
        }
    } finally {
        creatingDirs.delete(normalizedPath);
    }
}

// 获取不带任何强制前缀的纯净路径
async function getFolderPath(folderId, userId) {
    const userRoot = await new Promise((resolve, reject) => {
        db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId], (err, row) => {
            if (err) return reject(err);
            if (!row) return reject(new Error('找不到使用者根目录'));
            resolve(row);
        });
    });

    // 如果是根目录，返回 '/'
    if (folderId === userRoot.id) return '/';
    
    // 获取文件夹层级数组
    const pathParts = await data.getFolderPath(folderId, userId);
    
    // 拼接路径：去掉第一个 root，剩下的用 / 连接
    // 结果类似 "/我的文档/工作"
    const relativePath = pathParts.slice(1).map(p => p.name).join('/');
    return '/' + relativePath;
}

async function upload(fileStreamOrBuffer, fileName, mimetype, userId, folderId, caption = '', existingItem = null) {
    const FUNC_NAME = 'upload';
    log('INFO', FUNC_NAME, `开始处理文件: "${fileName}"`);
    
    return new Promise(async (resolve, reject) => {
        let client; 
        let remotePath; 
        try {
            const webdavConfig = getWebdavConfig();
            client = createClient(webdavConfig.url, {
                username: webdavConfig.username,
                password: webdavConfig.password
            });

            // 1. 获取目标文件夹路径 (绝对路径，基于 WebDAV 根)
            let folderPath = await getFolderPath(folderId, userId);
            
            // 2. 规范化路径
            folderPath = path.posix.normalize(folderPath);
            if (!folderPath.startsWith('/')) folderPath = '/' + folderPath;

            // 3. 拼接完整文件路径
            // path.posix.join 会自动处理多余的斜杠
            remotePath = path.posix.join(folderPath, fileName);
            
            // 4. 确保目录存在 (除了根目录)
            if (folderPath && folderPath !== "/") {
                await ensureDirectoryExists(folderPath);
            }

            if (fileStreamOrBuffer && typeof fileStreamOrBuffer.on === 'function') {
                fileStreamOrBuffer.on('error', err => {
                    log('ERROR', FUNC_NAME, `输入流错误 "${fileName}":`, err);
                    reject(new Error(`Stream Error: ${err.message}`));
                });
            }

            log('DEBUG', FUNC_NAME, `执行 putFileContents: "${remotePath}"`);
            
            let options = { overwrite: true };
            
            if (fileStreamOrBuffer && fileStreamOrBuffer.path && typeof fileStreamOrBuffer.path === 'string') {
                try {
                    const fsStats = fs.statSync(fileStreamOrBuffer.path);
                    options.contentLength = fsStats.size;
                    log('DEBUG', FUNC_NAME, `检测到本地文件流，设置 Content-Length: ${fsStats.size}`);
                } catch (e) {
                    log('WARN', FUNC_NAME, `无法获取本地流文件大小: ${e.message}`);
                }
            }

            const success = await client.putFileContents(remotePath, fileStreamOrBuffer, options);

            if (!success) {
                throw new Error('WebDAV putFileContents 返回 false');
            }
            
            const stats = await client.stat(remotePath);
            
            if (stats.size === 0) {
                throw new Error('上传验证失败: 远端文件大小为 0 字节');
            }

            if (existingItem) {
                await data.updateFile(existingItem.id, {
                    mimetype: mimetype,
                    file_id: remotePath, // 直接存储 WebDAV 上的绝对路径
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
                    file_id: remotePath, // 直接存储 WebDAV 上的绝对路径
                    date: Date.now(),
                }, folderId, userId, 'webdav');
                resolve({ success: true, message: '上传成功', fileId: dbResult.fileId });
            }

        } catch (error) {
            log('ERROR', FUNC_NAME, `流程失败 for "${fileName}": ${error.message}`);
            if (fileStreamOrBuffer && typeof fileStreamOrBuffer.resume === 'function') {
                fileStreamOrBuffer.resume();
            }
            if (client && remotePath) {
                try {
                    await client.deleteFile(remotePath);
                } catch (e) { }
            }
            reject(error);
        }
    });
}

async function remove(files, folders, userId) {
    const client = getClient();
    const results = { success: true, errors: [] };
    const allItemsToDelete = [];
    
    // 直接使用数据库中的 file_id (它是绝对路径)
    files.forEach(file => {
        let p = path.posix.normalize(file.file_id);
        allItemsToDelete.push({ path: p, type: 'file' });
    });
    
    // 文件夹 path 也是绝对路径
    folders.forEach(folder => {
        let p = path.posix.normalize(folder.path);
        // 确保文件夹路径以 / 结尾 (WebDAV 规范建议，尽管 deleteFile 可能不需要)
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

// 修正: 完全信任 file_id，不做任何路径前缀假设
async function stream(file_id, userId, options = {}) {
    const webdavConfig = getWebdavConfig();
    const streamClient = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
    
    // 确保是 POSIX 路径。如果 DB 里存的是 /共享/a.txt，这里就是 /共享/a.txt
    // WebDAV 客户端通常接受带前导斜杠的路径
    const remotePath = file_id.replace(/\\/g, '/');
    
    log('INFO', 'stream', `请求文件流: ${remotePath}`);
    return streamClient.createReadStream(remotePath, options);
}

// 修正: 完全信任 file_id
async function getUrl(file_id, userId) {
    const client = getClient();
    const remotePath = file_id.replace(/\\/g, '/');
    return client.getFileDownloadLink(remotePath);
}

async function createDirectory(fullPath) {
    const client = getClient();
    try {
        const remotePath = fullPath.replace(/\\/g, '/');
        if (await client.exists(remotePath)) return true;
        await client.createDirectory(remotePath, { recursive: true });
        return true;
    } catch (e) {
        if (e.response && (e.response.status === 405 || e.response.status === 501)) return true;
        throw new Error(`建立目录失败: ${e.message}`);
    }
}

module.exports = { upload, remove, getUrl, stream, resetClient, getClient, createDirectory, type: 'webdav' };
