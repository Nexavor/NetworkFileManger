const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

let client = null;

function getClient() {
    if (!client) {
        const storageManager = require('./index'); 
        const config = storageManager.readConfig();
        const webdavConfig = config.webdav && Array.isArray(config.webdav) ? config.webdav[0] : config.webdav;

        if (!webdavConfig || !webdavConfig.url) {
            throw new Error('WebDAV 设定不完整或未设定');
        }
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

async function remove(files, userId) {
    const client = getClient();
    const parentDirs = new Set();
    
    for (const file of files) {
        try {
            // Bug 2 修复：确保路径格式统一，避免因路径不一致（例如，有无前导 './'）导致删除失败
            const remotePath = path.posix.normalize('/' + file.file_id.replace(/^\.?\//, ''));
            await client.deleteFile(remotePath);
            parentDirs.add(path.dirname(remotePath).replace(/\\/g, '/'));
        } catch (error) {
            if (error.response) {
                // 404 错误是可接受的，意味着文件可能已被手动删除
                if (error.response.status !== 404) {
                     console.error(`删除 WebDAV 档案 [${file.file_id}] 失败，状态码: ${error.response.status}`, error.message);
                }
            } else {
                console.error(`删除 WebDAV 档案 [${file.file_id}] 时发生非 HTTP 错误`, error.message);
            }
        }
    }
    await data.deleteFilesByIds(files.map(f => f.message_id), userId);

    // Bug 1 修复：对目录按深度（路径长度）进行降序排序，确保总是先尝试删除子目录
    const sortedDirs = Array.from(parentDirs).sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
        await removeEmptyDirs(dir);
    }

    return { success: true };
}

async function stream(file_id, userId) {
    const client = getClient();
    return client.createReadStream(file_id);
}

async function getUrl(file_id, userId) {
    const client = getClient();
    return client.getFileDownloadLink(file_id);
}

module.exports = { upload, remove, getUrl, stream, resetClient, type: 'webdav' };
