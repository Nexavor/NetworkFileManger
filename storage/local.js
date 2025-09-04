const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const data = require('../data.js');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
const FILE_NAME = 'storage/local.js';

// --- 日志辅助函数 ---
const log = (level, func, message, ...args) => {
    // const timestamp = new Date().toISOString();
    // console.log(`[${timestamp}] [${level}] [${FILE_NAME}:${func}] - ${message}`, ...args);
};

async function setup() {
    try {
        await fsp.mkdir(UPLOAD_DIR, { recursive: true });
    } catch (e) {}
}
setup();

async function upload(fileStream, fileNameObject, mimetype, userId, folderId) {
    const FUNC_NAME = 'upload';
    // --- 关键修正：从物件中解构出原始档名和安全档名 ---
    const { originalFileName, safeFileName } = fileNameObject;
    
    log('INFO', FUNC_NAME, `开始上传文件: "${originalFileName}" (储存为 "${safeFileName}") 到本地储存...`);
    
    const userDir = path.join(UPLOAD_DIR, String(userId));
    
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    await fsp.mkdir(finalFolderPath, { recursive: true });

    // --- 关键修正：使用安全档名建立储存路径 ---
    const finalFilePath = path.join(finalFolderPath, safeFileName);
    const safeStoragePath = path.join(relativeFolderPath, safeFileName).replace(/\\/g, '/');


    return new Promise((resolve, reject) => {
        log('DEBUG', FUNC_NAME, `创建写入流到: "${finalFilePath}"`);
        const writeStream = fs.createWriteStream(finalFilePath);

        fileStream.on('error', err => {
            log('ERROR', FUNC_NAME, `输入文件流 (fileStream) 发生错误 for "${originalFileName}":`, err);
            writeStream.close();
            reject(err);
        });

        writeStream.on('pipe', () => { log('DEBUG', FUNC_NAME, `输入流已接入 (pipe) 写入流 for "${originalFileName}"`); });
        writeStream.on('drain', () => { log('DEBUG', FUNC_NAME, `写入流 'drain' 事件触发 for "${originalFileName}"。可以继续写入。`); });
        
        writeStream.on('finish', async () => {
            log('INFO', FUNC_NAME, `文件写入磁盘完成 (finish): "${safeFileName}"`);
            try {
                const stats = await fsp.stat(finalFilePath);
                log('DEBUG', FUNC_NAME, `获取文件状态成功，大小: ${stats.size}`);
                const messageId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));
                
                log('DEBUG', FUNC_NAME, `正在将文件资讯添加到资料库: "${originalFileName}"`);
                // --- 关键修正：向 data.js 传入原始档名和安全路径 ---
                const dbResult = await data.addFile({
                    message_id: messageId,
                    originalFileName: originalFileName,
                    mimetype,
                    size: stats.size,
                    safeStoragePath: safeStoragePath,
                    thumb_file_id: null,
                    date: Date.now(),
                }, folderId, userId, 'local');
                
                log('INFO', FUNC_NAME, `文件 "${originalFileName}" 已成功存入资料库。`);
                resolve({ success: true, message: '文件已储存至本地。', fileId: dbResult.fileId });
            } catch (err) {
                 log('ERROR', FUNC_NAME, `写入资料库时发生错误 for "${originalFileName}":`, err);
                 reject(err);
            }
        });
        writeStream.on('error', err => {
            log('ERROR', FUNC_NAME, `写入流 (writeStream) 发生错误 for "${originalFileName}":`, err);
            reject(err);
        });
        
        log('DEBUG', FUNC_NAME, `正在将输入流 pipe 到写入流 for "${originalFileName}"`);
        fileStream.pipe(writeStream);
    });
}


async function remove(files, folders, userId) {
    const results = { success: true, errors: [] };
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const parentDirs = new Set();

    for (const file of files) {
        try {
            const filePath = path.join(userDir, file.file_id);
            if (fs.existsSync(filePath)) {
                parentDirs.add(path.dirname(filePath));
                await fsp.unlink(filePath);
            }
        } catch (error) {
            results.errors.push(`删除本地文件 [${file.file_id}] 失败: ${error.message}`);
            results.success = false;
        }
    }

    for (const folder of folders) {
        try {
            const folderPath = path.join(userDir, folder.path);
            if (fs.existsSync(folderPath)) {
                parentDirs.add(path.dirname(folderPath));
                 await fsp.rm(folderPath, { recursive: true, force: true });
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
        if (!fs.existsSync(directoryPath) || !directoryPath.startsWith(userBaseDir) || directoryPath === userBaseDir) {
            return;
        }
        let currentPath = directoryPath;
        while (currentPath !== userBaseDir && fs.existsSync(currentPath)) {
            const files = await fsp.readdir(currentPath);
            if (files.length === 0) {
                await fsp.rmdir(currentPath);
                currentPath = path.dirname(currentPath);
            } else {
                break; 
            }
        }
    } catch (error) {}
}

async function getUrl(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    return finalFilePath;
}

function stream(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    if (fs.existsSync(finalFilePath)) {
        return fs.createReadStream(finalFilePath);
    }
    throw new Error('本地档案不存在');
}

module.exports = { upload, remove, getUrl, stream, type: 'local' };
