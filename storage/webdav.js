// storage/webdav.js

const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

let client = null;

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

// *** 关键修正: 将 upload 函数的第一个参数从 tempFilePath 改为 fileBuffer ***
async function upload(fileBuffer, fileName, mimetype, userId, folderId) {
    console.log(`[WebDAV Storage] 开始处理上传: ${fileName} (来自记忆体 Buffer)`);
    const client = getClient();
    const folderPath = await getFolderPath(folderId, userId);
    const remotePath = (folderPath === '/' ? '' : folderPath) + '/' + fileName;
    console.log(`[WebDAV Storage] 目标 WebDAV 路径: ${remotePath}`);

    if (folderPath && folderPath !== "/") {
        try {
            console.log(`[WebDAV Storage] 确保远端目录存在: ${folderPath}`);
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
        }
    }
    
    const size = fileBuffer.length;

    console.log(`[WebDAV Storage] 开始将档案 Buffer 上传至 ${remotePath}`);
    // *** 核心修改：直接传递 Buffer ***
    const success = await client.putFileContents(remotePath, fileBuffer, { 
      overwrite: true,
      contentLength: size // 提供档案大小
    });

    if (!success) {
        console.error(`[WebDAV Storage] putFileContents 操作返回 false`);
        throw new Error('WebDAV putFileContents 操作失败');
    }
    console.log(`[WebDAV Storage] 档案 Buffer 上传成功`);

    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    console.log(`[WebDAV Storage] 正在将档案资讯写入资料库: ${fileName}`);
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: size,
        file_id: remotePath,
        date: Date.now(),
    }, folderId, userId, 'webdav');
    
    console.log(`[WebDAV Storage] 档案 ${fileName} 成功储存至 WebDAV 并记录到资料库。`);
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}
