const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto'); // 新生

let client = null;

function getClient() {
    if (!client) {
        const storageManager = require('./index'); 
        const config = storageManager.readConfig();
        if (!config.webdav || !config.webdav.url) {
            throw new Error('WebDAV 设定不完整或未设定');
        }
        client = createClient(config.webdav.url, {
            username: config.webdav.username,
            password: config.webdav.password
        });
    }
    return client;
}

// 当 WebDAV 设定更新时，需要重置客户端
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

async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    const client = getClient();
    const fs = require('fs');
    const folderPath = await getFolderPath(folderId, userId);
    const remotePath = (folderPath === '/' ? '' : folderPath) + '/' + fileName;
    
    // 确保远端目录存在
    if (folderPath && folderPath !== "/") {
        try {
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            // 忽略目录已存在的错误 (405 Method Not Allowed, 501 Not Implemented)
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw e;
            }
        }
    }

    const readStream = fs.createReadStream(tempFilePath);
    const success = await client.putFileContents(remotePath, readStream, { overwrite: true });

    if (!success) {
        throw new Error('WebDAV putFileContents 操作失败');
    }

    const stat = await client.stat(remotePath);
    // 新生：使用更可靠的方式生成唯一的 messageId，避免冲突
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
    for (const file of files) {
        try {
            await client.deleteFile(file.file_id);
        } catch (error) {
            // 如果档案在远端不存在 (404)，也视为成功删除
            if (error.response && error.response.status !== 404) {
                 console.warn(`删除 WebDAV 档案失败: ${file.file_id}`, error.message);
            }
        }
    }
    await data.deleteFilesByIds(files.map(f => f.message_id), userId);
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
