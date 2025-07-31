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
        // 安全检查，确保不会删除上传目录之外的内容
        if (!directoryPath.startsWith(UPLOAD_DIR)) return;

        let currentPath = directoryPath;
        // 持续向上层目录检查，直到根上传目录为止
        while (currentPath !== UPLOAD_DIR && currentPath !== path.dirname(UPLOAD_DIR)) {
            const files = await fs.readdir(currentPath);
            if (files.length === 0) {
                await fs.rmdir(currentPath);
                currentPath = path.dirname(currentPath); // 移动到上层目录
            } else {
                break; // 如果目录不为空，则停止
            }
        }
    } catch (error) {
        // 忽略错误，例如目录不存在或权限问题
        console.warn(`清理空目录失败: ${directoryPath}`, error.message);
    }
}


async function upload(tempFilePath, fileName, mimetype, userId, folderId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    await fs.mkdir(userDir, { recursive: true });

    const uniqueId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const finalFilePath = path.join(userDir, uniqueId);

    // 从暂存区移动文件到最终位置，这比流式复制更高效
    await fs.rename(tempFilePath, finalFilePath);
    
    const stats = await fs.stat(finalFilePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stats.size,
        file_id: finalFilePath, // file_id 储存的是绝对路径
        thumb_file_id: null,
        date: Date.now(),
    }, folderId, userId, 'local');

    return { success: true, message: '文件已储存至本地。', fileId: dbResult.fileId };
}

// --- 修正后的 remove 函数 ---
async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const parentDirs = new Set();
    const userUploadDir = path.join(UPLOAD_DIR, String(userId));

    // 1. 删除所有文件
    for (const file of files) {
        try {
            if (file.file_id && fsSync.existsSync(file.file_id)) {
                parentDirs.add(path.dirname(file.file_id));
                await fs.unlink(file.file_id);
            }
        } catch (e) {
            const errorMessage = `删除本地文件失败: ${file.file_id}, ${e.message}`;
            console.warn(errorMessage);
            results.errors.push(errorMessage);
            results.success = false;
        }
    }
    
    // 2. 构建并排序资料夹路径，确保从最深层开始删除
    const folderPaths = folders
        .map(f => path.join(userUploadDir, f.path))
        .sort((a, b) => b.length - a.length);

    // 3. 删除所有资料夹
    for (const folderPath of folderPaths) {
        try {
            if (fsSync.existsSync(folderPath)) {
                parentDirs.add(path.dirname(folderPath));
                await fs.rmdir(folderPath);
            }
        } catch (e) {
            // 如果 rmdir 失败 (例如因为目录不为空)，记录错误
            const errorMessage = `删除本地资料夹失败: ${folderPath}, ${e.message}`;
            console.warn(errorMessage);
            results.errors.push(errorMessage);
            results.success = false;
        }
    }

    // 4. 清理可能产生的空目录
    for (const dir of parentDirs) {
        await removeEmptyDirs(dir);
    }

    return results;
}

async function getUrl(file_id, userId) {
    return `/local-files/${userId}/${path.basename(file_id)}`;
}

// --- 新增的 move 函数 ---
async function move(oldPath, newPath) {
    try {
        // 确保目标父目录存在
        const newParentDir = path.dirname(newPath);
        await fs.mkdir(newParentDir, { recursive: true });
        // 移动文件或文件夹
        await fs.rename(oldPath, newPath);
        // 清理旧的空父目录
        await removeEmptyDirs(path.dirname(oldPath));
        return { success: true };
    } catch (error) {
        console.error(`本地移动失败 从 ${oldPath} 到 ${newPath}:`, error);
        return { success: false, error };
    }
}

module.exports = { upload, remove, getUrl, move, type: 'local' };
