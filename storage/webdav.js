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

// *** BUG修复 新增函数 ***
// 递归删除空目录的辅助函数
async function removeEmptyDirs(directoryPath) {
    const client = getClient();
    try {
        // 保护措施：确保不会删除根目录或根目录之外的路径
        if (!directoryPath || directoryPath === "/" || directoryPath === "") return;

        let currentPath = directoryPath;
        while (currentPath && currentPath !== "/") {
            const contents = await client.getDirectoryContents(currentPath);
            if (contents.length === 0) {
                await client.deleteFile(currentPath);
                // 移动到上一层目录继续检查
                currentPath = path.posix.dirname(currentPath);
            } else {
                // 如果目录不为空，则停止循环
                break;
            }
        }
    } catch (error) {
        // 忽略 "Not Found" 错误，因为上层目录可能在之前的迭代中已被删除
        if (error.response && error.response.status === 404) {
            // 继续尝试清理上一层
            await removeEmptyDirs(path.posix.dirname(directoryPath));
        } else {
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
    // 修正：确保路径总是以 / 开头
    return '/' + pathParts.slice(1).map(p => p.name).join('/');
}

async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    const client = getClient();
    const folderPath = await getFolderPath(folderId, userId);
    const remotePath = path.posix.join(folderPath, fileName);
    
    // 确保远端父目录存在
    if (folderPath && folderPath !== "/") {
        try {
            await client.createDirectory(folderPath, { recursive: true });
        } catch (e) {
            // 忽略“Method Not Allowed”或“Not Implemented”错误，因为有些伺服器不支持递归创建
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
        file_id: remotePath, // file_id 储存的是远端相对路径
        date: new Date(stat.lastmod).getTime(),
    }, folderId, userId, 'webdav');
    
    return { success: true, message: '档案已上传至 WebDAV。', fileId: dbResult.fileId };
}


// --- 重构并强化的 remove 函数 ---
async function remove(files, folders, userId) {
    const client = getClient();
    const results = { success: true, errors: [] };
    const parentDirs = new Set(); // 用于后续清理空目录

    // 1. 删除所有明确指定的档案
    for (const file of files) {
        try {
            const filePath = path.posix.join('/', file.file_id);
            // *** BUG修复 新增 ***
            parentDirs.add(path.posix.dirname(filePath));
            await client.deleteFile(filePath);
        } catch (error) {
            // 忽略 "Not Found" 错误，因为档案可能已被删除
            if (!(error.response && error.response.status === 404)) {
                const errorMessage = `删除 WebDAV 文件 [${file.file_id}] 失败: ${error.message}`;
                console.error(errorMessage);
                results.errors.push(errorMessage);
                results.success = false;
            }
        }
    }

    // 2. 递归删除所有指定的资料夹
    const sortedFolders = folders
        .map(f => ({ ...f, path: path.posix.join('/', f.path) }))
        .sort((a, b) => b.path.length - a.path.length);

    for (const folder of sortedFolders) {
        if (folder.path === '/') continue;
        try {
            // *** BUG修复 新增 ***
            parentDirs.add(path.posix.dirname(folder.path));
            await client.deleteFile(folder.path);
        } catch (error) {
            if (error.response && (error.response.status === 409 || error.response.status === 403)) {
                try {
                    console.warn(`文件夹 ${folder.path} 不为空或权限问题，尝试强制清空内容...`);
                    const contents = await client.getDirectoryContents(folder.path, { deep: true });
                    const sortedContents = contents.sort((a, b) => b.filename.length - a.filename.length);
                    
                    for (const item of sortedContents) {
                        if (item.filename === folder.path || item.filename === folder.path + '/') continue;
                        await client.deleteFile(item.filename);
                    }
                    await client.deleteFile(folder.path);
                } catch (deepError) {
                    const errorMessage = `清空并删除 WebDAV 资料夹 [${folder.path}] 失败: ${deepError.message}`;
                    console.error(errorMessage);
                    results.errors.push(errorMessage);
                    results.success = false;
                }
            } else if (!(error.response && error.response.status === 404)) {
                const errorMessage = `删除 WebDAV 资料夹 [${folder.path}] 失败: ${error.message}`;
                console.error(errorMessage);
                results.errors.push(errorMessage);
                results.success = false;
            }
        }
    }
    
    // *** BUG修复 新增 ***
    // 3. 清理所有可能变为空的父目录
    for (const dir of parentDirs) {
        await removeEmptyDirs(dir);
    }

    return results;
}


// 为每个流操作创建一个完全独立的客户端实例，以解决文件锁问题
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

// *** 核心修正 ***
async function move(oldPath, newPath, options = {}) {
    const client = getClient();
    try {
        const newParentDir = path.posix.dirname(newPath);
        if (newParentDir && newParentDir !== '/') {
            try {
                 await client.createDirectory(newParentDir, { recursive: true });
            } catch(e) {
                 if (e.response && (e.response.status !== 405 && e.response.status !== 501)) {
                    throw e;
                }
            }
        }
        await client.moveFile(oldPath, newPath, { overwrite: !!options.overwrite });
        
        // *** BUG修复：移动后清理源目录 ***
        await removeEmptyDirs(path.posix.dirname(oldPath));
        
        return { success: true };
    } catch (error) {
        console.error(`WebDAV 移动失败 从 ${oldPath} 到 ${newPath}:`, error);
        return { success: false, error };
    }
}

// --- 新增的 exists 函数 ---
async function exists(filePath) {
    const client = getClient();
    try {
        return await client.exists(filePath);
    } catch (error) {
        console.warn(`WebDAV exists check failed for ${filePath}:`, error.message);
        return false;
    }
}


module.exports = { upload, remove, getUrl, stream, move, resetClient, exists, type: 'webdav' };
