const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const data = require('../data.js'); // 依赖 data.js 来获取路径

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

// 启动时确保根上传目录存在
async function setup() {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
    } catch (e) {
        // 在生产环境中，可以记录到专门的日志文件
    }
}
setup();

// **重构：上传逻辑**
// 现在会根据 folderId 建立完整的目录结构
async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    
    // 获取目标资料夾的完整相对路径
    const folderPathParts = await data.getFolderPath(folderId, userId);
    // 从路径阵列建立相对于 userDir 的路径 (忽略根目录 '/')
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    // 建立目标目录
    await fs.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/'); // 储存相对路径

    // 从暂存位置移动档案到最终位置
    await fs.rename(tempFilePath, finalFilePath);
    
    const stats = await fs.stat(finalFilePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stats.size,
        file_id: relativeFilePath, // **关键：现在储存的是相对路径**
        thumb_file_id: null,
        date: Date.now(),
    }, folderId, userId, 'local');

    return { success: true, message: '文件已储存至本地。', fileId: dbResult.fileId };
}

// **重构：删除逻辑**
// 现在会删除实体档案，并清理空的父目录
async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const parentDirs = new Set(); // 用于后续清理

    // 删除档案
    for (const file of files) {
        try {
            const filePath = path.join(userDir, file.file_id); // file_id 是相对路径
            if (fsSync.existsSync(filePath)) {
                parentDirs.add(path.dirname(filePath));
                await fs.unlink(filePath);
            }
        } catch (error) {
            const errorMessage = `删除本地文件 [${file.file_id}] 失败: ${error.message}`;
            results.errors.push(errorMessage);
            results.success = false;
        }
    }

    // 删除资料夹
    for (const folder of folders) {
        try {
            // folder.path 也是相对路径
            const folderPath = path.join(userDir, folder.path);
            if (fsSync.existsSync(folderPath)) {
                parentDirs.add(path.dirname(folderPath));
                 await fs.rm(folderPath, { recursive: true, force: true });
            }
        } catch (error) {
            const errorMessage = `删除本地资料夹 [${folder.path}] 失败: ${error.message}`;
            results.errors.push(errorMessage);
            results.success = false;
        }
    }
    
    // 清理可能变为空的父目录
    for (const dir of parentDirs) {
        await removeEmptyDirsRecursive(dir, userDir);
    }
    
    return results;
}

// **修正：递回清理空目录的辅助函数**
async function removeEmptyDirsRecursive(directoryPath, userBaseDir) {
    try {
        // **关键修正**: 在尝试读取目录前，先检查它是否存在。
        // 这可以防止因其他清理操作已删除该目录而产生的错误日志。
        if (!fsSync.existsSync(directoryPath)) {
            return;
        }

        // 安全检查，确保不会删除到使用者目录之外
        if (!directoryPath.startsWith(userBaseDir) || directoryPath === userBaseDir) return;

        let currentPath = directoryPath;
        // 循环向上清理，每次循环也检查路径是否存在，更加保险
        while (currentPath !== userBaseDir && fsSync.existsSync(currentPath)) {
            const files = await fs.readdir(currentPath);
            if (files.length === 0) {
                await fs.rmdir(currentPath);
                currentPath = path.dirname(currentPath);
            } else {
                break; // 如果目录不为空，则停止
            }
        }
    } catch (error) {
        // 初始的存在性检查应该能避免大多数 ENOENT 错误，
        // 但保留 catch 以处理其他潜在的文件系统问题（如权限错误）。
    }
}

async function getUrl(file_id, userId) {
    // URL 保持不变，但 server.js 中的路由将处理这个相对路径
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    return finalFilePath;
}

// **新增：为本地储存提供 stream 方法**
function stream(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    if (fsSync.existsSync(finalFilePath)) {
        return fsSync.createReadStream(finalFilePath);
    }
    throw new Error('本地档案不存在');
}

module.exports = { upload, remove, getUrl, stream, type: 'local' };
