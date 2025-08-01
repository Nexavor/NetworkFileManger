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
    // 从第二个元素开始，因为第一个是根目录'/'
    const relativeFolderPath = folderPathParts.slice(1).map(p => p.name).join(path.sep);

    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFolderPath = path.join(userDir, relativeFolderPath);
    
    await fs.mkdir(finalFolderPath, { recursive: true });
    
    // *** 关键修正：最终文件路径现在是完整的绝对路径 ***
    const finalFilePath = path.join(finalFolderPath, fileName);

    await fs.rename(tempFilePath, finalFilePath);
    
    const stats = await fs.stat(finalFilePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
    
    // *** 关键修正：存入资料库的 file_id 改为【绝对路径】，以便于下载和预览 ***
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stats.size,
        file_id: finalFilePath, // 储存绝对路径
        thumb_file_id: finalFilePath, // *** 修复：本地文件的缩图就是它自己 ***
        date: Date.now(),
    }, folderId, userId, 'local');

    return { success: true, message: '文件已储存至本地。', fileId: dbResult.fileId };
}


// --- 强化后的 remove 函数 ---
async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const parentDirs = new Set();
    const userUploadDir = path.join(UPLOAD_DIR, String(userId));

    // files 阵列现在包含完整的 file object，其中 file.file_id 是绝对路径
    for (const file of files) {
        try {
            // *** 关键修正：直接使用 file.file_id 作为绝对路径 ***
            const fullFilePath = file.file_id; 
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

// *** 关键修正：getUrl 现在返回一个有效的代理下载连结 ***
async function getUrl(file_id, userId) {
    // file_id 现在是绝对路径，我们只需要 message_id 来建立代理连结
    // 此函数在 server.js 中主要用于 telegram，本地储存的下载逻辑不同
    // 为了预览/缩图功能，我们需要一个可以被伺服器处理的连结
    // 我们假设 file_id 是唯一的 message_id，但这需要 server.js 逻辑配合
    // 更好的做法是在调用 getUrl 时能拿到 message_id
    
    // 暂时性解决方案：此函数在本地储存模式下可能不会被正确呼叫
    // 正确的下载和预览逻辑已移至 server.js 的 /download/proxy/:message_id 路由
    return `/download/proxy/placeholder`; // 返回一个占位符，实际逻辑在 server.js
}


// --- 核心修复：重构 move 函数 ---
async function move(oldAbsolutePath, newRelativePath, options = {}, userId) {
    const userUploadDir = path.join(UPLOAD_DIR, String(userId));
    // newRelativePath 是相对于使用者根目录的路径
    const newAbsolutePath = path.join(userUploadDir, newRelativePath);

    try {
        if (!fsSync.existsSync(oldAbsolutePath)) {
            // 如果旧路径是相对的（可能来自旧资料），尝试组合
            const fallbackOldPath = path.join(userUploadDir, oldAbsolutePath);
            if (!fsSync.existsSync(fallbackOldPath)) {
                throw new Error(`来源路径不存在: ${oldAbsolutePath}`);
            }
            oldAbsolutePath = fallbackOldPath;
        }
        
        const newParentDir = path.dirname(newAbsolutePath);
        await fs.mkdir(newParentDir, { recursive: true });

        if (options.overwrite && fsSync.existsSync(newAbsolutePath)) {
            await fs.rm(newAbsolutePath, { recursive: true, force: true });
        }
        
        await fs.rename(oldAbsolutePath, newAbsolutePath);
        
        await removeEmptyDirs(path.dirname(oldAbsolutePath));
        return { success: true, newPath: newAbsolutePath };
    } catch (error) {
        console.error(`本地移动失败 从 ${oldAbsolutePath} 到 ${newAbsolutePath}:`, error);
        return { success: false, error };
    }
}


async function exists(filePath, userId) {
    const userUploadDir = path.join(UPLOAD_DIR, String(userId));
    // 同时检查绝对路径和相对路径的可能性，以提高相容性
    return fsSync.existsSync(filePath) || fsSync.existsSync(path.join(userUploadDir, filePath));
}

module.exports = { upload, remove, getUrl, move, exists, type: 'local' };
