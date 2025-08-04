const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const data = require('./data.js'); // 依赖 data.js 来获取路径

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

// 启动时确保根上传目录存在
async function setup() {
    try {
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        console.log('[Local Storage] 上传目录已确认存在:', UPLOAD_DIR);
    } catch (e) {
        console.error('[Local Storage] 建立上传目录失败:', e);
    }
}
setup();

// upload 函数重构为直接接收 fileStream
async function upload(fileStream, fileName, mimetype, userId, folderId, caption = '', fileSize) {
    console.log(`[Local Storage] 开始通过流上传档案: ${fileName}`);
    const userDir = path.join(UPLOAD_DIR, String(userId));
    
    // 获取目标资料夾的完整相对路径
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    // 建立目标目录
    console.log(`[Local Storage] 确保目标目录存在: ${finalFolderPath}`);
    await fs.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/');
    console.log(`[Local Storage] 最终档案路径: ${finalFilePath}`);

    // 使用流式传输写入文件
    await new Promise((resolve, reject) => {
        const writeStream = fsSync.createWriteStream(finalFilePath);
        fileStream.pipe(writeStream);
        writeStream.on('finish', () => {
            console.log(`[Local Storage] 档案流式传输完成: ${fileName}`);
            resolve();
        });
        writeStream.on('error', (err) => {
            console.error(`[Local Storage] 写入最终档案流失败: ${finalFilePath}`, err);
            reject(err);
        });
         fileStream.on('error', (err) => {
            console.error(`[Local Storage] 读取来源档案流时发生错误`, err);
            writeStream.end(); // 确保写入流被关闭
            reject(err);
        });
    });
    
    const stats = await fs.stat(finalFilePath);
    const messageId = BigInt(Date.now()) * 1000000n + BigInt(Math.floor(Math.random() * 1000000));
    
    console.log(`[Local Storage] 正在将档案资讯写入资料库: ${fileName}`);
    const dbResult = await data.addFile({
        message_id: messageId,
        fileName,
        mimetype,
        size: stats.size,
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
            const errorMessage = `删除本地文件 [${file.file_id}] 失败: ${error.message}`;
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
            }
        } catch (error) {
            const errorMessage = `删除本地资料夹 [${folder.path}] 失败: ${error.message}`;
            results.errors.push(errorMessage);
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
