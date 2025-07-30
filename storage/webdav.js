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

async function remove(files, folders, userId) {
    const client = getClient();
    const parentDirs = new Set();
    const results = { success: true, errors: [] };

    // 1. 删除所有文件
    for (const file of files) {
        try {
            // Bug 2 修复：确保路径格式统一且以斜杠开头
            const remotePath = path.posix.join('/', file.file_id);
            await client.deleteFile(remotePath);
            parentDirs.add(path.dirname(remotePath).replace(/\\/g, '/'));
        } catch (error) {
            if (error.response && error.response.status !== 404) {
                 const errorMessage = `删除 WebDAV 档案 [${file.file_id}] 失败: ${error.message}`;
                 console.warn(errorMessage);
                 results.errors.push(errorMessage);
                 results.success = false;
            }
        }
    }

    // 2. 删除所有文件夹 (如果提供了文件夹列表)
    if (folders && folders.length > 0) {
        // Bug 1 修复：对目录按深度（路径长度）进行降序排序，确保总是先删除子目录
        const sortedFolders = folders.sort((a, b) => b.path.length - a.path.length);
        for (const folder of sortedFolders) {
            try {
                if (folder.path === '/') continue; // 不删除根目录
                const remotePath = path.posix.join('/', folder.path);
                await client.deleteDirectory(remotePath);
                parentDirs.add(path.dirname(remotePath).replace(/\\/g, '/'));
            } catch (error) {
                if (error.response && error.response.status !== 404) {
                     const errorMessage = `删除 WebDAV 目录 [${folder.path}] 失败: ${error.message}`;
                     console.warn(errorMessage);
                     results.errors.push(errorMessage);
                     results.success = false;
                }
            }
        }
    }

    // 3. 清理可能产生的空父目录
    const sortedParentDirs = Array.from(parentDirs).sort((a, b) => b.length - a.length);
    for (const dir of sortedParentDirs) {
        await removeEmptyDirs(dir);
    }

    return results;
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
