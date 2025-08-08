const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'storage/webdav.js';
let client = null;

// --- 日志辅助函数 ---
const log = (level, func, message, ...args) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] [${FILE_NAME}:${func}] - ${message}`, ...args);
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

async function upload(fileStream, fileName, mimetype, userId, folderId) {
    const FUNC_NAME = 'upload';
    log('INFO', FUNC_NAME, `开始上传文件: "${fileName}" 到 WebDAV...`);
    
    return new Promise(async (resolve, reject) => {
        try {
            const client = getClient();
            const folderPath = await getFolderPath(folderId, userId);
            const remotePath = (folderPath === '/' ? '' : folderPath) + '/' + fileName;

            if (folderPath && folderPath !== "/") {
                log('DEBUG', FUNC_NAME, `正在建立 WebDAV 远端目录: "${folderPath}"`);
                try {
                    await client.createDirectory(folderPath, { recursive: true });
                } catch (e) {
                    if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                        throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
                    }
                }
            }

            // 关键：监听输入流的错误
            fileStream.on('error', err => {
                log('ERROR', FUNC_NAME, `输入文件流 (fileStream) 发生错误 for "${fileName}":`, err);
                reject(new Error(`输入文件流中断: ${err.message}`));
            });

            log('DEBUG', FUNC_NAME, `正在调用 putFileContents 上传到: "${remotePath}"`);
            const success = await client.putFileContents(remotePath, fileStream, { overwrite: true });

            if (!success) {
                return reject(new Error('WebDAV putFileContents 操作失败'));
            }
            log('INFO', FUNC_NAME, `文件成功上传到 WebDAV: "${fileName}"`);

            const stats = await client.stat(remotePath);
            log('DEBUG', FUNC_NAME, `获取 WebDAV 文件状态成功，大小: ${stats.size}`);
            const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

            const dbResult = await data.addFile({
                message_id: messageId,
                fileName,
                mimetype,
                size: stats.size,
                file_id: remotePath,
                date: Date.now(),
            }, folderId, userId, 'webdav');
            
            log('INFO', FUNC_NAME, `文件 "${fileName}" 已成功存入资料库。`);
            resolve({ success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId });

        } catch (error) {
            log('ERROR', FUNC_NAME, `上传到 WebDAV 失败 for "${fileName}":`, error);
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
