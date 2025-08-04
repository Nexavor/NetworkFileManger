const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');

const TMP_DIR = path.join(__dirname, '..', 'data', 'tmp');
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

// **重构：上传逻辑改为接收流**
async function upload(fileStream, fileName, mimetype, userId, folderId) {
    console.log(`[WebDAV Storage] 开始处理流式上传: ${fileName}`);
    const client = getClient();
    
    const tempFileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${fileName}`;
    const tempFilePath = path.join(TMP_DIR, tempFileName);

    try {
        await new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(tempFilePath);
            fileStream.pipe(writeStream);
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
            fileStream.on('error', reject);
        });
        const stats = await fsp.stat(tempFilePath);
        console.log(`[WebDAV Storage] 档案已暂存至: ${tempFilePath}, 大小: ${stats.size}`);

        const folderPath = await getFolderPath(folderId, userId);
        const remotePath = (folderPath === '/' ? '' : folderPath) + '/' + fileName;
        console.log(`[WebDAV Storage] 目标 WebDAV 路径: ${remotePath}`);

        if (folderPath && folderPath !== "/") {
            try {
                await client.createDirectory(folderPath, { recursive: true });
            } catch (e) {
                if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                     throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
                }
            }
        }
        
        const readStream = fs.createReadStream(tempFilePath);
        const success = await client.putFileContents(remotePath, readStream, { 
          overwrite: true,
          contentLength: stats.size
        });

        if (!success) {
            throw new Error('WebDAV putFileContents 操作失败');
        }
        console.log(`[WebDAV Storage] 档案流式上传成功`);

        const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

        const dbResult = await data.addFile({
            message_id: messageId,
            fileName,
            mimetype,
            size: stats.size,
            file_id: remotePath,
            date: Date.now(),
        }, folderId, userId, 'webdav');
        
        return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
    } finally {
        if (fs.existsSync(tempFilePath)) {
            await fsp.unlink(tempFilePath).catch(err => console.warn(`[WebDAV Storage] 删除暂存文件失败: ${tempFilePath}`, err.message));
        }
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
