// storage/local.js
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const data = require('../data.js');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');

async function setup() {
    try { await fsp.mkdir(UPLOAD_DIR, { recursive: true }); } catch (e) {}
}
setup();

async function upload(fileStreamOrBuffer, fileName, mimetype, userId, folderId, caption = '', existingItem = null) {
    // ... (原有上传逻辑保持不变，为了节省篇幅，这里省略，请保留原代码) ...
    // 请确保直接复制上面的 upload 函数实现到这里
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const folderPathParts = await data.getFolderPath(folderId, userId);
    const relativeFolderPath = path.join(...folderPathParts.slice(1).map(p => p.name)); 
    const finalFolderPath = path.join(userDir, relativeFolderPath);

    await fsp.mkdir(finalFolderPath, { recursive: true });

    const finalFilePath = path.join(finalFolderPath, fileName);
    const relativeFilePath = path.join(relativeFolderPath, fileName).replace(/\\/g, '/');

    const updateDatabase = async (size) => {
        if (existingItem) {
            await data.updateFile(existingItem.message_id, {
                mimetype: mimetype,
                file_id: relativeFilePath,
                size: size,
                date: Date.now(),
            }, userId);
            return { success: true, message: '覆盖成功', fileId: existingItem.message_id };
        } else {
            const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
            const dbResult = await data.addFile({
                message_id: messageId,
                fileName,
                mimetype,
                size: size,
                file_id: relativeFilePath,
                thumb_file_id: null,
                date: Date.now(),
            }, folderId, userId, 'local');
            return { success: true, message: '上传成功', fileId: dbResult.fileId };
        }
    };

    if (Buffer.isBuffer(fileStreamOrBuffer)) {
        try {
            await fsp.writeFile(finalFilePath, fileStreamOrBuffer);
            const stats = await fsp.stat(finalFilePath);
            return await updateDatabase(stats.size);
        } catch (err) { throw err; }
    } else {
        return new Promise((resolve, reject) => {
            const writeStream = fs.createWriteStream(finalFilePath);
            const fileStream = fileStreamOrBuffer; 
            if (typeof fileStream.pipe !== 'function') return reject(new Error('输入不是有效的流或 Buffer'));
            fileStream.on('error', err => { writeStream.close(); fs.unlink(finalFilePath, () => {}); reject(err); });
            writeStream.on('finish', async () => {
                try {
                    const stats = await fsp.stat(finalFilePath);
                    const result = await updateDatabase(stats.size);
                    resolve(result);
                } catch (err) { reject(err); }
            });
            writeStream.on('error', err => { fs.unlink(finalFilePath, () => {}); reject(err); });
            fileStream.pipe(writeStream);
        });
    }
}

async function remove(files, folders, userId) {
    // ... (保留原逻辑) ...
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
            results.errors.push(`删除文件失败: ${error.message}`);
            results.success = false;
        }
    }
    // 本地文件夹删除仅在物理删除时进行
    return results;
}

async function removeEmptyDirsRecursive(directoryPath, userBaseDir) {
     // ... (保留原逻辑) ...
     try {
        if (!fs.existsSync(directoryPath) || !directoryPath.startsWith(userBaseDir) || directoryPath === userBaseDir) return;
        let currentPath = directoryPath;
        while (currentPath !== userBaseDir && fs.existsSync(currentPath)) {
            const files = await fsp.readdir(currentPath);
            if (files.length === 0) {
                await fsp.rmdir(currentPath);
                currentPath = path.dirname(currentPath);
            } else { break; }
        }
    } catch (error) {}
}

async function getUrl(file_id, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    return path.join(userDir, file_id);
}

function stream(file_id, userId, options) { 
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const finalFilePath = path.join(userDir, file_id);
    if (fs.existsSync(finalFilePath)) {
        return fs.createReadStream(finalFilePath, options);
    }
    throw new Error('本地档案不存在');
}

// --- 新增 Copy 功能 ---
async function copy(file, newFileName, userId) {
    const userDir = path.join(UPLOAD_DIR, String(userId));
    const oldPath = path.join(userDir, file.file_id);
    const targetDir = path.dirname(oldPath); // 复制到同一目录下，文件名由 data.js 决定
    
    // 为了支持跨目录复制，这里应该根据 data.js 传递的目标路径来定，
    // 但 data.js 的 copyItem 逻辑通常是先确定新文件名。
    // 假设 copyItem 会处理同目录下的重命名逻辑。
    // 如果是移动到新目录，file_id 会改变。
    // 这里我们简化：复制到与源文件相同的物理目录结构中（但文件名不同）。
    
    // 注意：如果跨文件夹复制，newFileName 应该只是文件名，我们需要构建新的 file_id
    // 这里的 file_id 是相对路径。我们假设复制的目标目录就是源文件所在目录
    // 如果要支持复制到不同目录，copy 函数需要接收目标 folderId 的路径信息
    // 为了简单起见，我们这里只实现文件层面的复制，路径逻辑由 data.js 控制
    
    // 修正：data.js 的 copyItem 会先计算出新的 file_id (包含路径)。
    // 所以 copy 函数应该接收完整的新 file_id 而不是 newFileName?
    // 为了保持接口一致性，我们让 data.js 处理好逻辑，这里仅仅做物理复制。
    // 由于 storage.copy 接口定义尚未明确，我们定义为 copy(file, newRelativePath, userId)
    
    // 重新定义：第二个参数是完整的新相对路径
    const newRelativePath = newFileName; // 这里的 newFileName 实际上是 data.js 传来的新路径
    const newPath = path.join(userDir, newRelativePath);
    
    await fsp.mkdir(path.dirname(newPath), { recursive: true });
    await fsp.copyFile(oldPath, newPath);
    
    return newRelativePath;
}

module.exports = { upload, remove, getUrl, stream, copy, type: 'local' };
