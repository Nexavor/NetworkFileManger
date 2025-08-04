const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const data = require('../data.js');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

async function setup() {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        console.log('[Local Storage] 上传目录已确认存在:', UPLOAD_DIR);
    } catch (e) {
        console.error('[Local Storage] 建立上传目录失败:', e);
    }
}
setup();

// *** 核心修改：upload 函数现在直接接收档案流 (fileStream) 和一个获取大小的函式 (getFileSize) ***
async function upload(fileStream, fileName, mimetype, getFileSize, userId, folderId) {
    console.log(`[Local Storage] 开始处理流式上传: ${fileName}`);
    const userDir = path.join(UPLOAD_DIR, String(userId));
    
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    await fs.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/');
    console.log(`[Local Storage] 最终档案路径: ${finalFilePath}`);

    // **直接将传入的档案流写入到最终位置**
    await new Promise((resolve, reject) => {
        const writeStream = fsSync.createWriteStream(finalFilePath);
        
        fileStream.on('error', (err) => {
            console.error(`[Local Storage] 读取来源档案流失败: ${fileName}`, err);
            reject(err);
        });
        writeStream.on('error', (err) => {
            console.error(`[Local Storage] 写入最终档案流失败: ${finalFilePath}`, err);
            reject(err);
        });
        writeStream.on('finish', () => {
            console.log(`[Local Storage] 档案流式传输完成: ${fileName}`);
            resolve();
        });
        
        fileStream.pipe(writeStream);
    });
    
    // **档案大小只有在流传输结束后才能确定**
    const finalSize = getFileSize();
    console.log(`[Local Storage] 档案流传输完成，最终大小: ${finalSize} bytes`);
    
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));
    
    console.log(`[Local Storage] 正在将档案资讯写入资料库: ${fileName}`);
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: finalSize,
        file_id: relativeFilePath,
        thumb_file_id: null,
        date: Date.now(),
    }, folderId, userId, 'local');
    
    console.log(`[Local Storage] 档案 ${fileName} 成功储存至本地并记录到资料库。`);
    return { success: true, message: '文件已储存至本地。', fileId: dbResult.fileId };
}


async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const parentDirs = new Set();

    for (const file of files) {
        try {
            const filePath = path.join(userDir, file.file_id);
            if (fsSync.existsSync(filePath)) {
                parentDirs.add(path.dirname(filePath));
                await fs.unlink(filePath);
            }
        } catch (error) {
            results.errors.push(`删除本地文件 [${file.file_id}] 失败: ${error.message}`);
            results.success = false;
        }
    }

    for (const folder of folders) {
        try {
            const folderPath = path.join(userDir, folder.path);
            if (fsSync.existsSync(folderPath)) {
                parentDirs.add(path.dirname(folderPath));
                 await fs.rm(folderPath, { recursive: true, force: true });
            }
        } catch (error) {
            results.errors.push(`删除本地资料夹 [${folder.path}] 失败: ${error.message}`);
            results.success = false;
        }
    }
    
    for (const dir of parentDirs) {
        await removeEmptyDirsRecursive(dir, userDir);
    }
    
    return results;
}

async function removeEmptyDirsRecursive(directoryPath, userBaseDir) {
    try {
        if (!fsSync.existsSync(directoryPath)) {
            return;
        }

        if (!directoryPath.startsWith(userBaseDir) || directoryPath === userBaseDir) return;

        let currentPath = directoryPath;
        while (currentPath !== userBaseDir && fsSync.existsSync(currentPath)) {
            const files = await fs.readdir(currentPath);
if (files.length === 0) {
                await fs.rmdir(currentPath);
                currentPath = path.dirname(currentPath);
            } else {
                break;
            }
        }
    } catch (error) {
        // Ignored
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
        return fsSync.createReadStream(finalFilePath);
    }
    throw new Error('本地档案不存在');
}

module.exports = { upload, remove, getUrl, stream, type: 'local' };
