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
        console.error("无法建立上传目录:", e);
    }
}
setup();

// **重构：上傳邏輯**
// 現在會根據 folderId 建立完整的目錄結構
async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    
    // 獲取目標資料夾的完整相對路徑
    const folderPathParts = await data.getFolderPath(folderId, userId);
    // 從路徑陣列建立相對於 userDir 的路徑 (忽略根目录 '/')
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    // 建立目標目錄
    await fs.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/'); // 儲存相對路徑

    // 從暫存位置移動檔案到最終位置
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
    const parentDirs = new Set(); // 用於後續清理

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
            console.error(errorMessage);
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
            console.error(errorMessage);
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

// **新增：递回清理空目录的辅助函数**
async function removeEmptyDirsRecursive(directoryPath, userBaseDir) {
    try {
        // 安全检查，确保不会删除到使用者目录之外
        if (!directoryPath.startsWith(userBaseDir) || directoryPath === userBaseDir) return;

        let currentPath = directoryPath;
        while (currentPath !== userBaseDir) {
            const files = await fs.readdir(currentPath);
            if (files.length === 0) {
                await fs.rmdir(currentPath);
                currentPath = path.dirname(currentPath);
            } else {
                break; // 如果目录不为空，则停止
            }
        }
    } catch (error) {
        // 忽略错误，例如目录不存在或权限问题
        console.warn(`清理空目录时发生错误: ${directoryPath}`, error.message);
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
