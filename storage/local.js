const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const data = require('../data.js'); 

const UPLOAD_DIR = path.resolve(__dirname, '..', 'data', 'uploads');

async function setup() {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        console.log(`[STORAGE-LOCAL] 确认本地上传根目录存在: ${UPLOAD_DIR}`);
    } catch (e) {
        console.error(`[STORAGE-LOCAL-ERROR] 初始化本地储存目录失败:`, e);
    }
}
setup();

async function upload(stream, fileName, mimetype, userId, folderId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    console.log(`[STORAGE-LOCAL] 准备上传档案 "${fileName}" 到目录: ${finalFolderPath}`);
    await fs.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/');

    const writeStream = fsSync.createWriteStream(finalFilePath);
    stream.pipe(writeStream);

    return new Promise((resolve, reject) => {
        writeStream.on('finish', async () => {
            try {
                const stats = await fs.stat(finalFilePath);
                console.log(`[STORAGE-LOCAL] 档案 "${fileName}" 已成功写入本地，大小: ${stats.size} bytes`);
                const messageId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));

                const dbResult = await data.addFile({
                    message_id: messageId,
                    fileName,
                    mimetype,
                    size: stats.size,
                    file_id: relativeFilePath,
                    thumb_file_id: null,
                    date: Date.now(),
                }, folderId, userId, 'local');

                console.log(`[STORAGE-LOCAL] 档案 "${fileName}" 的资料已写入资料库, ID: ${dbResult.fileId}`);
                resolve({ success: true, message: '文件已储存至本地。', fileId: dbResult.fileId });
            } catch (dbError) {
                console.error(`[STORAGE-LOCAL-ERROR] 写入资料库时失败 for file "${fileName}":`, dbError);
                reject(dbError);
            }
        });
        writeStream.on('error', (err) => {
             console.error(`[STORAGE-LOCAL-ERROR] 写入档案流时失败 for file "${fileName}":`, err);
             reject(err);
        });
        stream.on('error', (err) => {
             console.error(`[STORAGE-LOCAL-ERROR] 读取来源流时失败 for file "${fileName}":`, err);
             reject(err);
        });
    });
}

async function remove(files, folders, userId) {
    console.log(`[STORAGE-LOCAL] 开始删除操作 for User ID: ${userId}. 档案: ${files.length}, 资料夹: ${folders.length}`);
    const results = { success: true, errors: [] };
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const parentDirs = new Set(); 

    for (const file of files) {
        try {
            const filePath = path.join(userDir, file.file_id);
            if (fsSync.existsSync(filePath)) {
                parentDirs.add(path.dirname(filePath));
                await fs.unlink(filePath);
                console.log(`[STORAGE-LOCAL] 已删除档案: ${filePath}`);
            } else {
                 console.warn(`[STORAGE-LOCAL] 欲删除的档案不存在，跳过: ${filePath}`);
            }
        } catch (error) {
            const errorMessage = `删除本地文件 [${file.file_id}] 失败: ${error.message}`;
            console.error(`[STORAGE-LOCAL-ERROR] ${errorMessage}`);
            results.errors.push(errorMessage);
            results.success = false;
        }
    }

    for (const folder of folders) {
        try {
            const folderPath = path.join(userDir, folder.path);
            if (fsSync.existsSync(folderPath)) {
                parentDirs.add(path.dirname(folderPath));
                 await fs.rm(folderPath, { recursive: true, force: true });
                 console.log(`[STORAGE-LOCAL] 已递回删除资料夹: ${folderPath}`);
            } else {
                console.warn(`[STORAGE-LOCAL] 欲删除的资料夹不存在，跳过: ${folderPath}`);
            }
        } catch (error) {
            const errorMessage = `删除本地资料夹 [${folder.path}] 失败: ${error.message}`;
            console.error(`[STORAGE-LOCAL-ERROR] ${errorMessage}`);
            results.errors.push(errorMessage);
            results.success = false;
        }
    }
    
    console.log('[STORAGE-LOCAL] 档案与资料夹删除完毕，开始清理空目录...');
    for (const dir of parentDirs) {
        await removeEmptyDirsRecursive(dir, userDir);
    }
    console.log('[STORAGE-LOCAL] 清理空目录完成。');
    
    return results;
}

// *** 关键修正：递回清理空目录的辅助函数 ***
async function removeEmptyDirsRecursive(directoryPath, userBaseDir) {
    try {
        // 在尝试读取目录前，先检查它是否存在
        if (!fsSync.existsSync(directoryPath)) {
            return;
        }
        
        // 安全检查，确保不会删除到使用者目录之外
        if (!directoryPath.startsWith(userBaseDir) || directoryPath === userBaseDir) return;

        let currentPath = directoryPath;
        while (currentPath !== userBaseDir && fsSync.existsSync(currentPath)) {
            const files = await fs.readdir(currentPath);
            if (files.length === 0) {
                console.log(`[STORAGE-LOCAL] 清理空目录: ${currentPath}`);
                await fs.rmdir(currentPath);
                currentPath = path.dirname(currentPath);
            } else {
                break;
            }
        }
    } catch (error) {
        console.warn(`[STORAGE-LOCAL-WARN] 清理空目录时发生非致命错误 (可能已被其他程序删除): ${error.message}`);
    }
}


async function getUrl(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    return finalFilePath;
}

function stream(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    if (fsSync.existsSync(finalFilePath)) {
        console.log(`[STORAGE-LOCAL] 建立档案读取流: ${finalFilePath}`);
        return fsSync.createReadStream(finalFilePath);
    }
    console.error(`[STORAGE-LOCAL-ERROR] 尝试建立流失败，档案不存在: ${finalFilePath}`);
    throw new Error('本地档案不存在');
}

module.exports = { upload, remove, getUrl, stream, type: 'local' };
