const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fsp = require('fs').promises;
const path = require('path');

// 这个 client 将只用于写入和删除等非流式操作
let client = null;

// 封装一个获取配置的函数，避免重复代码
function getWebdavConfig() {
    console.log('[DEBUG] Reading WebDAV configuration...');
    const storageManager = require('./index'); 
    const config = storageManager.readConfig();
    const webdavConfig = config.webdav && Array.isArray(config.webdav) ? config.webdav[0] : config.webdav;
    if (!webdavConfig || !webdavConfig.url) {
        console.error('[DEBUG] WebDAV configuration is incomplete or missing.');
        throw new Error('WebDAV 设定不完整或未设定');
    }
    console.log(`[DEBUG] WebDAV URL found: ${webdavConfig.url}`);
    return webdavConfig;
}


function getClient() {
    if (!client) {
        console.log('[DEBUG] WebDAV client does not exist, creating a new one.');
        const webdavConfig = getWebdavConfig();
        client = createClient(webdavConfig.url, {
            username: webdavConfig.username,
            password: webdavConfig.password
        });
        console.log('[DEBUG] New WebDAV client created.');
    } else {
        console.log('[DEBUG] Using existing WebDAV client.');
    }
    return client;
}

function resetClient() {
    console.log('[DEBUG] Resetting WebDAV client.');
    client = null;
}

async function getFolderPath(folderId, userId) {
    console.log(`[DEBUG] Getting folder path for folderId: ${folderId}, userId: ${userId}`);
    const userRoot = await new Promise((resolve, reject) => {
        db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [userId], (err, row) => {
            if (err) return reject(err);
            if (!row) return reject(new Error('找不到使用者根目录'));
            resolve(row);
        });
    });

    if (folderId === userRoot.id) {
        console.log('[DEBUG] Folder is root, path is "/".');
        return '/';
    }
    
    const pathParts = await data.getFolderPath(folderId, userId);
    const resultPath = '/' + pathParts.slice(1).map(p => p.name).join('/');
    console.log(`[DEBUG] Resolved folder path: ${resultPath}`);
    return resultPath;
}

// 将 tempFilePath 改为 fileStream
async function upload(fileStream, fileName, mimetype, userId, folderId) {
    console.log(`[DEBUG] Starting WebDAV upload for file: "${fileName}" to folderId: ${folderId}`);
    const client = getClient();
    const folderPath = await getFolderPath(folderId, userId);
    const remotePath = (folderPath === '/' ? '' : folderPath) + '/' + fileName;
    console.log(`[DEBUG] Remote path for upload: ${remotePath}`);
    
    if (folderPath && folderPath !== "/") {
        try {
            console.log(`[DEBUG] Attempting to create WebDAV directory: ${folderPath}`);
            await client.createDirectory(folderPath, { recursive: true });
            console.log(`[DEBUG] Directory ${folderPath} ensured.`);
        } catch (e) {
            if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                 console.error(`[DEBUG] Failed to create WebDAV directory: ${e.message}`);
                 throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
            }
             console.log(`[DEBUG] Directory ${folderPath} likely already exists (status ${e.response?.status}). Continuing.`);
        }
    }

    console.log(`[DEBUG] Putting file contents to ${remotePath} via stream.`);
    // 直接将流传递给 putFileContents
    const success = await client.putFileContents(remotePath, fileStream, { overwrite: true });

    if (!success) {
        console.error('[DEBUG] WebDAV putFileContents returned false.');
        throw new Error('WebDAV putFileContents 操作失败');
    }
    console.log(`[DEBUG] Successfully put file contents to ${remotePath}.`);

    const stat = await client.stat(remotePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    console.log(`[DEBUG] Adding file to database. message_id: ${messageId}, fileName: ${fileName}`);
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stat.size,
        file_id: remotePath,
        date: new Date(stat.lastmod).getTime(),
    }, folderId, userId, 'webdav');
    
    console.log(`[DEBUG] WebDAV upload for "${fileName}" completed successfully.`);
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}


async function remove(files, folders, userId) {
    console.log(`[DEBUG] Starting WebDAV remove operation. Files: ${files.length}, Folders: ${folders.length}`);
    const client = getClient();
    const results = { success: true, errors: [] };

    // 1. 创建统一的待删除项目列表
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

    // 2. 按路径深度降序排序，确保先删除子项
    allItemsToDelete.sort((a, b) => b.path.length - a.path.length);
    console.log('[DEBUG] Items to delete (sorted):', allItemsToDelete.map(i => i.path));

    // 3. 依次执行删除
    for (const item of allItemsToDelete) {
        try {
            console.log(`[DEBUG] Deleting ${item.type} at path: ${item.path}`);
            // **最终勘误**：无论是档案还是资料夹，都统一使用 `deleteFile` 函数。
            // WebDAV 服务器会根据路径是否以 '/' 结尾来区分档案和资料夹。
            await client.deleteFile(item.path);
            console.log(`[DEBUG] Successfully deleted ${item.path}`);
        } catch (error) {
            if (!(error.response && error.response.status === 404)) {
                const errorMessage = `删除 WebDAV ${item.type} [${item.path}] 失败: ${error.message}`;
                console.error(`[DEBUG] ${errorMessage}`);
                results.errors.push(errorMessage);
                results.success = false;
            } else {
                 console.log(`[DEBUG] Item not found on server (404), skipping: ${item.path}`);
            }
        }
    }
    console.log('[DEBUG] WebDAV remove operation finished.');
    return results;
}

// 为每个流操作创建一个完全独立的客户端实例，以解决文件锁问题
async function stream(file_id, userId) {
    console.log(`[DEBUG] Creating a new WebDAV client for streaming file: ${file_id}`);
    const webdavConfig = getWebdavConfig();
    const streamClient = createClient(webdavConfig.url, {
        username: webdavConfig.username,
        password: webdavConfig.password
    });
    console.log(`[DEBUG] Returning read stream for: ${path.posix.join('/', file_id)}`);
    return streamClient.createReadStream(path.posix.join('/', file_id));
}

async function getUrl(file_id, userId) {
    console.log(`[DEBUG] Getting download link for file: ${file_id}`);
    const client = getClient();
    const link = client.getFileDownloadLink(path.posix.join('/', file_id));
    console.log(`[DEBUG] Generated download link: ${link}`);
    return link;
}

// --- *** 新增函数 *** ---
async function createDirectory(fullPath) {
    console.log(`[DEBUG] Ensuring WebDAV directory exists at: ${fullPath}`);
    const client = getClient();
    try {
        // 确保路径以斜线开头且规范化
        const remotePath = path.posix.join('/', fullPath);
        if (await client.exists(remotePath)) {
            console.log(`[DEBUG] Directory ${remotePath} already exists.`);
            return true;
        }
        await client.createDirectory(remotePath, { recursive: true });
        console.log(`[DEBUG] Directory ${remotePath} created.`);
        return true;
    } catch (e) {
        // 忽略目录已存在的错误 (405 Method Not Allowed 是一个常见响应)
        if (e.response && (e.response.status === 405 || e.response.status === 501)) {
            console.log(`[DEBUG] Directory ${fullPath} likely already exists (status ${e.response.status}). Continuing.`);
            return true;
        }
        console.error(`[DEBUG] Failed to create WebDAV directory ${fullPath}: ${e.message}`);
        throw new Error(`建立 WebDAV 目录失败: ${e.message}`);
    }
}
// --- *** 新增函数结束 *** ---

module.exports = { upload, remove, getUrl, stream, resetClient, getClient, createDirectory, type: 'webdav' };
