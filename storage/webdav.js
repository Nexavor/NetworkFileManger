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

    const pathParts = await data.getFolderPath(folderId, userId);
    
    // 从路径数组中提取相对路径（跳过第一个根目录 '/'）
    const relativePath = pathParts.slice(1).map(p => p.name).join('/');
    
    // 构造 WebDAV 绝对路径： /user_{userId}/<relative/path>
    const userPrefix = `user_${userId}`;
    let finalPath;
    if (relativePath) {
         finalPath = path.posix.join('/', userPrefix, relativePath);
    } else {
         // 如果是根目录，只返回 /user_{userId}
         finalPath = path.posix.join('/', userPrefix);
    }

    return finalPath;
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

            // 使用修正后的 getFolderPath 获取路径，例如 /user_1/folder/subfolder
            const folderPath = await getFolderPath(folderId, userId); 
            
            // 构造远程文件绝对路径，例如 /user_1/folder/subfolder/fileName
            remotePath = path.posix.join(folderPath, fileName);
            
            if (folderPath && folderPath !== path.posix.join('/', `user_${userId}`)) {
                await ensureDirectoryExists(folderPath);
            }

            // 如果传入的是流，绑定错误处理
            if (fileStreamOrBuffer && typeof fileStreamOrBuffer.on === 'function') {
                fileStreamOrBuffer.on('error', err => {
                    log('ERROR', FUNC_NAME, `输入流错误 "${fileName}":`, err);
                    reject(new Error(`Stream Error: ${err.message}`));
                });
            }

            log('DEBUG', FUNC_NAME, `执行 putFileContents: "${remotePath}"`);
            
            let options = { overwrite: true };
            
            // --- 关键修正：自动检测并设置 Content-Length ---
            // 如果传入的是本地文件流 (fs.ReadStream)，自动获取文件大小
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
            log('DEBUG', FUNC_NAME, `上传后检查: "${fileName}", Size: ${stats.size}`);
            
            if (stats.size === 0) {
                throw new Error('上传验证失败: 远端文件大小为 0 字节');
            }

            if (existingItem) {
                log('INFO', FUNC_NAME, `更新数据库 (覆盖): ${existingItem.id}`);
                await data.updateFile(existingItem.id, {
                    mimetype: mimetype,
                    file_id: remotePath, // 存储带前导斜杠的路径
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
                    file_id: remotePath, // 存储带前导斜杠的路径
                    date: Date.now(),
                }, folderId, userId, 'webdav');
                resolve({ success: true, message: '上传成功', fileId: dbResult.fileId });
            }

        } catch (error) {
            log('ERROR', FUNC_NAME, `流程失败 for "${fileName}": ${error.message}`);
            if (fileStreamOrBuffer && typeof fileStreamOrBuffer.resume === 'function') {
                fileStreamOrBuffer.resume();
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

async function remove(files, folders, userId) {
    const client = getClient();
    const results = { success: true, errors: [] };
    const allItemsToDelete = [];
    files.forEach(file => {
        // file.file_id 应该已经是 WebDAV 绝对路径（以 /user_XX/ 开头）
        let p = file.file_id.replace(/\\/g, '/');
        if (!p.startsWith('/')) p = '/' + p; // 确保是绝对路径
        allItemsToDelete.push({ path: path.posix.normalize(p), type: 'file' });
    });
    folders.forEach(folder => {
        // folder.path 是 WebDAV 绝对路径
        let p = folder.path.replace(/\\/g, '/');
        if (!p.startsWith('/')) p = '/' + p; // 确保是绝对路径
        if (!p.endsWith('/')) { p += '/'; }
        allItemsToDelete.push({ path: p, type: 'folder' });
    });
    // 对路径进行排序，先删除子目录，再删除父目录
    allItemsToDelete.sort((a, b) => b.path.length - a.path.length); 
    for (const item of allItemsToDelete) {
        try {
            await client.deleteFile(item.path);
        } catch (error) {
            // 忽略 404 (文件不存在) 的错误
            if (!(error.response && error.response.status === 404)) {
                results.errors.push(`删除失败 [${item.path}]: ${error.message}`);
                results.success = false;
            }
        }
    }
    return results;
}

async function stream(file_id, userId, options = {}) {
    const webdavConfig = getWebdavConfig();
    const streamClient = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
    
    // Determine the absolute remote path
    const remotePath = file_id.replace(/\\/g, '/'); 
    let finalRemotePath;

    // 修正: 检查 file_id 是否包含用户前缀。如果不包含，则假设它是旧格式，手动添加前缀。
    if (remotePath.includes(`/user_${userId}/`)) {
        finalRemotePath = remotePath;
    } else {
        // 假设它是旧格式，例如 `/共享/文件.txt`。
        const relativePathWithoutLeadingSlash = remotePath.replace(/^\//, '');
        finalRemotePath = path.posix.join('/', `user_${userId}`, relativePathWithoutLeadingSlash);
    }
    // 确保 finalRemotePath 仍然以 / 开头
    if (!finalRemotePath.startsWith('/')) finalRemotePath = '/' + finalRemotePath;

    return streamClient.createReadStream(finalRemotePath, options);
}

async function getUrl(file_id, userId) {
    const client = getClient();
    
    // Determine the absolute remote path
    const remotePath = file_id.replace(/\\/g, '/');
    let finalRemotePath;

    // 修正: 检查 file_id 是否包含用户前缀。如果不包含，则假设它是旧格式，手动添加前缀。
    if (remotePath.includes(`/user_${userId}/`)) {
        finalRemotePath = remotePath;
    } else {
        // 假设它是旧格式，例如 `/共享/文件.txt`。
        const relativePathWithoutLeadingSlash = remotePath.replace(/^\//, '');
        finalRemotePath = path.posix.join('/', `user_${userId}`, relativePathWithoutLeadingSlash);
    }
    // 确保 finalRemotePath 仍然以 / 开头
    if (!finalRemotePath.startsWith('/')) finalRemotePath = '/' + finalRemotePath;
    
    return client.getFileDownloadLink(finalRemotePath);
}

async function createDirectory(fullPath) {
    const client = getClient();
    try {
        // 修正: 确保路径是 POSIX 风格，并保留前导斜杠，如果缺少则添加。
        const remotePath = fullPath.replace(/\\/g, '/');
        const finalRemotePath = remotePath.startsWith('/') ? remotePath : '/' + remotePath;
        
        if (await client.exists(finalRemotePath)) return true;
        await client.createDirectory(finalRemotePath, { recursive: true });
        return true;
    } catch (e) {
        if (e.response && (e.response.status === 405 || e.response.status === 501)) return true;
        throw new Error(`建立目录失败: ${e.message}`);
    }
}

module.exports = { upload, remove, getUrl, stream, resetClient, getClient, createDirectory, type: 'webdav' };
