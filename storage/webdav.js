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
        console.log('[WebDAV Storage] WebDAV client 未初始化，正在建立新的 client...');
        const webdavConfig = getWebdavConfig();
        client = createClient(webdavConfig.url, {
            username: webdavConfig.username,
            password: webdavConfig.password
        });
        console.log(`[WebDAV Storage] 新的 WebDAV client 已建立，URL: ${webdavConfig.url}, Username: ${webdavConfig.username}`);
    }
    return client;
}

function resetClient() {
    console.log('[WebDAV Storage] 正在重设 WebDAV client...');
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

// *** 核心修改：upload 函数现在直接接收档案流 (fileStream) 和一个获取大小的函式 (getFileSize) ***
async function upload(fileStream, fileName, mimetype, getFileSize, userId, folderId) {
    console.log(`[WebDAV Storage] 开始处理流式上传: ${fileName}`);
    const client = getClient();
    const folderPath = await getFolderPath(folderId, userId);
    const remotePath = (folderPath === '/' ? '' : folderPath) + '/' + fileName;
    console.log(`[WebDAV Storage] 目标 WebDAV 路径: ${remotePath}`);

    try {
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
        
        console.log(`[WebDAV Storage] 开始将档案流上传至 ${remotePath}`);
        // **直接将档案流传递给 putFileContents**
        const success = await client.putFileContents(remotePath, fileStream, { 
          overwrite: true,
          // content-length 是可选的，但如果能提供，对某些伺服器有好处
          // 由于流是即时的，我们现在不能预先知道大小，所以不设定
        });

        if (!success) {
            throw new Error('WebDAV putFileContents 操作返回 false，上传失败');
        }
        console.log(`[WebDAV Storage] 档案流式上传成功`);

        // **档案大小只有在流传输结束后才能确定**
        const finalSize = getFileSize();
        console.log(`[WebDAV Storage] 档案流传输完成，最终大小: ${finalSize} bytes`);

        const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

        console.log(`[WebDAV Storage] 正在将档案资讯写入资料库: ${fileName}`);
        const dbResult = await data.addFile({
            message_id: messageId,
            fileName,
            mimetype,
            size: finalSize,
            file_id: remotePath,
            date: Date.now(),
        }, folderId, userId, 'webdav');
        
        console.log(`[WebDAV Storage] 档案 ${fileName} 成功储存至 WebDAV 并记录到资料库。`);
        return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
    } catch (error) {
        if (error.response && error.response.status === 401) {
            console.error(`[WebDAV Storage] 上传失败: 401 未授权。请检查管理后台的 WebDAV 使用者名称和密码。`);
            resetClient(); 
            throw new Error('WebDAV 认证失败 (401 Unauthorized)。请检查您在管理后台设定的使用者名称和密码是否正确，然后重试操作。');
        }
        console.error(`[WebDAV Storage] 上传过程中发生严重错误:`, error);
        if (!fileStream.destroyed) {
            fileStream.destroy();
        }
        throw error; 
    }
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
