const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const data = require('../data.js');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

// 初始化，确保上传目录存在
async function setup() {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
    } catch (e) {
        console.error("无法建立上传目录:", e);
    }
}
setup();

// 辅助函数：递归删除空目录
async function removeEmptyDirs(directoryPath) {
    try {
        if (!directoryPath.startsWith(UPLOAD_DIR) || directoryPath === UPLOAD_DIR) return;

        let currentPath = directoryPath;
        while (currentPath !== UPLOAD_DIR && currentPath !== path.dirname(UPLOAD_DIR)) {
            const files = await fs.readdir(currentPath);
            if (files.length === 0) {
                await fs.rmdir(currentPath);
                currentPath = path.dirname(currentPath);
            } else {
                break;
            }
        }
    } catch (error) {
        console.warn(`清理空目录失败: ${directoryPath}`, error.message);
    }
}


// --- 核心修复：重构 upload 函数以匹配目录结构 ---
async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = folderPathParts.slice(1).map(p => p.name).join(path.sep);

    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFolderPath = path.join(userDir, relativeFolderPath);
    
    await fs.mkdir(finalFolderPath, { recursive: true });
    const finalFilePath = path.join(finalFolderPath, fileName);

    await fs.rename(tempFilePath, finalFilePath);
    
    const stats = await fs.stat(finalFilePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    const fileIdForDb = path.relative(userDir, finalFilePath).replace(/\\/g, '/');

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stats.size,
        file_id: fileIdForDb,
        thumb_file_id: null,
        date: Date.now(),
    }, folderId, userId, 'local');

    return { success: true, message: '文件已储存至本地。', fileId: dbResult.fileId };
}

// --- 强化后的 remove 函数 ---
async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const parentDirs = new Set();
    const userUploadDir = path.join(UPLOAD_DIR, String(userId));

    for (const file of files) {
        try {
            const fullFilePath = path.join(userUploadDir, file.file_id);
            if (fsSync.existsSync(fullFilePath)) {
                parentDirs.add(path.dirname(fullFilePath));
                await fs.unlink(fullFilePath);
            }
        } catch (e) {
            const errorMessage = `删除本地文件失败: ${file.file_id}, ${e.message}`;
            console.warn(errorMessage);
            results.errors.push(errorMessage);
            results.success = false;
        }
    }
    
    const folderPaths = folders
        .map(f => path.join(userUploadDir, f.path.replace(/\//g, path.sep)))
        .sort((a, b) => b.length - a.length);

    for (const folderPath of folderPaths) {
        try {
            if (fsSync.existsSync(folderPath)) {
                parentDirs.add(path.dirname(folderPath));
                await fs.rm(folderPath, { recursive: true, force: true });
            }
        } catch (e) {
            const errorMessage = `删除本地资料夹失败: ${folderPath}, ${e.message}`;
            console.warn(errorMessage);
            results.errors.push(errorMessage);
            results.success = false;
        }
    }

    for (const dir of parentDirs) {
        await removeEmptyDirs(dir);
    }

    return results;
}

async function getUrl(file_id, userId) {
    const userUploadDir = path.join(UPLOAD_DIR, String(userId));
    const fullPath = path.join(userUploadDir, file_id);
    // 这是一个简化的逻辑，实际上下载应该通过/download/proxy/:message_id进行
    // 因为直接暴露文件系统路径不安全。此函数主要用于缩图等内部用途。
    return `/local-files-relative/${userId}/${file_id}`;
}


// --- 核心修复：重构 move 函数 ---
async function move(oldRelativePath, newRelativePath, options = {}, userId) {
    const userUploadDir = path.join(UPLOAD_DIR, String(userId));
    const oldPath = path.join(userUploadDir, oldRelativePath);
    const newPath = path.join(userUploadDir, newRelativePath);

    try {
        if (!fsSync.existsSync(oldPath)) {
            throw new Error(`来源路径不存在: ${oldPath}`);
        }
        
        const newParentDir = path.dirname(newPath);
        await fs.mkdir(newParentDir, { recursive: true });

        if (options.overwrite && fsSync.existsSync(newPath)) {
            await fs.rm(newPath, { recursive: true, force: true });
        }
        
        await fs.rename(oldPath, newPath);
        
        await removeEmptyDirs(path.dirname(oldPath));
        return { success: true };
    } catch (error) {
        console.error(`本地移动失败 从 ${oldPath} 到 ${newPath}:`, error);
        return { success: false, error };
    }
}


async function exists(filePath, userId) {
    const userUploadDir = path.join(UPLOAD_DIR, String(userId));
    return fsSync.existsSync(path.join(userUploadDir, filePath));
}

module.exports = { upload, remove, getUrl, move, exists, type: 'local' };
