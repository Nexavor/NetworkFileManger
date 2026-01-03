// storage/webdav.js
const { createClient } = require('webdav');
const data = require('../data.js');
const db = require('../database.js');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// --- 新增：引入 http/https 模块以控制连接代理 ---
const http = require('http');
const https = require('https');

const FILE_NAME = 'storage/webdav.js';
let client = null;
const creatingDirs = new Map(); 

// --- 日志辅助函数 ---
const log = (level, func, message, ...args) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [WEBDAV:${level}] [${func}] - ${message}`, ...args);
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

// --- 路径规范化 ---
function normalizePath(p) {
    if (!p) return '/';
    let normalized = p.replace(/\\/g, '/');
    normalized = path.posix.normalize(normalized);
    if (!normalized.startsWith('/')) {
        normalized = '/' + normalized;
    }
    if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
}

async function ensureDirectoryExists(fullPath) {
    const FUNC_NAME = 'ensureDirectoryExists';
    const remotePath = normalizePath(fullPath);
    
    if (remotePath === "/") return;
    
    if (creatingDirs.has(remotePath)) {
        return creatingDirs.get(remotePath);
    }

    const creationPromise = (async () => {
        try {
            const client = getClient();
            const parts = remotePath.split('/').filter(p => p);
            let current = '';

            for (const part of parts) {
                current += '/' + part;
                const exists = await client.exists(current);
                if (!exists) {
                    log('INFO', FUNC_NAME, `创建目录: "${current}"`);
                    try {
                        await client.createDirectory(current);
                    } catch (e) {
                        if (e.response && e.response.status !== 405) {
                            log('WARN', FUNC_NAME, `创建目录可能有误 (可能是并发导致已存在): ${e.message}`);
                        }
                    }
                }
            }
        } finally {
            creatingDirs.delete(remotePath);
        }
    })();

    creatingDirs.set(remotePath, creationPromise);
    return creationPromise;
}

async function getFolderPath(folderId, userId) {
    const pathParts = await data.getFolderPath(folderId, userId);
    const fullPath = path.posix.join('/', ...pathParts.slice(1).map(p => p.name));
    return normalizePath(fullPath);
}

async function upload(fileStreamOrBuffer, fileName, mimetype, userId, folderId, caption = '', existingItem = null) {
    const FUNC_NAME = 'upload';
    
    return new Promise(async (resolve, reject) => {
        let remotePath = ''; 
        try {
            const client = getClient();
            const folderPath = await getFolderPath(folderId, userId);
            
            await ensureDirectoryExists(folderPath);

            remotePath = normalizePath(path.posix.join(folderPath, fileName));
            
            let options = { overwrite: true };
            if (fileStreamOrBuffer && fileStreamOrBuffer.path) {
                try {
                    const stats = fs.statSync(fileStreamOrBuffer.path);
                    options.contentLength = stats.size;
                } catch (e) { }
            }

            log('DEBUG', FUNC_NAME, `PUT: ${remotePath}`);
            
            let retries = 1;
            while (retries >= 0) {
                try {
                    const result = await client.putFileContents(remotePath, fileStreamOrBuffer, options);
                    if (result === false) throw new Error('WebDAV putFileContents returned false');
                    break; 
                } catch (err) {
                    if (retries > 0) {
                        log('WARN', FUNC_NAME, `上传失败，正在重试 (${retries}次剩余): ${err.message}`);
                        await new Promise(r => setTimeout(r, 1000));
                        retries--;
                        if (typeof fileStreamOrBuffer.pipe === 'function') {
                             throw err; 
                        }
                    } else {
                        throw err;
                    }
                }
            }
            
            const stats = await client.stat(remotePath);
            if (stats.size === 0 && options.contentLength > 0) {
                 throw new Error('上传验证失败: 远端文件为 0 字节');
            }

            if (existingItem) {
                await data.updateFile(existingItem.id, {
                    mimetype: mimetype,
                    file_id: remotePath,
                    size: stats.size,
                    date: Date.now(),
                }, userId);
                resolve({ success: true, message: '覆盖成功', fileId: existingItem.id });
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
            log('ERROR', FUNC_NAME, `失败: ${error.message}`);
            reject(error);
        }
    });
}

async function remove(files, folders, userId) {
    const client = getClient();
    const results = { success: true, errors: [] };
    const allItemsToDelete = [];
    
    files.forEach(file => {
        const p = normalizePath(file.file_id);
        if (p !== '/' && p !== '') { 
            allItemsToDelete.push({ path: p, type: 'file' });
        }
    });
    folders.forEach(folder => {
        let p = normalizePath(folder.path);
        if (p === '/' || p === '') {
            log('WARN', 'remove', '尝试删除根目录被阻止');
            return;
        }
        if (!p.endsWith('/')) { p += '/'; }
        allItemsToDelete.push({ path: p, type: 'folder' });
    });
    
    allItemsToDelete.sort((a, b) => b.path.length - a.path.length);
    for (const item of allItemsToDelete) {
        try {
            log('INFO', 'remove', `删除: ${item.path}`);
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

// --- 核心修复：流式传输逻辑 ---
async function stream(file_id, userId, options = {}) {
    const remotePath = normalizePath(file_id);
    log('INFO', 'stream', `请求流: ${remotePath} (Options: ${JSON.stringify(options)})`);
    
    try {
        const webdavConfig = getWebdavConfig();
        
        // --- 关键修改：禁用 Keep-Alive ---
        // 许多 WebDAV 服务端（如 Alist/Nextcloud）在处理并发或连续流请求时，
        // 如果连接被复用往往会卡死。这里强制每个流使用独立的短连接。
        const agentOptions = { keepAlive: false };
        const httpAgent = new http.Agent(agentOptions);
        const httpsAgent = new https.Agent(agentOptions);

        const streamClient = createClient(webdavConfig.url, {
            username: webdavConfig.username,
            password: webdavConfig.password,
            httpAgent: httpAgent,
            httpsAgent: httpsAgent
        });

        const remoteStream = streamClient.createReadStream(remotePath, options);
        
        let hasStarted = false;
        remoteStream.on('data', () => {
            if (!hasStarted) {
                log('DEBUG', 'stream', `流数据传输开始: ${remotePath}`);
                hasStarted = true;
            }
        });
        remoteStream.on('end', () => log('INFO', 'stream', `流传输结束: ${remotePath}`));
        remoteStream.on('error', (err) => log('ERROR', 'stream', `流发生错误: ${remotePath} - ${err.message}`));
        
        return remoteStream;
    } catch (error) {
        log('ERROR', 'stream', `创建流失败: ${error.message}`);
        throw error;
    }
}

async function getUrl(file_id, userId) {
    const client = getClient();
    const remotePath = normalizePath(file_id);
    return client.getFileDownloadLink(remotePath);
}

async function createDirectory(fullPath) {
    const client = getClient();
    const remotePath = normalizePath(fullPath);
    try {
        if (await client.exists(remotePath)) return true;
        await client.createDirectory(remotePath, { recursive: true });
        return true;
    } catch (e) {
        if (e.response && (e.response.status === 405 || e.response.status === 501)) return true;
        throw new Error(`建立目录失败: ${e.message}`);
    }
}

module.exports = { upload, remove, getUrl, stream, resetClient, getClient, createDirectory, type: 'webdav' };
