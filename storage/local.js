const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const data = require('../data.js');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

async function setup() {
    try {
        await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    } catch (e) {
        console.error("无法建立上传目录:", e);
    }
}
setup();

async function removeEmptyDirs(directoryPath) {
    try {
        if (!directoryPath.startsWith(UPLOAD_DIR) || directoryPath === UPLOAD_DIR) {
            return;
        }

        let currentPath = directoryPath;
        while (currentPath !== UPLOAD_DIR && currentPath !== path.dirname(UPLOAD_DIR)) {
            const files = await fsp.readdir(currentPath);
            if (files.length === 0) {
                await fsp.rmdir(currentPath);
                currentPath = path.dirname(currentPath);
            } else {
                break;
            }
        }
    } catch (error) {
        // 忽略在并发删除时可能发生的 "目录非空" 或 "目录不存在" 的错误
        if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') {
            console.warn(`清理空目录失败: ${directoryPath}`, error.message);
        }
    }
}


async function upload(tempFilePath, fileName, mimetype, userId, folderId, storage_id) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    await fsp.mkdir(userDir, { recursive: true });

    const uniqueId = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const finalFilePath = path.join(userDir, uniqueId);

    // 使用 fs.promises.copyFile，更简洁高效
    await fsp.copyFile(tempFilePath, finalFilePath);
    
    const stats = await fsp.stat(finalFilePath);

    const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));

    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stats.size,
        file_id: finalFilePath,
        thumb_file_id: null,
        date: stats.mtime.getTime(), // 使用档案的实际修改时间
        storage_id: 'local' // 本地储存的 storage_id 固定为 'local'
    }, folderId, userId, 'local');

    return { success: true, message: '文件已储存至本地。', fileId: dbResult.fileId };
}

async function remove(files, folders, userId) {
    const filePaths = files.map(f => f.file_id);
    const messageIds = files.map(f => f.message_id);
    const parentDirs = new Set();

    for (const filePath of filePaths) {
        try {
            // 使用 fsp.access 检查档案是否存在
            await fsp.access(filePath, fs.constants.F_OK);
            parentDirs.add(path.dirname(filePath));
            await fsp.unlink(filePath);
        } catch (e) {
            // 如果档案不存在 (ENOENT)，则静默忽略
            if (e.code !== 'ENOENT') {
                console.warn(`删除本地文件失败: ${filePath}`, e.message);
            }
        }
    }

    // 资料库删除操作应在档案删除后进行
    if (messageIds.length > 0) {
        await data.deleteFilesByIds(messageIds, userId);
    }
    
    // 清理空目录
    for (const dir of parentDirs) {
        await removeEmptyDirs(dir);
    }
    
    // 新增：处理资料夹删除
    // 对于本地储存，我们只删除资料库记录，因为实体档案已随档案一起处理
    // 空资料夹会在 removeEmptyDirs 中被清理
    const folderIds = folders.map(f => f.id);
    if (folderIds.length > 0) {
       // data.js 中的 executeDeletion 会处理资料库中的资料夹删除
    }

    return { success: true };
}

async function getUrl(file_id, userId) {
    // 修正：确保即使 file_id 包含完整路径，也能正确生成 URL
    return `/local-files/${userId}/${path.basename(file_id)}`;
}

module.exports = { upload, remove, getUrl, type: 'local' };
