// storage/webdav.js
const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let client = null;
const creatingDirs = new Set();

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
                try {
                    await client.createDirectory(currentPath);
                } catch (e) {
                    // Ignore errors if directory likely created concurrently or not allowed
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
    return new Promise(async (resolve, reject) => {
        let client; 
        let remotePath; 
        try {
            const webdavConfig = getWebdavConfig();
            client = createClient(webdavConfig.url, {
                username: webdavConfig.username,
                password: webdavConfig.password
            });

            const folderPath = await getFolderPath(folderId, userId);
            remotePath = (folderPath === '/' ? '' : folderPath) + '/' + fileName;
            
            if (folderPath && folderPath !== "/") {
                await ensureDirectoryExists(folderPath);
            }

            // 如果传入的是流，绑定错误处理
            if (fileStream && typeof fileStream.on === 'function') {
                fileStream.on('error', err => {
                    reject(new Error(`Stream Error: ${err.message}`));
                });
            }

            let options = { overwrite: true };
            
            // 自动检测并设置 Content-Length
            if (fileStream && fileStream.path && typeof fileStream.path === 'string') {
                try {
                    const fsStats = fs.statSync(fileStream.path);
                    options.contentLength = fsStats.size;
                } catch (e) {
                    // Ignore stat errors
                }
            }

            const success = await client.putFileContents(remotePath, fileStream, options);

            if (!success) {
                throw new Error('WebDAV putFileContents 返回 false');
            }
            
            const stats = await client.stat(remotePath);
            
            if (stats.size === 0) {
                throw new Error('上传验证失败: 远端文件大小为 0 字节');
            }

            if (existingItem) {
                await data.updateFile(existingItem.message_id, {
                    mimetype: mimetype,
                    file_id: remotePath,
                    size: stats.size,
                    date: Date.now(),
                }, userId);
                resolve({ success: true, message: '覆盖成功', fileId: existingItem.message_id });
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
            if (fileStream && typeof fileStream.resume === 'function') {
                fileStream.resume();
            }
            
            // 发生错误时，尝试清理可能存在的 0KB 残留文件
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

// --- 新增 Copy ---
async function copy(file, newRelativePath, userId) {
    const client = getClient();
    const oldPath = path.posix.join('/', file.file_id);
    const newPath = path.posix.join('/', newRelativePath);
    
    // WebDAV copyFile 接口通常需要完整的源路径和目标路径
    await client.copyFile(oldPath, newPath);
    
    return newRelativePath;
}

module.exports = { upload, remove, getUrl, stream, copy, resetClient, getClient, createDirectory, type: 'webdav' };
