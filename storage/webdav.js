const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILE_NAME = 'storage/webdav.js';
let client = null;
// --- *** 关键修正 开始 *** ---
// 新增一个 Set 来作为锁，防止并发创建同一个目录
const creatingDirs = new Set();
// --- *** 关键修正 结束 *** ---


// --- 日志辅助函数 ---
const log = (level, func, message, ...args) => {
    // const timestamp = new Date().toISOString();
    // console.log(`[${timestamp}] [${level}] [${FILE_NAME}:${func}] - ${message}`, ...args);
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

// --- *** 关键修正 开始 *** ---
// 新增辅助函数，用于按顺序创建目录
async function ensureDirectoryExists(fullPath) {
    const FUNC_NAME = 'ensureDirectoryExists';
    if (!fullPath || fullPath === "/") return;
    
    // 如果路径已在创建中，则等待
    while (creatingDirs.has(fullPath)) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // 锁定当前路径，防止其他并发操作重复创建
    creatingDirs.add(fullPath);

    try {
        const client = getClient();
        const pathParts = fullPath.split('/').filter(p => p);
        let currentPath = '';

        for (const part of pathParts) {
            currentPath += `/${part}`;
            log('DEBUG', FUNC_NAME, `检查目录是否存在: "${currentPath}"`);
            const exists = await client.exists(currentPath);
            if (!exists) {
                log('INFO', FUNC_NAME, `目录不存在，正在创建: "${currentPath}"`);
                try {
                    await client.createDirectory(currentPath);
                } catch (e) {
                    // 忽略“方法不允许”或“已存在”的错误，因为另一个进程可能刚刚创建了它
                    if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                         throw new Error(`建立 WebDAV 目录失败 (${e.response.status}): ${e.message}`);
                    }
                }
            }
        }
    } finally {
        // 解锁
        creatingDirs.delete(fullPath);
    }
}
// --- *** 关键修正 结束 *** ---

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

// --- *** 重构 upload 函数 *** ---
async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '', existingItem = null) { // <-- 接受 caption
    const FUNC_NAME = 'upload';
    log('INFO', FUNC_NAME, `开始上传文件: "${fileName}" 到 WebDAV...`);
    
    // --- *** 关键修正：新增 AbortController *** ---
    const controller = new AbortController();
    // --- *** 修正结束 *** ---

    return new Promise(async (resolve, reject) => {
        try {
            const client = getClient();
            const folderPath = await getFolderPath(folderId, userId);
            const remotePath = (folderPath === '/' ? '' : folderPath) + '/' + fileName;
            
            if (folderPath && folderPath !== "/") {
                await ensureDirectoryExists(folderPath);
            }

            // 关键：监听输入流的错误
            fileStream.on('error', err => {
                log('ERROR', FUNC_NAME, `输入文件流 (fileStream) 发生错误 for "${fileName}":`, err);
                // --- *** 关键修正：中止 WebDAV 请求 *** ---
                controller.abort(err);
                // --- *** 修正结束 *** ---
                reject(new Error(`输入文件流中断: ${err.message}`));
            });

            log('DEBUG', FUNC_NAME, `正在调用 putFileContents 上传到: "${remotePath}"`);
            // 1. 上传文件，WebDAV 会自动覆盖
            const success = await client.putFileContents(remotePath, fileStream, { 
                overwrite: true,
                signal: controller.signal // <-- 传入 signal
            });

            if (!success) {
                return reject(new Error('WebDAV putFileContents 操作失败'));
            }
            log('INFO', FUNC_NAME, `文件成功上传到 WebDAV: "${fileName}"`);

            const stats = await client.stat(remotePath);
            log('DEBUG', FUNC_NAME, `获取 WebDAV 文件状态成功，大小: ${stats.size}`);

            // --- *** 关键修正：保留共享连结 *** ---
            if (existingItem) {
                // 这是 UPDATE 逻辑
                log('DEBUG', FUNC_NAME, `覆盖 (Update) 模式: 正在更新数据库条目 (ID: ${existingItem.id})`);
                
                // 1. 获取旧文件路径，以便稍后清理
                const oldRemotePath = existingItem.file_id;

                // 2. 更新数据库 (UPDATE)
                await data.updateFile(existingItem.id, userId, {
                    fileName: fileName, // <-- 允许档名变更
                    size: stats.size,
                    file_id: remotePath,
                    mimetype: mimetype,
                    date: Date.now(),
                });
                
                // 3. (清理) 如果档名变了，删除旧的实体档案
                if (oldRemotePath !== remotePath) {
                    log('DEBUG', FUNC_NAME, `档名已变更，正在删除旧的 WebDAV 档案: "${oldRemotePath}"`);
                    try {
                        await client.deleteFile(oldRemotePath);
                    } catch (e) {
                         log('WARN', FUNC_NAME, `删除旧档案 ${oldRemotePath} 失败: ${e.message}`);
                    }
                }
                
                log('INFO', FUNC_NAME, `文件 "${fileName}" (ID: ${existingItem.id}) 已成功更新。`);
                resolve({ success: true, fileId: existingItem.id }); // <-- 返回旧 ID
            } else {
                // 这是 INSERT 逻辑 (新上传)
                log('DEBUG', FUNC_NAME, '新上传模式: 正在新增数据库条目...');
                
                const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
                
                // 1. 新增数据库 (INSERT)
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
            }
            // --- *** 修正结束 *** ---

        } catch (error) {
            // --- *** 关键修正：捕获 AbortError *** ---
            if (error.name === 'AbortError') {
                 log('WARN', FUNC_NAME, `WebDAV 上传被中止 (可能来自 fileStream 错误): ${fileName}`);
            } else {
                log('ERROR', FUNC_NAME, `上传到 WebDAV 失败 for "${fileName}":`, error);
            }
            // --- *** 修正结束 *** ---

            if (fileStream && typeof fileStream.resume === 'function') {
                fileStream.resume();
            }
            reject(error);
        }
    });
}
// --- *** upload 函数重构结束 *** ---


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
