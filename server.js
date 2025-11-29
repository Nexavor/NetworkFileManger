// server.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const Busboy = require('busboy');
const path = require('path');
const axios = require('axios');
const archiver = require('archiver');
const bcrypt = require('bcrypt');
const fs = require('fs');
const fsp = require('fs').promises;
const crypto = require('crypto');
const db = require('./database.js');
const data = require('./data.js');
const storageManager = require('./storage');
const { encrypt, decrypt } = require('./crypto.js');

const app = express();

// 处理 JSON 中的 BigInt 序列化
const jsonReplacer = (key, value) => {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
};
app.set('json replacer', jsonReplacer);

const TMP_DIR = path.join(__dirname, 'data', 'tmp');

// --- 调试日志工具 ---
const log = (tag, message) => {
    const time = new Date().toISOString();
    console.log(`[${time}] [${tag}] ${message}`);
};

// 清理临时目录
async function cleanupTempDir() {
    try {
        if (!fs.existsSync(TMP_DIR)) {
            await fsp.mkdir(TMP_DIR, { recursive: true });
            return;
        }
        const files = await fsp.readdir(TMP_DIR);
        for (const file of files) {
            try {
                await fsp.unlink(path.join(TMP_DIR, file));
            } catch (err) {}
        }
    } catch (error) {}
}
cleanupTempDir();

// --- 定时任务：清理回收站 ---
// 每天检查一次，删除超过 30 天的文件
setInterval(async () => {
    try {
        const result = await data.cleanupTrash(30);
        if (result.filesCount > 0 || result.foldersCount > 0) {
            log('CRON', `回收站自动清理: ${result.filesCount} 个文件, ${result.foldersCount} 个资料夹`);
        }
    } catch (e) {
        log('CRON_ERR', `回收站清理失败: ${e.message}`);
    }
}, 1000 * 60 * 60 * 24);

const PORT = process.env.PORT || 8100;

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-strong-random-secret-here-please-change',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } 
}));

// 分享链接的专用 Session
const shareSession = session({
  secret: process.env.SESSION_SECRET + '-share',
  resave: false,
  saveUninitialized: true,
  cookie: { /* maxAge 已移除，浏览器关闭即失效 */ }
});

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser()); 

// --- 自动登入中间件 ---
async function checkRememberMeCookie(req, res, next) {
    if (req.session.loggedIn) {
        return next();
    }
    const rememberToken = req.cookies.remember_me;
    if (rememberToken) {
        try {
            const tokenData = await data.findAuthToken(rememberToken);
            if (tokenData && tokenData.expires_at > Date.now()) {
                const user = { id: tokenData.user_id, username: tokenData.username, is_admin: tokenData.is_admin };
                req.session.loggedIn = true;
                req.session.userId = user.id;
                req.session.isAdmin = !!user.is_admin;
                req.session.unlockedFolders = [];
                
                // --- 修正: 使用原子操作 rollAuthToken 解决竞争条件 ---
                const newRememberToken = crypto.randomBytes(64).toString('hex');
                const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
                
                const rollResult = await data.rollAuthToken(
                    rememberToken, 
                    user.id, 
                    expiresAt, 
                    newRememberToken
                );

                if (rollResult.rolled) {
                    // 只有成功滚动（即未遇到竞争）的请求才设置新 Cookie
                    res.cookie('remember_me', rollResult.newRememberToken, {
                        path: '/',
                        httpOnly: true,
                        secure: req.protocol === 'https',
                        maxAge: 30 * 24 * 60 * 60 * 1000 
                    });
                }
                
                // 确保 session maxAge 被延长，无论是否滚动成功
                if (req.session.cookie.maxAge !== 30 * 24 * 60 * 60 * 1000) {
                     req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
                }
                // --- 修正结束 ---

            } else if (tokenData) {
                await data.deleteAuthToken(rememberToken);
                res.clearCookie('remember_me', { path: '/' });
            } else {
                res.clearCookie('remember_me', { path: '/' });
            }
        } catch (err) {
            console.error('Check remember token error:', err);
            res.clearCookie('remember_me', { path: '/' });
        }
    }
    return next();
}
app.use(checkRememberMeCookie); 

// 定时清理过期 Token
setInterval(async () => {
    try { await data.deleteExpiredAuthTokens(); } catch (e) {}
}, 1000 * 60 * 60 * 24);

function requireLogin(req, res, next) {
  if (req.session.loggedIn) return next();
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
    return res.status(401).json({ success: false, message: '会话已过期，请重新登入。' });
  } else {
    res.redirect('/login');
  }
}

function requireAdmin(req, res, next) {
    if (req.session.loggedIn && req.session.isAdmin) {
        return next();
    }
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
        return res.status(403).json({ success: false, message: '权限不足。' });
    } else {
        res.status(403).send('权限不足');
    }
}

// --- 页面路由 ---
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views/login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'views/register.html')));
app.get('/editor', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/editor.html')));

app.post('/login', async (req, res) => {
    try {
        const user = await data.findUserByName(req.body.username);
        if (user && await bcrypt.compare(req.body.password, user.password)) {
            req.session.loggedIn = true;
            req.session.userId = user.id;
            req.session.isAdmin = !!user.is_admin;
            req.session.unlockedFolders = [];

            if (req.body.remember) {
                const rememberToken = crypto.randomBytes(64).toString('hex');
                const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
                try {
                    await data.createAuthToken(user.id, rememberToken, expiresAt);
                    res.cookie('remember_me', rememberToken, {
                        path: '/',
                        httpOnly: true,
                        secure: req.protocol === 'https',
                        maxAge: 30 * 24 * 60 * 60 * 1000
                    });
                    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
                } catch (tokenError) {
                    req.session.cookie.expires = false;
                    req.session.cookie.maxAge = null;
                }
            } else {
                req.session.cookie.expires = false;
                req.session.cookie.maxAge = null;
            }
            res.redirect('/');
        } else {
            res.status(401).send('帐号或密码错误');
        }
    } catch(error) {
        res.status(500).send('登入时发生错误');
    }
});

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).send('请提供使用者名称和密码');
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = await data.createUser(username, hashedPassword);
        await data.createFolder('/', null, newUser.id);
        await fsp.mkdir(path.join(__dirname, 'data', 'uploads', String(newUser.id)), { recursive: true });
        res.redirect('/login');
    } catch (error) {
        res.status(500).send('注册失败，使用者名称可能已被使用。');
    }
});

app.get('/logout', (req, res) => {
    const rememberToken = req.cookies.remember_me;
    if (rememberToken) {
        data.deleteAuthToken(rememberToken).catch(() => {});
    }
    res.clearCookie('remember_me', { path: '/' });
    req.session.destroy(err => {
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

app.get('/', requireLogin, (req, res) => {
    db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [req.session.userId], (err, rootFolder) => {
        if (err || !rootFolder) {
            data.createFolder('/', null, req.session.userId)
                .then(newRoot => res.redirect(`/view/${encrypt(newRoot.id)}`))
                .catch(() => res.status(500).send("找不到您的根目录，也无法建立。"));
            return;
        }
        res.redirect(`/view/${encrypt(rootFolder.id)}`);
    });
});

app.get('/view/:encryptedId', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/manager.html')));
app.get('/shares-page', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/shares.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin.html')));
app.get('/scan', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/scan.html')));

// --- 上传路由 (含配额检查) ---
app.post('/upload', requireLogin, async (req, res) => {
    const { folderId, resolutions: resolutionsJSON, caption } = req.query;
    const userId = req.session.userId;
    const storage = storageManager.getStorage();
    const config = storageManager.readConfig();
    const uploadMode = config.uploadMode || 'stream'; 
    const MAX_FILENAME_BYTES = 255; 

    // 获取用户配额信息
    let quota;
    try {
        quota = await data.getUserQuota(userId);
    } catch (e) {
        return res.status(500).json({ success: false, message: '获取用户配额失败' });
    }

    log('UPLOAD_START', `User: ${userId}, Mode: ${uploadMode}, Folder: ${folderId}`);

    try {
        if (!folderId) throw new Error('缺少 folderId');
        const initialFolderId = parseInt(folderId, 10);
        if (isNaN(initialFolderId)) throw new Error('无效的 folderId');
        
        const resolutions = JSON.parse(resolutionsJSON || '{}');
        
        const busboy = Busboy({ headers: req.headers });
        const uploadPromises = [];
        let currentRequestUploadSize = 0; // 追踪本次请求累积的上传量 (仅 buffer 模式有效)

        busboy.on('file', (fieldname, fileStream, fileInfo) => {
            const relativePath = Buffer.from(fieldname, 'latin1').toString('utf8');
            log('BUSBOY_FILE', `开始接收文件: ${relativePath}, Encoding: ${fileInfo.encoding}, Mime: ${fileInfo.mimeType}`);
            
            const fileUploadPromise = (async () => {
                const { mimeType } = fileInfo;
                const pathParts = relativePath.split('/').filter(p => p);
                let finalFilename = pathParts.pop() || relativePath;

                if (Buffer.byteLength(finalFilename, 'utf8') > MAX_FILENAME_BYTES) {
                    fileStream.resume(); 
                    throw new Error(`档名过长: ${finalFilename}`);
                }

                const action = resolutions[relativePath] || 'upload';
                if (action === 'skip') {
                    log('UPLOAD_SKIP', `跳过文件: ${finalFilename}`);
                    fileStream.resume();
                    return { skipped: true };
                }

                const folderPathParts = pathParts;
                const targetFolderId = await data.resolvePathToFolderId(initialFolderId, folderPathParts, userId);
                
                let existingItem = null;
                if (action === 'overwrite') {
                    existingItem = await data.findItemInFolder(finalFilename, targetFolderId, userId);
                } else if (action === 'rename') {
                    finalFilename = await data.findAvailableName(finalFilename, targetFolderId, userId, false);
                } else {
                    const conflict = await data.findItemInFolder(finalFilename, targetFolderId, userId);
                    if (conflict) {
                        fileStream.resume();
                        return { skipped: true };
                    }
                }
                
                if (uploadMode === 'buffer') {
                    // --- 缓冲模式：先写入本地临时文件 ---
                    const tempFileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${path.basename(finalFilename)}`;
                    const tempFilePath = path.join(TMP_DIR, tempFileName);
                    log('BUFFER_MODE', `缓冲写入临时文件: ${tempFilePath}`);

                    try {
                        // 1. 写入临时文件
                        const writeStream = fs.createWriteStream(tempFilePath);
                        
                        await new Promise((resolve, reject) => {
                            fileStream.pipe(writeStream);
                            
                            fileStream.on('error', err => reject(err));
                            writeStream.on('error', err => reject(err));
                            writeStream.on('finish', resolve);
                        });

                        const stats = await fsp.stat(tempFilePath);
                        if (stats.size === 0) {
                             throw new Error("接收到的文件大小为 0 字节，上传中止。");
                        }

                        // 2. 配额检查 (Buffer 模式可以精确检查)
                        // 检查：已用空间 + 本次请求之前累积的 + 当前文件大小 > 最大配额
                        if (quota.used + currentRequestUploadSize + stats.size > quota.max) {
                            throw new Error(`存储空间不足 (文件大小: ${stats.size} bytes, 剩余: ${quota.max - quota.used - currentRequestUploadSize} bytes)`);
                        }
                        currentRequestUploadSize += stats.size;

                        // 3. 上传到最终存储
                        log('BUFFER_UPLOAD', `开始将临时文件上传到后端 (${storage.type}): ${finalFilename}`);
                        
                        let uploadData;
                        if (stats.size < 50 * 1024 * 1024) { 
                            log('BUFFER_STRATEGY', `文件较小 (${stats.size})，使用 Buffer 上传以确保稳定`);
                            uploadData = await fsp.readFile(tempFilePath);
                        } else {
                            log('BUFFER_STRATEGY', `文件较大 (${stats.size})，使用 Stream 上传`);
                            uploadData = fs.createReadStream(tempFilePath);
                        }

                        await storage.upload(uploadData, finalFilename, mimeType, userId, targetFolderId, caption || '', existingItem);
                        log('BUFFER_SUCCESS', `后端上传成功: ${finalFilename}`);

                    } finally {
                        if (fs.existsSync(tempFilePath)) {
                            await fsp.unlink(tempFilePath).catch(e => log('CLEANUP_ERR', e.message));
                        }
                    }
                } else {
                    // --- 流式模式 ---
                    log('STREAM_MODE', `启用流式上传: ${finalFilename}`);
                    
                    // 流式模式配额预检 (只能基于当前已用空间，无法准确预知流大小)
                    if (quota.used >= quota.max) {
                         fileStream.resume();
                         throw new Error('存储空间已满，无法上传。');
                    }

                    // 直接将原始流传给 storage
                    await storage.upload(fileStream, finalFilename, mimeType, userId, targetFolderId, caption || '', existingItem);
                    log('STREAM_SUCCESS', `上传流程结束: ${finalFilename}`);
                }

                return { skipped: false };
            })().catch(err => {
                log('UPLOAD_ERR', `处理文件失败 ${relativePath}: ${err.message}`);
                fileStream.resume(); 
                return { success: false, error: err };
            });
            
            uploadPromises.push(fileUploadPromise);
        });

        busboy.on('finish', async () => {
            log('BUSBOY_FINISH', 'Busboy 解析完成，等待所有上传任务结束...');
            try {
                const results = await Promise.all(uploadPromises);
                const errors = results.filter(r => r && r.error);
                if (errors.length > 0) {
                     // 如果有错误，取第一个错误返回给前端
                     log('UPLOAD_FAIL', `总任务中有 ${errors.length} 个错误。第一个错误: ${errors[0].error.message}`);
                     throw errors[0].error;
                }
                const allSkipped = results.length > 0 && results.every(r => r.skipped);
                if (allSkipped) {
                     res.json({ success: true, skippedAll: true, message: '所有文件都因冲突而被跳过' });
                } else {
                     res.json({ success: true, message: '上传完成' });
                }
            } catch (error) {
                if (!res.headersSent) {
                    res.status(500).json({ success: false, message: `上传失败: ${error.message}` });
                }
            }
        });

        busboy.on('error', (err) => {
            log('BUSBOY_ERR', `Busboy 错误: ${err.message}`);
            req.unpipe(busboy);
            if (!res.headersSent) res.status(500).json({ success: false, message: '上传解析失败' });
        });

        req.pipe(busboy);

    } catch (err) {
        log('PRE_UPLOAD_ERR', err.message);
        res.status(400).json({ success: false, message: `请求失败: ${err.message}` });
    }
});

app.post('/api/text-file', requireLogin, async (req, res) => {
    const { mode, fileId, folderId, fileName, content } = req.body;
    const userId = req.session.userId;
    const storage = storageManager.getStorage();

    if (!fileName) return res.status(400).json({ success: false, message: '档名无效' });

    // --- 确保 tempFilePath 作用域在 finally 块中可见 ---
    let tempFilePath = null; 

    try {
        // 配额检查
        const byteLength = Buffer.byteLength(content, 'utf8');
        // 如果是编辑现有文件，我们应该先扣除旧文件大小（这里简化为直接检查，如果空间极度紧张可能会导致无法保存）
        if (!await data.checkQuota(userId, byteLength)) {
            return res.status(413).json({ success: false, message: '空间不足，无法保存文件。' });
        }

        tempFilePath = path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.txt`);
        await fsp.writeFile(tempFilePath, content, 'utf8');
        
        if (mode === 'edit' && fileId) {
            const numericFileId = BigInt(fileId);
            const filesToUpdate = await data.getFilesByIds([numericFileId], userId);
            if (filesToUpdate.length === 0) return res.status(404).json({ success: false, message: '找不到原始档案' });
            const originalFile = filesToUpdate[0];

            if (fileName !== originalFile.fileName) {
                const conflict = await data.checkFullConflict(fileName, originalFile.folder_id, userId);
                if (conflict) return res.status(409).json({ success: false, message: '同名冲突' });
            }

            if (originalFile.storage_type === 'telegram') {
                const fileStream = fs.createReadStream(tempFilePath);
                const result = await storage.upload(fileStream, fileName, 'text/plain', userId, originalFile.folder_id);
                // 注意：这里使用 unifiedDelete 进行物理删除旧文件
                await data.unifiedDelete(originalFile.message_id, 'file', userId);
                return res.json({ success: true, fileId: result.fileId });
            } else {
                const newRelativePath = path.posix.join(path.posix.dirname(originalFile.file_id), fileName);
                const fileStream = fs.createReadStream(tempFilePath); 
                
                // --- 统一处理 local/webdav/s3 的物理操作，以支持重命名和内容更新 ---
                if (originalFile.storage_type === 'local') {
                    const newFullPath = path.join(__dirname, 'data', 'uploads', String(userId), newRelativePath);
                    await fsp.mkdir(path.dirname(newFullPath), { recursive: true });
                    
                    // 1. 复制内容到新文件
                    await fsp.copyFile(tempFilePath, newFullPath); 
                    
                    // 2. 如果文件名或路径改变，删除旧文件
                    if (originalFile.file_id !== newRelativePath && fs.existsSync(path.join(__dirname, 'data', 'uploads', String(userId), originalFile.file_id))) {
                         await fsp.unlink(path.join(__dirname, 'data', 'uploads', String(userId), originalFile.file_id));
                    }
                } else if (originalFile.storage_type === 'webdav') {
                    const client = storage.getClient();
                    // WebDAV 的 putFileContents 可以接受流并执行写入/覆盖
                    await client.putFileContents(newRelativePath, fileStream, { overwrite: true });
                    
                    // 如果文件名改变，删除旧文件
                    if (originalFile.file_id !== newRelativePath) {
                        await client.deleteFile(originalFile.file_id);
                    }
                } else if (originalFile.storage_type === 's3') {
                    // S3 的上传逻辑（相当于覆盖或移动+删除旧Key）
                    const s3Storage = require('./storage/s3');
                    const s3Client = s3Storage.getClient();
                    const s3Config = storageManager.readConfig().s3;

                    const uploadParams = {
                        Bucket: s3Config.bucket,
                        Key: newRelativePath,
                        Body: fs.createReadStream(tempFilePath),
                        ContentType: 'text/plain',
                    };
                    await s3Client.upload(uploadParams).promise();

                    // 如果文件名改变，删除旧 Key
                    if (originalFile.file_id !== newRelativePath) {
                        await s3Client.deleteObject({ Bucket: s3Config.bucket, Key: originalFile.file_id }).promise();
                    }
                }
                // --- 统一处理结束 ---
                
                const stats = await fsp.stat(tempFilePath);
                await data.updateFile(numericFileId, { fileName, size: stats.size, date: Date.now(), file_id: newRelativePath }, userId);
                return res.json({ success: true, fileId: fileId });
            }
        } else if (mode === 'create' && folderId) {
            const conflict = await data.checkFullConflict(fileName, folderId, userId);
            if (conflict) return res.status(409).json({ success: false, message: '同名冲突' });
            
            // 使用文件流进行上传，以便适应各种存储后端
            const fileStream = fs.createReadStream(tempFilePath);
            const result = await storage.upload(fileStream, fileName, 'text/plain', userId, folderId);
            res.json({ success: true, fileId: result.fileId });
        } else {
            return res.status(400).json({ success: false, message: '参数无效' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '错误: ' + error.message });
    } finally {
        if (tempFilePath && fs.existsSync(tempFilePath)) {
            await fsp.unlink(tempFilePath).catch(() => {});
        }
    }
});

app.get('/api/file-info/:id', requireLogin, async (req, res) => {
    try {
        const fileId = BigInt(req.params.id);
        const [fileInfo] = await data.getFilesByIds([fileId], req.session.userId);
        if (fileInfo) {
            res.json(fileInfo);
        } else {
            res.status(404).json({ success: false, message: '找不到档案资讯' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '获取档案资讯失败' });
    }
});

app.post('/api/check-existence', requireLogin, async (req, res) => {
    try {
        const { files: filesToCheck, folderId: initialFolderId } = req.body;
        const userId = req.session.userId;

        if (!filesToCheck || !Array.isArray(filesToCheck) || !initialFolderId) {
            return res.status(400).json({ success: false, message: '无效的请求参数。' });
        }

        const existenceChecks = await Promise.all(
            filesToCheck.map(async (fileInfo) => {
                const { relativePath } = fileInfo;
                const pathParts = (relativePath || '').split('/');
                const fileName = pathParts.pop() || relativePath;
                const folderPathParts = pathParts;
                const targetFolderId = await data.findFolderByPath(initialFolderId, folderPathParts, userId);
                if (targetFolderId === null) {
                    return { name: fileName, relativePath, exists: false, messageId: null };
                }
                const existingFile = await data.findFileInFolder(fileName, targetFolderId, userId);
                return { name: fileName, relativePath, exists: !!existingFile, messageId: existingFile ? existingFile.message_id : null };
            })
        );
        res.json({ success: true, files: existenceChecks });
    } catch (error) {
        res.status(500).json({ success: false, message: "检查档案是否存在时发生内部错误。" });
    }
});

app.post('/api/check-move-conflict', requireLogin, async (req, res) => {
    try {
        const { itemIds, targetFolderId } = req.body;
        const userId = req.session.userId;
        if (!itemIds || !Array.isArray(itemIds) || !targetFolderId) {
            return res.status(400).json({ success: false, message: '无效的请求参数。' });
        }
        
        const topLevelItems = await data.getItemsByIds(itemIds, userId);
        const { fileConflicts, folderConflicts } = await data.getConflictingItems(topLevelItems, targetFolderId, userId);
        res.json({ success: true, fileConflicts, folderConflicts });
    } catch (error) {
        res.status(500).json({ success: false, message: '检查名称冲突时出错: ' + error.message });
    }
});

app.get('/api/search', requireLogin, async (req, res) => {
    try {
        const query = req.query.q;
        if (!query) return res.status(400).json({ success: false, message: '需要提供搜寻关键字。' });
        const contents = await data.searchItems(query, req.session.userId);
        const path = [{ id: null, name: `搜寻结果: "${query}"` }];
        res.json({ contents, path });
    } catch (error) {
        res.status(500).json({ success: false, message: '搜寻失败。' });
    }
});

app.get('/api/folder/:encryptedId', requireLogin, async (req, res) => {
    try {
        const folderIdStr = decrypt(req.params.encryptedId);
        if (!folderIdStr) {
            return res.status(400).json({ success: false, message: '无效的资料夹 ID' });
        }
        const folderId = parseInt(folderIdStr, 10);
        const userId = req.session.userId;
        const folderDetails = await data.getFolderDetails(folderId, userId);
        if (!folderDetails) {
            return res.status(404).json({ success: false, message: '找不到资料夹' });
        }
        if (folderDetails.is_locked && !req.session.unlockedFolders.includes(folderId)) {
            const folderPath = await data.getFolderPath(folderId, userId);
            return res.json({ locked: true, path: folderPath.map(p => ({ ...p, encrypted_id: encrypt(p.id) })) });
        }
        const contents = await data.getFolderContents(folderId, userId);
        const path = await data.getFolderPath(folderId, userId);
        res.json({ contents, path: path.map(p => ({ ...p, encrypted_id: encrypt(p.id) })) });
    } catch (error) {
        res.status(500).json({ success: false, message: '读取资料夹内容失败。' });
    }
});

app.post('/api/folder', requireLogin, async (req, res) => {
    const { name, parentId } = req.body;
    const userId = req.session.userId;
    if (!name || !parentId) {
        return res.status(400).json({ success: false, message: '缺少资料夹名称或父 ID。' });
    }
    try {
        const conflict = await data.checkFullConflict(name, parentId, userId);
        if (conflict) {
            return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
        }
        const result = await data.createFolder(name, parentId, userId);
        const storage = storageManager.getStorage();
        if (storage.type === 'local' || storage.type === 'webdav' || storage.type === 's3') {
            const newFolderPathParts = await data.getFolderPath(result.id, userId);
            const newFullPath = path.posix.join(...newFolderPathParts.slice(1).map(p => p.name));
            if (storage.type === 'local') {
                const newLocalPath = path.join(__dirname, 'data', 'uploads', String(userId), newFullPath);
                await fsp.mkdir(newLocalPath, { recursive: true });
            } else if (storage.type === 'webdav' && storage.createDirectory) {
                await storage.createDirectory(newFullPath);
            } else if (storage.type === 's3') {
                // S3 不需要预创建目录，但我们仍然需要确保 Key 路径正确
                const s3Storage = require('./storage/s3');
                const s3Client = s3Storage.getClient();
                const s3Config = storageManager.readConfig().s3;
                const key = path.posix.join(`user_${userId}`, newFullPath, '/').replace(/\\/g, '/').replace(/^\//, '');

                await s3Client.putObject({
                    Bucket: s3Config.bucket,
                    Key: key,
                    Body: '',
                }).promise();
            }
        }
        res.json(result);
    } catch (error) {
         res.status(500).json({ success: false, message: error.message || '处理资料夹时发生错误。' });
    }
});

app.post('/api/folder/:id/lock', requireLogin, async (req, res) => {
    try {
        const { id } = req.params;
        const { password, oldPassword } = req.body;
        const userId = req.session.userId;
        if (!password || password.length < 4) {
            return res.status(400).json({ success: false, message: '密码长度至少需要 4 个字元。' });
        }
        const folder = await data.getFolderDetails(id, userId);
        if (!folder) {
            return res.status(404).json({ success: false, message: '找不到资料夹。' });
        }
        if (folder.is_locked) {
            if (!oldPassword) {
                return res.status(400).json({ success: false, message: '需要提供旧密码才能修改。' });
            }
            const isMatch = await bcrypt.compare(oldPassword, folder.password);
            if (!isMatch) {
                return res.status(401).json({ success: false, message: '旧密码不正确。' });
            }
        }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        await data.setFolderPassword(id, hashedPassword, userId);
        res.json({ success: true, message: '资料夾密码已设定/更新。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '操作失败：' + error.message });
    }
});

app.post('/api/folder/:id/unlock', requireLogin, async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;
        const userId = req.session.userId;
        if (!password) {
            return res.status(400).json({ success: false, message: '需要提供密码才能解锁。' });
        }
        const isMatch = await data.verifyFolderPassword(id, password, userId);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: '密码不正确。' });
        }
        await data.setFolderPassword(id, null, userId);
        if (req.session.unlockedFolders) {
            req.session.unlockedFolders = req.session.unlockedFolders.filter(folderId => folderId !== parseInt(id));
        }
        res.json({ success: true, message: '资料夹已成功解锁（移除密码）。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '操作失败：' + error.message });
    }
});

app.post('/api/folder/:id/verify', requireLogin, async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;
        const userId = req.session.userId;
        const isMatch = await data.verifyFolderPassword(id, password, userId);
        if (isMatch) {
            if (!req.session.unlockedFolders) {
                req.session.unlockedFolders = [];
            }
            req.session.unlockedFolders.push(parseInt(id));
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, message: '密码错误' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '验证失败' });
    }
});

app.get('/api/folders', requireLogin, async (req, res) => {
    const folders = await data.getAllFolders(req.session.userId);
    res.json(folders);
});

app.post('/api/move', requireLogin, async (req, res) => {
    try {
        const { itemIds, targetFolderId, resolutions = {} } = req.body;
        const userId = req.session.userId;
        if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0 || !targetFolderId) {
            return res.status(400).json({ success: false, message: '无效的请求参数。' });
        }
        let totalMoved = 0, totalSkipped = 0;
        const errors = [];
        for (const itemId of itemIds) {
            try {
                const items = await data.getItemsByIds([itemId], userId);
                if (items.length === 0) {
                    totalSkipped++;
                    continue;
                }
                const item = items[0];
                
                const report = await data.moveItem(item.id, item.type, targetFolderId, userId, { resolutions });
                totalMoved += report.moved;
                totalSkipped += report.skipped;
                if (report.errors > 0) errors.push(`项目 "${item.name}" 处理失败。`);
            } catch (err) {
                errors.push(err.message);
            }
        }
        let message = "操作完成。";
        if (errors.length > 0) {
            message = `操作完成，但出现错误: ${errors.join(', ')}`;
        } else if (totalMoved > 0 && totalSkipped > 0) {
            message = `操作完成，${totalMoved} 个项目已移动，${totalSkipped} 个项目被跳过。`;
        } else if (totalMoved === 0 && totalSkipped > 0) {
            message = "所有选定项目均被跳过。";
        } else if (totalMoved > 0) {
            message = `${totalMoved} 个项目移动成功。`;
        }
        res.json({ success: errors.length === 0, message: message });
    } catch (error) {
        res.status(500).json({ success: false, message: '移动失败：' + error.message });
    }
});

// --- 修改：删除接口 (支持软删除和永久删除) ---
app.post('/delete-multiple', requireLogin, async (req, res) => {
    const { messageIds = [], folderIds = [], force = false } = req.body;
    const userId = req.session.userId;
    try {
        if (force) {
            // 永久删除
            const fileIdBigInts = messageIds.map(id => BigInt(id));
            const folderIdInts = folderIds.map(id => parseInt(id, 10));
            
            await data.unifiedDelete(null, null, userId, fileIdBigInts, folderIdInts);
            res.json({ success: true, message: '已永久删除' });
        } else {
            // 软删除
            await data.softDeleteItems(messageIds, folderIds, userId);
            res.json({ success: true, message: '已移至回收站' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '删除失败: ' + error.message });
    }
});

// --- 新增：回收站相关路由 ---

app.get('/api/trash', requireLogin, async (req, res) => {
    try {
        const contents = await data.getTrashContents(req.session.userId);
        res.json(contents);
    } catch (error) {
        res.status(500).json({ success: false, message: '无法获取回收站内容' });
    }
});

app.post('/api/restore', requireLogin, async (req, res) => {
    const { messageIds = [], folderIds = [] } = req.body;
    const userId = req.session.userId;
    try {
        await data.restoreItems(messageIds, folderIds, userId);
        res.json({ success: true, message: '项目已还原' });
    } catch (error) {
        res.status(500).json({ success: false, message: '还原失败: ' + error.message });
    }
});

app.post('/api/trash/empty', requireLogin, async (req, res) => {
    try {
        await data.cleanupTrash(0); // 0 天意味着清理所有回收站项目
        res.json({ success: true, message: '回收站已清空' });
    } catch (error) {
        res.status(500).json({ success: false, message: '清空失败: ' + error.message });
    }
});

// --- 新增：获取用户配额 ---
app.get('/api/user/quota', requireLogin, async (req, res) => {
    try {
        const quota = await data.getUserQuota(req.session.userId);
        res.json({ success: true, ...quota });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取配额失败' });
    }
});

app.post('/rename', requireLogin, async (req, res) => {
    try {
        const { id, newName, type } = req.body;
        const userId = req.session.userId;
        if (!id || !newName || !type) {
            return res.status(400).json({ success: false, message: '缺少必要参数。'});
        }
        let result;
        if (type === 'file') {
            result = await data.renameFile(BigInt(id), newName, userId);
        } else if (type === 'folder') {
            result = await data.renameFolder(parseInt(id, 10), newName, userId);
        } else {
            return res.status(400).json({ success: false, message: '无效的项目类型。'});
        }
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: '重命名失败: ' + error.message });
    }
});

app.get('/thumbnail/:message_id', requireLogin, async (req, res) => {
    try {
        const messageId = BigInt(req.params.message_id);
        const accessible = await data.isFileAccessible(messageId, req.session.userId, req.session.unlockedFolders);
        if (!accessible) {
            return res.status(403).send('权限不足');
        }
        const [fileInfo] = await data.getFilesByIds([messageId], req.session.userId);
        const storage = storageManager.getStorage();
        
        if (fileInfo && fileInfo.thumb_file_id && (fileInfo.storage_type === 'telegram' || fileInfo.storage_type === 's3')) {
            const link = await storage.getUrl(fileInfo.thumb_file_id, fileInfo.user_id);
            if (link) return res.redirect(link);
        }

        const placeholder = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': placeholder.length });
        res.end(placeholder);
    } catch (error) { res.status(500).send('获取缩图失败'); }
});

async function handleFileStream(req, res, fileInfo) {
    const storage = storageManager.getStorage();
    const range = req.headers.range;
    const totalSize = fileInfo.size;
    
    // 如果是 S3 或 local 存储，我们可以直接流式传输
    if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav' || fileInfo.storage_type === 's3') {
        try {
            res.setHeader('Accept-Ranges', 'bytes');
            res.setHeader('Content-Type', fileInfo.mimetype || 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);

            let options = {};
            
            if (range && totalSize) {
                const parts = range.replace(/bytes=/, "").split("-");
                const start = parseInt(parts[0], 10);
                const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
                
                if (start >= totalSize) {
                    res.status(416).send('Requested range not satisfiable\n' + start + ' >= ' + totalSize);
                    return;
                }
                
                const chunksize = (end - start) + 1;
                res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${totalSize}`, 'Content-Length': chunksize });
                options = { start, end };
            } else {
                res.setHeader('Content-Length', totalSize || -1);
            }

            const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id, options);
            stream.pipe(res);
            
            stream.on('error', (err) => {
                 console.error('File stream error:', err);
                 if (!res.headersSent) res.status(500).end('流读取失败');
            });
            
        } catch (error) {
            console.error('Error handling local/webdav/s3 stream:', error);
            if (!res.headersSent) res.status(500).send('无法获取文件流');
        }

    } else if (fileInfo.storage_type === 'telegram') {
        // Telegram 必须先获取 URL，然后通过 axios 代理或重定向
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', fileInfo.mimetype || 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);
        
        const link = await storage.getUrl(fileInfo.file_id);
        if (!link) {
            res.status(404).send('无法获取文件链接');
            return;
        }

        let headers = {};
        if (range) {
            headers['Range'] = range;
        }
        
        try {
            const response = await axios({ method: 'get', url: link, responseType: 'stream', headers: headers });

            if (range && totalSize) {
                 const parts = range.replace(/bytes=/, "").split("-");
                 const start = parseInt(parts[0], 10);
                 const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
                 const chunksize = (end - start) + 1;
                 res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${totalSize}`, 'Content-Length': chunksize });
            } else {
                 res.setHeader('Content-Length', totalSize || -1);
            }

            response.data.pipe(res);
            response.data.on('error', (err) => {
                 console.error('Telegram stream proxy error:', err);
                 if (!res.headersSent) res.status(500).end('下载流中断');
            });

        } catch (error) {
            if (error.response && error.response.status === 416) {
                res.status(416).send('Requested range not satisfiable');
            } else {
                if (!res.headersSent) res.status(500).send('下载代理失败');
            }
        }
    } else {
        res.status(500).send('不支持的存储类型');
    }
}

app.get('/download/proxy/:message_id', requireLogin, async (req, res) => {
    try {
        const messageId = BigInt(req.params.message_id);
        const accessible = await data.isFileAccessible(messageId, req.session.userId, req.session.unlockedFolders);
        if (!accessible) return res.status(403).send('权限不足');
        
        const [fileInfo] = await data.getFilesByIds([messageId], req.session.userId);
        if (!fileInfo) return res.status(404).send('文件信息未找到');

        await handleFileStream(req, res, fileInfo);
    } catch (error) {
        if (!res.headersSent) res.status(500).send('下载代理失败: ' + error.message);
    }
});

app.get('/file/content/:message_id', requireLogin, async (req, res) => {
    try {
        const messageId = BigInt(req.params.message_id);
        const accessible = await data.isFileAccessible(messageId, req.session.userId, req.session.unlockedFolders);
        if (!accessible) {
            return res.status(403).send('权限不足');
        }
        const [fileInfo] = await data.getFilesByIds([messageId], req.session.userId);
        if (!fileInfo || !fileInfo.file_id) {
            return res.status(404).send('文件信息未找到');
        }
        const storage = storageManager.getStorage();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        
        if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav' || fileInfo.storage_type === 's3') {
            const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id);
            stream.pipe(res);
            stream.on('error', (err) => {
                 console.error('Content stream error:', err);
                 if (!res.headersSent) res.status(500).end('无法读取文件内容');
            });
        } else if (fileInfo.storage_type === 'telegram') {
            const link = await storage.getUrl(fileInfo.file_id);
            if (link) {
                const response = await axios.get(link, { responseType: 'text' });
                res.send(response.data);
            } else { res.status(404).send('无法获取文件链接'); }
        } else {
             res.status(500).send('不支持的存储类型');
        }
    } catch (error) {
        res.status(500).send('无法获取文件内容');
    }
});

app.post('/api/download-archive', requireLogin, async (req, res) => {
    try {
        const { messageIds = [], folderIds = [] } = req.body;
        const userId = req.session.userId;
        const storage = storageManager.getStorage();
        if (messageIds.length === 0 && folderIds.length === 0) {
            return res.status(400).send('未提供任何项目 ID');
        }
        let filesToArchive = [];
        if (messageIds.length > 0) {
            const fileIdBigInts = messageIds.map(id => BigInt(id));
            const directFiles = await data.getFilesByIds(fileIdBigInts, userId);
            filesToArchive.push(...directFiles.map(f => ({ ...f, path: f.fileName })));
        }
        for (const folderId of folderIds) {
            const folderInfo = (await data.getFolderPath(folderId, userId)).pop();
            const folderName = folderInfo ? folderInfo.name : 'folder';
            const nestedFiles = await data.getFilesRecursive(folderId, userId, folderName);
            filesToArchive.push(...nestedFiles);
        }
        if (filesToArchive.length === 0) {
            return res.status(404).send('找不到任何可下载的档案');
        }
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        res.attachment('download.zip');

        archive.on('error', function(err) {
            console.error('Archiver error:', err);
            if (!res.headersSent) {
                res.status(500).send({ error: `压缩失败: ${err.message}` });
            } else {
                res.end();
            }
        });

        res.on('close', function() {
            archive.abort();
            archive.finalize();
        });

        archive.pipe(res);

        const CONCURRENCY_LIMIT = 10;
        const tasks = [...filesToArchive];
        let activeTasks = 0;
        const errors = [];

        const processFile = async (file) => {
            try {
                if (file.storage_type === 'local' || file.storage_type === 'webdav' || file.storage_type === 's3') {
                    const stream = await storage.stream(file.file_id, userId);
                    await new Promise((resolve, reject) => {
                        stream.on('end', resolve);
                        stream.on('error', (err) => reject(new Error(`(Storage Stream) ${err.message}`)));
                        archive.append(stream, { name: file.path });
                    });

                } else if (file.storage_type === 'telegram') {
                    const link = await storage.getUrl(file.file_id);
                    if (link) {
                        const response = await axios({ url: link, method: 'GET', responseType: 'stream' });
                        await new Promise((resolve, reject) => {
                            response.data.on('end', resolve);
                            response.data.on('error', (err) => reject(new Error(`(Telegram Stream) ${err.message}`)));
                            archive.append(response.data, { name: file.path });
                        });
                    } else {
                         throw new Error(`无法获取档案 ${file.path} 的下载连结。`);
                    }
                }
            } catch (err) {
                console.error(`[Archiver] 无法附加档案 "${file.path}": ${err.message}`);
                errors.push(err.message);
                archive.append(`错误：无法附加档案 "${file.path}"。\n错误讯息: ${err.message}`, { name: `${file.path} (错误).txt` });
            }
        };

        await new Promise((resolveAll) => {
            const runTask = () => {
                if (tasks.length === 0 && activeTasks === 0) {
                    return resolveAll();
                }
                while (activeTasks < CONCURRENCY_LIMIT && tasks.length > 0) {
                    activeTasks++;
                    const file = tasks.shift(); 

                    processFile(file)
                        .catch(err => {
                            console.error("并发处理文件时发生未捕获的错误: ", err);
                        })
                        .finally(() => {
                            activeTasks--;
                            runTask();
                        });
                }
            };
            runTask(); 
        });
        
        await archive.finalize();
        
    } catch (error) {
        console.error('压缩档案时发生严重错误:', error);
        if (!res.headersSent) {
            res.status(500).send('压缩档案时发生错误: ' + error.message);
        }
    }
});

app.post('/share', requireLogin, async (req, res) => {
    try {
        const { itemId, itemType, expiresIn, password, customExpiresAt } = req.body;
        if (!itemId || !itemType || !expiresIn) {
            return res.status(400).json({ success: false, message: '缺少必要参数。' });
        }
        if (expiresIn === 'custom') {
            const customTimestamp = parseInt(customExpiresAt, 10);
            if (isNaN(customTimestamp) || customTimestamp <= Date.now()) {
                return res.status(400).json({ success: false, message: '无效的自订到期时间。' });
            }
        }
        
        const idToShare = itemType === 'file' ? BigInt(itemId) : parseInt(itemId, 10);
        
        const result = await data.createShareLink(idToShare, itemType, expiresIn, req.session.userId, password, customExpiresAt);
        if (result.success) {
            const shareUrl = `${req.protocol}://${req.get('host')}/share/view/${itemType}/${result.token}`;
            res.json({ success: true, url: shareUrl });
        } else {
            res.status(404).json(result);
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '在伺服器上建立分享连结时发生错误。' });
    }
});

app.get('/api/shares', requireLogin, async (req, res) => {
    try {
        const shares = await data.getActiveShares(req.session.userId);
        const fullUrlShares = shares.map(item => ({
            ...item,
            share_url: `${req.protocol}://${req.get('host')}/share/view/${item.type}/${item.share_token}`
        }));
        res.json(fullUrlShares);
    } catch (error) { res.status(500).json({ success: false, message: '获取分享列表失败' }); }
});

app.post('/api/cancel-share', requireLogin, async (req, res) => {
    try {
        const { itemId, itemType } = req.body;
        if (!itemId || !itemType) return res.status(400).json({ success: false, message: '缺少必要参数' });
        
        const idToCancel = itemType === 'file' ? BigInt(itemId) : parseInt(itemId, 10);
        
        const result = await data.cancelShare(idToCancel, itemType, req.session.userId);
        res.json(result);
    } catch (error) { res.status(500).json({ success: false, message: '取消分享失败' }); }
});

app.get('/api/locate-item', requireLogin, async (req, res) => {
    try {
        const { id, type } = req.query;
        const userId = req.session.userId;

        if (!id || !type) {
            return res.status(400).json({ success: false, message: '缺少项目 ID 或类型' });
        }

        let folderId;
        if (type === 'folder') {
            const folder = await data.getFolderDetails(id, userId);
            if (!folder) {
                 return res.status(404).json({ success: false, message: '找不到资料夹' });
            }
            if (folder.parent_id === null) {
                folderId = folder.id;
            } else {
                folderId = folder.parent_id;
            }
        } else if (type === 'file') {
            const [file] = await data.getFilesByIds([BigInt(id)], userId);
            if (!file) {
                return res.status(404).json({ success: false, message: '找不到档案' });
            }
            folderId = file.folder_id;
        } else {
            return res.status(400).json({ success: false, message: '无效的项目类型' });
        }
        
        res.json({ success: true, encryptedFolderId: encrypt(folderId) });

    } catch (error) {
        res.status(500).json({ success: false, message: '定位失败：' + error.message });
    }
});

app.post('/api/user/change-password', requireLogin, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, message: '请提供旧密码和新密码，且新密码长度至少 4 个字符。' });
    }
    try {
        const user = await data.findUserById(req.session.userId);
        if (!user) {
            return res.status(404).json({ success: false, message: '找不到使用者。' });
        }
        const isMatch = await bcrypt.compare(oldPassword, user.password);
        if (!isMatch) {
            return res.status(401).json({ success: false, message: '旧密码不正确。' });
        }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        await data.changeUserPassword(req.session.userId, hashedPassword);
        res.json({ success: true, message: '密码修改成功。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '修改密码失败。' });
    }
});

app.get('/api/admin/storage-mode', requireAdmin, (req, res) => {
    const config = storageManager.readConfig();
    res.json({ 
        storageMode: config.storageMode,
        uploadMode: config.uploadMode || 'stream'
    });
});

app.post('/api/admin/storage-mode', requireAdmin, (req, res) => {
    const { mode } = req.body;
    if (storageManager.setStorageMode(mode)) {
        res.json({ success: true, message: '储存模式已设定。' });
    } else {
        res.status(400).json({ success: false, message: '无效的模式' });
    }
});

app.post('/api/admin/upload-mode', requireAdmin, (req, res) => {
    const { mode } = req.body;
    if (storageManager.setUploadMode(mode)) {
        res.json({ success: true, message: '上传模式已设定。' });
    } else {
        res.status(400).json({ success: false, message: '无效的上传模式' });
    }
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const users = await data.listNormalUsers();
        res.json(users);
    } catch (error) {
        res.status(500).json({ success: false, message: '获取使用者列表失败。' });
    }
});

app.get('/api/admin/all-users', requireAdmin, async (req, res) => {
    try {
        const users = await data.listAllUsers();
        res.json(users);
    } catch (error) {
        res.status(500).json({ success: false, message: '获取所有使用者列表失败。' });
    }
});

// --- 新增：获取所有使用者及其配额信息 (Admin) ---
app.get('/api/admin/users-with-quota', requireAdmin, async (req, res) => {
    try {
        const users = await data.listAllUsersWithQuota();
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, message: '获取使用者配额列表失败。' });
    }
});

// --- 新增：设定使用者配额 (Admin) ---
app.post('/api/admin/set-quota', requireAdmin, async (req, res) => {
    const { userId, maxBytes } = req.body;
    let maxBytesInt = parseInt(maxBytes, 10);
    const userIdInt = parseInt(userId, 10);

    // 检查是否为有效的数字
    if (isNaN(userIdInt) || isNaN(maxBytesInt) || maxBytesInt < 0) {
        // 如果传入的是 0 (表示无限)，则接受
        if (req.body.maxBytes === '0' || req.body.maxBytes === 0) {
             maxBytesInt = 0;
        } else {
             return res.status(400).json({ success: false, message: '无效的使用者 ID 或配额值。' });
        }
    }
    
    try {
        const result = await data.setMaxStorageForUser(userIdInt, maxBytesInt);
        if (result.changes === 0) {
            return res.status(404).json({ success: false, message: '找不到使用者或该使用者是管理员 (无法修改管理员配额)。' });
        }
        res.json({ success: true, message: '配额设定成功。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '设定配额失败: ' + error.message });
    }
});

app.post('/api/admin/add-user', requireAdmin, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password || password.length < 4) {
        return res.status(400).json({ success: false, message: '使用者名称和密码为必填项，且密码长度至少 4 个字符。' });
    }
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newUser = await data.createUser(username, hashedPassword);
        await data.createFolder('/', null, newUser.id);
        await fsp.mkdir(path.join(__dirname, 'data', 'uploads', String(newUser.id)), { recursive: true });
        res.json({ success: true, user: newUser });
    } catch (error) {
        res.status(500).json({ success: false, message: '建立使用者失败，可能使用者名称已被使用。' });
    }
});

app.post('/api/admin/change-password', requireAdmin, async (req, res) => {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, message: '使用者 ID 和新密码为必填项，且密码长度至少 4 个字符。' });
    }
    try {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        await data.changeUserPassword(userId, hashedPassword);
        res.json({ success: true, message: '密码修改成功。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '修改密码失败。' });
    }
});

app.post('/api/admin/delete-user', requireAdmin, async (req, res) => {
    const { userId } = req.body;
    if (!userId) {
        return res.status(400).json({ success: false, message: '缺少使用者 ID。' });
    }
    try {
        await data.deleteUser(userId);
        res.json({ success: true, message: '使用者已删除。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '删除使用者失败。' });
    }
});

app.get('/api/admin/webdav', requireAdmin, (req, res) => {
    const config = storageManager.readConfig();
    const webdavConfig = config.webdav || {};
    res.json(webdavConfig.url ? [{ id: 1, ...webdavConfig }] : []);
});

app.post('/api/admin/webdav', requireAdmin, (req, res) => {
    const { url, username, password } = req.body;
    if (!url || !username) {
        return res.status(400).json({ success: false, message: '缺少必要参数' });
    }
    const config = storageManager.readConfig();
    
    // 获取旧配置中的密码（如果存在）
    const oldPassword = (config.webdav && config.webdav.password) ? config.webdav.password : '';
    
    config.webdav = { 
        url, 
        username,
        // 如果前端传来了新密码则使用新密码，否则保留旧密码
        password: password ? password : oldPassword
    };
    
    if (storageManager.writeConfig(config)) {
        res.json({ success: true, message: 'WebDAV 设定已储存' });
    } else {
        res.status(500).json({ success: false, message: '写入设定失败' });
    }
});

app.delete('/api/admin/webdav/:id', requireAdmin, (req, res) => {
    const config = storageManager.readConfig();
    config.webdav = {};
    if (storageManager.writeConfig(config)) {
        res.json({ success: true, message: 'WebDAV 设定已删除' });
    } else {
        res.status(500).json({ success: false, message: '删除设定失败' });
    }
});

// --- 新增：S3 配置路由 (Admin) ---
app.get('/api/admin/s3', requireAdmin, (req, res) => {
    const config = storageManager.readConfig();
    const s3Config = config.s3 || {};
    // 隐藏秘密密钥，只返回其他配置
    const { secretAccessKey, ...safeConfig } = s3Config;
    res.json({ success: true, s3: safeConfig });
});

app.post('/api/admin/s3', requireAdmin, (req, res) => {
    const { endpoint, region, bucket, accessKeyId, secretAccessKey } = req.body;
    if (!region || !bucket || !accessKeyId) {
        return res.status(400).json({ success: false, message: '缺少必要的 S3 参数 (Region, Bucket, Access Key ID)' });
    }
    const config = storageManager.readConfig();
    
    // 保留旧配置中的秘密密钥（如果未提供新密码）
    const oldSecretKey = (config.s3 && config.s3.secretAccessKey) ? config.s3.secretAccessKey : '';
    
    config.s3 = {
        endpoint: endpoint || undefined,
        region,
        bucket,
        accessKeyId,
        // 如果提供了新密钥，则使用新密钥，否则保留旧密钥
        secretAccessKey: secretAccessKey || oldSecretKey 
    };
    
    if (storageManager.writeConfig(config)) {
        res.json({ success: true, message: 'S3 存储配置已储存' });
    } else {
        res.status(500).json({ success: false, message: '写入配置失败' });
    }
});
// --- 新增 S3 配置路由结束 ---


app.get('/share/auth/:itemType/:token', shareSession, (req, res) => {
    const { itemType, token } = req.params;
    res.render('share-password', { itemType, token, error: req.query.error || null });
});

app.post('/share/auth/:itemType/:token', shareSession, async (req, res) => {
    const { itemType, token } = req.params;
    const { password } = req.body;
    try {
        let item;
        if (itemType === 'file') item = await data.getFileByShareToken(token);
        else item = await data.getFolderByShareToken(token);
        if (!item) return res.redirect(`/share/auth/${itemType}/${token}?error=链接无效`);
        const isMatch = await bcrypt.compare(password, item.share_password);
        if (isMatch) {
            if (!req.session.unlockedShares) req.session.unlockedShares = {};
            req.session.unlockedShares[token] = true;
            res.redirect(`/share/view/${itemType}/${token}`);
        } else {
            res.redirect(`/share/auth/${itemType}/${token}?error=密码错误`);
        }
    } catch (error) {
        res.redirect(`/share/auth/${itemType}/${token}?error=验证时发生错误`);
    }
});

app.get('/share/view/file/:token', shareSession, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        
        const token = req.params.token;
        const fileInfo = await data.getFileByShareToken(token);
        if (fileInfo) {
            if (fileInfo.share_password && (!req.session.unlockedShares || !req.session.unlockedShares[token])) {
                return res.redirect(`/share/auth/file/${token}`);
            }
            const downloadUrl = `/share/download/file/${token}`;
            let textContent = null;
            if (fileInfo.mimetype && fileInfo.mimetype.startsWith('text/')) {
                const storage = storageManager.getStorage();
                if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav' || fileInfo.storage_type === 's3') {
                    // 使用 stream，并等待其结束以获取完整内容
                    const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id);
                     textContent = await new Promise((resolve, reject) => {
                        let data = '';
                        stream.on('data', chunk => data += chunk);
                        stream.on('end', () => resolve(data));
                        stream.on('error', err => reject(err));
                        // 确保流不会被卡住
                        stream.on('close', () => resolve(data));
                    });
                } else if (fileInfo.storage_type === 'telegram') {
                    const link = await storage.getUrl(fileInfo.file_id);
                    if (link) {
                        const response = await axios.get(link, { responseType: 'text' });
                        textContent = response.data;
                    }
                }
            }
            if (textContent !== null) {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.send(textContent);
            } else {
                res.render('share-view', { file: fileInfo, downloadUrl, textContent: null });
            }
        } else {
            res.status(404).render('share-error', { message: '此分享连结无效或已过期。' });
        }
    } catch (error) { res.status(500).render('share-error', { message: '处理分享请求时发生错误。' }); }
});

app.get('/share/view/folder/:token/:path(*)?', shareSession, async (req, res) => {
    try {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');

        const { token, path: requestedPath } = req.params;
        const pathSegments = requestedPath ? requestedPath.split('/').filter(p => p) : [];
        const rootFolder = await data.getFolderByShareToken(token);
        if (rootFolder) {
            if (rootFolder.share_password && (!req.session.unlockedShares || !req.session.unlockedShares[token])) {
                 return res.redirect(`/share/auth/folder/${token}`);
            }
            const folderInfo = await data.findFolderBySharePath(token, pathSegments);
            if (folderInfo) {
                const contents = await data.getFolderContents(folderInfo.id, folderInfo.user_id);
                const breadcrumbPath = await data.getFolderPath(folderInfo.id, folderInfo.user_id);
                const rootPathIndex = breadcrumbPath.findIndex(p => p.id === rootFolder.id);
                const shareBreadcrumb = breadcrumbPath.slice(rootPathIndex).map((p, index, arr) => {
                    const relativePath = arr.slice(1, index + 1).map(s => s.name).join('/');
                    return { name: p.name, link: index < arr.length - 1 ? `/share/view/folder/${token}/${relativePath}` : null };
                });
                res.render('share-folder-view', { folder: folderInfo, contents, breadcrumb: shareBreadcrumb, token: token });
            } else {
                 res.status(404).render('share-error', { message: '路径不正确。' });
            }
        } else {
            res.status(404).render('share-error', { message: '此分享连结无效或已过期。' });
        }
    } catch (error) {
        res.status(500).render('share-error', { message: '处理分享请求时发生错误。' });
    }
});

app.get('/share/download/file/:token', shareSession, async (req, res) => {
    try {
        const token = req.params.token;
        const fileInfo = await data.getFileByShareToken(token);
        if (!fileInfo) {
             return res.status(404).send('文件信息未找到或分享链接已过期');
        }
        if (fileInfo.share_password && (!req.session.unlockedShares || !req.session.unlockedShares[token])) {
            return res.status(403).send('需要密码才能下载');
        }
        await handleFileStream(req, res, fileInfo);
    } catch (error) { 
        if (!res.headersSent) res.status(500).send('下载失败: ' + error.message);
    }
});

app.get('/share/thumbnail/:folderToken/:fileId', shareSession, async (req, res) => {
    try {
        const { folderToken, fileId } = req.params;
        const rootFolder = await data.getFolderByShareToken(folderToken);
        if (!rootFolder || (rootFolder.share_password && (!req.session.unlockedShares || !req.session.unlockedShares[folderToken]))) {
            return res.status(403).send('权限不足');
        }
        const fileInfo = await data.findFileInSharedFolder(BigInt(fileId), folderToken);
        const storage = storageManager.getStorage();
        
        if (fileInfo && fileInfo.thumb_file_id && (fileInfo.storage_type === 'telegram' || fileInfo.storage_type === 's3')) {
            const link = await storage.getUrl(fileInfo.thumb_file_id, fileInfo.user_id);
            if (link) return res.redirect(link);
        }

        const placeholder = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': placeholder.length });
        res.end(placeholder);
    } catch (error) {
        res.status(500).send('获取缩图失败');
    }
});

app.get('/share/download/:folderToken/:fileId', shareSession, async (req, res) => {
    try {
        const { folderToken, fileId } = req.params;
        const rootFolder = await data.getFolderByShareToken(folderToken);
        if (!rootFolder) {
            return res.status(404).send('分享链接无效或已过期');
        }
        if (rootFolder.share_password && (!req.session.unlockedShares || !req.session.unlockedShares[folderToken])) {
            return res.status(403).send('需要密码才能下载');
        }
        const fileInfo = await data.findFileInSharedFolder(BigInt(fileId), folderToken);
        if (!fileInfo) {
             return res.status(404).send('文件信息未找到或权限不足');
        }
        await handleFileStream(req, res, fileInfo);
    } catch (error) {
        if (!res.headersSent) res.status(500).send('下载失败: ' + error.message);
    }
});

app.listen(PORT, () => {
    console.log(`✅ 伺服器已在 http://localhost:${PORT} 上运行`);
});
