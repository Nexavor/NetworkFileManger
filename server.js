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
const cron = require('node-cron'); // 新增：定时任务
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

// --- Cron Job: 每天自动清理 30 天前的回收站文件 ---
cron.schedule('0 0 * * *', async () => {
    console.log('[Cron] 开始运行回收站自动清理...');
    try {
        const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
        
        // 1. 查找并永久删除过期的文件
        // 注意：这需要直接操作数据库获取过期文件， data.js 中没有直接暴露 "getExpiredDeletedFiles"
        // 我们在这里简单实现查询逻辑，然后调用 permanentDelete
        // 为了安全，我们假设 permanentDelete 处理物理删除
        
        // 查询过期文件
        const sqlExpiredFiles = `SELECT message_id, user_id, storage_type, file_id FROM files WHERE is_deleted = 1 AND deleted_at < ?`;
        const expiredFiles = await new Promise((resolve, reject) => {
            // 此时无法直接访问 db 实例，除非我们导出了它。
            // database.js 导出了 db 实例 (如果需要)。
            const dbInstance = require('./database.js');
            dbInstance.all(sqlExpiredFiles, [thirtyDaysAgo], (err, rows) => {
                if (err) resolve([]); else resolve(rows || []);
            });
        });

        console.log(`[Cron] 发现 ${expiredFiles.length} 个过期文件需要清理。`);

        for (const file of expiredFiles) {
            try {
                await data.permanentDelete(BigInt(file.message_id), 'file', file.user_id);
            } catch (err) {
                console.error(`[Cron] 清理文件 ${file.message_id} 失败:`, err.message);
            }
        }

        // 2. 清理过期的空文件夹记录
        // 文件夹的物理删除比较复杂，因为可能是空的也可能包含已删除的文件。
        // 如果我们仅仅从数据库中删除记录，不影响存储（因为文件夹只是逻辑概念或已空）。
        const dbInstance = require('./database.js');
        const folderSql = `DELETE FROM folders WHERE is_deleted = 1 AND deleted_at < ?`;
        await new Promise((resolve) => {
            dbInstance.run(folderSql, [thirtyDaysAgo], function(err) {
                if(!err) console.log(`[Cron] 清理了 ${this.changes} 个过期文件夹记录。`);
                resolve();
            });
        });
        
        console.log('[Cron] 回收站清理完成。');

    } catch (error) {
        console.error('[Cron] 回收站清理失败:', error);
    }
});


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
                
                // 滚动 Token 机制
                await data.deleteAuthToken(rememberToken);
                const newRememberToken = crypto.randomBytes(64).toString('hex');
                const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
                await data.createAuthToken(user.id, newRememberToken, expiresAt);
                
                res.cookie('remember_me', newRememberToken, {
                    path: '/',
                    httpOnly: true,
                    secure: req.protocol === 'https',
                    maxAge: 30 * 24 * 60 * 60 * 1000 
                });
            } else if (tokenData) {
                await data.deleteAuthToken(rememberToken);
                res.clearCookie('remember_me', { path: '/' });
            } else {
                res.clearCookie('remember_me', { path: '/' });
            }
        } catch (err) {
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
app.get('/recycle-bin', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/recycle-bin.html'))); // 新增：回收站页面

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
    // 改用 getRootFolder 而不是直接查 SQL，保持一致性
    data.getRootFolder(req.session.userId)
        .then(rootFolder => {
            if (!rootFolder) {
                // 如果没有根目录，尝试创建一个
                return data.createFolder('/', null, req.session.userId)
                    .then(newRoot => res.redirect(`/view/${encrypt(newRoot.id)}`));
            }
            res.redirect(`/view/${encrypt(rootFolder.id)}`);
        })
        .catch(err => {
             console.error(err);
             res.status(500).send("找不到您的根目录，也无法建立。");
        });
});

app.get('/view/:encryptedId', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/manager.html')));
app.get('/shares-page', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/shares.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin.html')));
app.get('/scan', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/scan.html')));

// --- Upload (Modified for Quota Check) ---
app.post('/upload', requireLogin, (req, res) => {
    const { folderId, resolutions: resolutionsJSON, caption } = req.query;
    const userId = req.session.userId;
    const storage = storageManager.getStorage();
    const config = storageManager.readConfig();
    const uploadMode = config.uploadMode || 'stream'; 
    const MAX_FILENAME_BYTES = 255; 

    // 1. 预先检查配额 (基于 Content-Length)
    const totalUploadSize = parseInt(req.headers['content-length'] || '0');
    data.checkQuota(userId, totalUploadSize).then(isAllowed => {
        if (!isAllowed) {
            return res.status(400).json({ success: false, message: '您的存储配额已满，无法上传更多文件。' });
        }

        // 2. 执行原有上传逻辑
        try {
            if (!folderId) throw new Error('缺少 folderId');
            const initialFolderId = parseInt(folderId, 10);
            if (isNaN(initialFolderId)) throw new Error('无效的 folderId');
            
            const resolutions = JSON.parse(resolutionsJSON || '{}');
            
            const busboy = Busboy({ headers: req.headers });
            const uploadPromises = [];

            busboy.on('file', (fieldname, fileStream, fileInfo) => {
                const relativePath = Buffer.from(fieldname, 'latin1').toString('utf8');
                
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
                        const tempFileName = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}-${path.basename(finalFilename)}`;
                        const tempFilePath = path.join(TMP_DIR, tempFileName);

                        try {
                            const writeStream = fs.createWriteStream(tempFilePath);
                            await new Promise((resolve, reject) => {
                                fileStream.pipe(writeStream);
                                fileStream.on('error', err => reject(err));
                                writeStream.on('error', err => reject(err));
                                writeStream.on('finish', () => { resolve(); });
                            });

                            const stats = await fsp.stat(tempFilePath);
                            if (stats.size === 0) {
                                 throw new Error("接收到的文件大小为 0 字节，上传中止。");
                            }

                            // --- 二次配额检查 (精确大小) ---
                            if (!(await data.checkQuota(userId, stats.size))) {
                                throw new Error('存储配额不足');
                            }

                            let uploadData;
                            if (stats.size < 50 * 1024 * 1024) { 
                                uploadData = await fsp.readFile(tempFilePath);
                            } else {
                                uploadData = fs.createReadStream(tempFilePath);
                            }

                            await storage.upload(uploadData, finalFilename, mimeType, userId, targetFolderId, caption || '', existingItem);

                        } finally {
                            if (fs.existsSync(tempFilePath)) {
                                await fsp.unlink(tempFilePath).catch(e => {});
                            }
                        }
                    } else {
                        // --- 流式模式 ---
                        // 流式模式无法在接收前精确检查单个文件大小，依赖 headers 检查
                        await storage.upload(fileStream, finalFilename, mimeType, userId, targetFolderId, caption || '', existingItem);
                    }

                    return { skipped: false };
                })().catch(err => {
                    fileStream.resume(); 
                    return { success: false, error: err };
                });
                
                uploadPromises.push(fileUploadPromise);
            });

            // --- 关键修正：确保 busboy finish 的异步逻辑被捕获 ---
            busboy.on('finish', () => {
                (async () => {
                    const results = await Promise.all(uploadPromises);
                    const errors = results.filter(r => r && r.error);
                    if (errors.length > 0) {
                         throw errors[0].error;
                    }
                    const allSkipped = results.length > 0 && results.every(r => r.skipped);
                    if (allSkipped) {
                         res.json({ success: true, skippedAll: true, message: '所有文件都因冲突而被跳过' });
                    } else {
                         res.json({ success: true, message: '上传完成' });
                    }
                })().catch(error => {
                    // 确保只在未发送响应时发送 500 错误，并记录日志以供调试
                    if (!res.headersSent) {
                        console.error("Busboy Finish Error (Preventing Crash):", error); 
                        res.status(500).json({ success: false, message: `上传失败: ${error.message}` });
                    }
                });
            });

            busboy.on('error', (err) => {
                req.unpipe(busboy);
                if (!res.headersSent) res.status(500).json({ success: false, message: '上传解析失败' });
            });

            req.pipe(busboy);

        } catch (err) {
            if (!res.headersSent) res.status(400).json({ success: false, message: `请求失败: ${err.message}` });
        }
    }).catch(err => {
        res.status(500).json({ success: false, message: '服务器错误: ' + err.message });
    });
});

// --- User Quota Endpoint ---
app.get('/api/user/quota', requireLogin, async (req, res) => {
    try {
        const user = await data.findUserById(req.session.userId);
        // 使用 db 实例直接查询，或者在 data.js 中添加 getUsedStorage 函数
        // 为了简洁，这里直接在 server.js 中使用 data.js 的 query 逻辑
        // 更好的做法是在 data.js 增加方法，但考虑到 data.js 未导出 db，我们用 user 对象的 max_storage_bytes
        // 并查询 sum。
        
        // 由于 db 未导出，我们在 data.js 中已更新 listNormalUsers 包含 used_storage
        // 我们可以加一个 data.getUserQuota(userId)
        // 或者直接用 SQL，因为 database.js 导出了 db (如果需要)
        // 这里的 `require('./database.js')` 会返回 db 实例 (单例)
        const dbInstance = require('./database.js');
        
        const usedRes = await new Promise((resolve, reject) => {
            dbInstance.get(`SELECT COALESCE(SUM(size), 0) as used FROM files WHERE user_id = ? AND is_deleted = 0`, [req.session.userId], (err, row) => {
                if (err) reject(err); else resolve(row);
            });
        });
        
        res.json({
            max: user.max_storage_bytes,
            used: usedRes ? usedRes.used : 0
        });
    } catch (e) { 
        res.status(500).json({error: e.message}); 
    }
});

// --- Copy Endpoint ---
app.post('/api/copy', requireLogin, async (req, res) => {
    const { itemIds, targetFolderId } = req.body;
    const userId = req.session.userId;
    try {
        let totalCopied = 0;
        for (const itemId of itemIds) {
            const items = await data.getItemsByIds([itemId], userId);
            if (items.length > 0) {
                const item = items[0];
                const idParam = item.type === 'folder' ? item.id : BigInt(item.id);
                const result = await data.copyItem(idParam, item.type, targetFolderId, userId);
                totalCopied += result.copied;
            }
        }
        res.json({ success: true, message: `成功复制 ${totalCopied} 个项目` });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- Recycle Bin Endpoints ---
app.get('/api/recycle-bin', requireLogin, async (req, res) => {
    try {
        const contents = await data.getRecycleBinContents(req.session.userId);
        res.json(contents);
    } catch(e) { 
        res.status(500).json({success: false, message: e.message}); 
    }
});

app.post('/api/restore', requireLogin, async (req, res) => {
    const { itemIds } = req.body; // [{id, type}, ...]
    const userId = req.session.userId;
    try {
        for (const item of itemIds) {
            await data.restoreItem(item.type === 'file' ? BigInt(item.id) : item.id, item.type, userId);
        }
        res.json({ success: true });
    } catch(e) { 
        res.status(500).json({success:false, message:e.message}); 
    }
});

app.post('/api/permanent-delete', requireLogin, async (req, res) => {
    const { itemIds } = req.body;
    const userId = req.session.userId;
    try {
        for (const item of itemIds) {
            await data.permanentDelete(item.type === 'file' ? BigInt(item.id) : item.id, item.type, userId);
        }
        res.json({ success: true });
    } catch(e) { 
        res.status(500).json({success:false, message:e.message}); 
    }
});

app.post('/api/empty-recycle-bin', requireLogin, async (req, res) => {
    try {
        await data.emptyRecycleBin(req.session.userId);
        res.json({ success: true });
    } catch(e) { 
        res.status(500).json({success:false, message:e.message}); 
    }
});

// --- S3 Admin Config ---
app.post('/api/admin/s3', requireAdmin, (req, res) => {
    const config = storageManager.readConfig();
    config.s3 = req.body;
    if(storageManager.writeConfig(config)) res.json({success:true, message: 'S3 设定已储存'}); 
    else res.status(500).json({success:false, message: '写入失败'});
});

app.get('/api/admin/s3', requireAdmin, (req, res) => {
    const config = storageManager.readConfig();
    res.json(config.s3 || {});
});


// --- 原有的 API 路由 (保持不变) ---
app.post('/api/text-file', requireLogin, async (req, res) => {
    const { mode, fileId, folderId, fileName, content } = req.body;
    const userId = req.session.userId;
    const storage = storageManager.getStorage();

    if (!fileName) return res.status(400).json({ success: false, message: '档名无效' });
    const tempFilePath = path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.txt`);

    try {
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
                await data.unifiedDelete(originalFile.message_id, 'file', userId); // 旧文件移入回收站或删除
                return res.json({ success: true, fileId: result.fileId });
            } else {
                const newRelativePath = path.posix.join(path.posix.dirname(originalFile.file_id), fileName);
                const fileStream = fs.createReadStream(tempFilePath); 
                
                if (originalFile.storage_type === 'local') {
                    const newFullPath = path.join(__dirname, 'data', 'uploads', String(userId), newRelativePath);
                    await fsp.mkdir(path.dirname(newFullPath), { recursive: true });
                    await fsp.copyFile(tempFilePath, newFullPath); 
                    if (originalFile.file_id !== newRelativePath && fs.existsSync(path.join(__dirname, 'data', 'uploads', String(userId), originalFile.file_id))) {
                         await fsp.unlink(path.join(__dirname, 'data', 'uploads', String(userId), originalFile.file_id));
                    }
                } else if (originalFile.storage_type === 'webdav' || originalFile.storage_type === 's3') {
                    // 使用新的 storage.upload 方法覆盖或上传
                    // 此处逻辑较为复杂，简单起见，如果是 webdav/s3，我们调用 upload 并删除旧的 DB 记录（或更新）
                    // storage.js 的 upload 支持 existingItem 参数
                    const stats = await fsp.stat(tempFilePath);
                    // 需要重置 stream
                    const uploadStream = fs.createReadStream(tempFilePath);
                    await storage.upload(uploadStream, fileName, 'text/plain', userId, originalFile.folder_id, '', originalFile);
                }
                
                // 对于 local，还需要更新 DB
                if (originalFile.storage_type === 'local') {
                    const stats = await fsp.stat(tempFilePath);
                    await data.updateFile(numericFileId, { fileName, size: stats.size, date: Date.now(), file_id: newRelativePath }, userId);
                }
                return res.json({ success: true, fileId: fileId });
            }
        } else if (mode === 'create' && folderId) {
            const conflict = await data.checkFullConflict(fileName, folderId, userId);
            if (conflict) return res.status(409).json({ success: false, message: '同名冲突' });
            
            const stats = await fsp.stat(tempFilePath);
            if (!(await data.checkQuota(userId, stats.size))) return res.status(400).json({success:false, message:'配额不足'});

            const fileStream = fs.createReadStream(tempFilePath);
            const result = await storage.upload(fileStream, fileName, 'text/plain', userId, folderId);
            res.json({ success: true, fileId: result.fileId });
        } else {
            return res.status(400).json({ success: false, message: '参数无效' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '错误: ' + error.message });
    } finally {
        if (fs.existsSync(tempFilePath)) await fsp.unlink(tempFilePath).catch(()=>{});
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
            return res.status(400).json({ success: false, message: '无效的资料夾 ID' });
        }
        const folderId = parseInt(folderIdStr, 10);
        const userId = req.session.userId;
        const folderDetails = await data.getFolderDetails(folderId, userId);
        if (!folderDetails) {
            return res.status(404).json({ success: false, message: '找不到资料夾' });
        }
        if (folderDetails.is_locked && !req.session.unlockedFolders.includes(folderId)) {
            const folderPath = await data.getFolderPath(folderId, userId);
            return res.json({ locked: true, path: folderPath.map(p => ({ ...p, encrypted_id: encrypt(p.id) })) });
        }
        const contents = await data.getFolderContents(folderId, userId);
        const path = await data.getFolderPath(folderId, userId);
        res.json({ contents, path: path.map(p => ({ ...p, encrypted_id: encrypt(p.id) })) });
    } catch (error) {
        res.status(500).json({ success: false, message: '读取资料夾内容失败。' });
    }
});

app.post('/api/folder', requireLogin, async (req, res) => {
    const { name, parentId } = req.body;
    const userId = req.session.userId;
    if (!name || !parentId) {
        return res.status(400).json({ success: false, message: '缺少资料夾名称或父 ID。' });
    }
    try {
        const conflict = await data.checkFullConflict(name, parentId, userId);
        if (conflict) {
            return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夾。' });
        }
        const result = await data.createFolder(name, parentId, userId);
        const storage = storageManager.getStorage();
        if (storage.type === 'local' || storage.type === 'webdav') {
            const newFolderPathParts = await data.getFolderPath(result.id, userId);
            const newFullPath = path.posix.join(...newFolderPathParts.slice(1).map(p => p.name));
            if (storage.type === 'local') {
                const newLocalPath = path.join(__dirname, 'data', 'uploads', String(userId), newFullPath);
                await fsp.mkdir(newLocalPath, { recursive: true });
            } else if (storage.type === 'webdav' && storage.createDirectory) {
                await storage.createDirectory(newFullPath);
            }
            // S3 不需要显式创建文件夹
        }
        res.json(result);
    } catch (error) {
         res.status(500).json({ success: false, message: error.message || '处理资料夾时发生错误。' });
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
        res.json({ success: true, message: '资料夾已成功解锁（移除密码）。' });
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

// --- 改为软删除 ---
app.post('/delete-multiple', requireLogin, async (req, res) => {
    const { messageIds = [], folderIds = [] } = req.body;
    const userId = req.session.userId;
    try {
        for(const id of messageIds) { 
            await data.unifiedDelete(BigInt(id), 'file', userId); 
        }
        for(const id of folderIds) { 
            await data.unifiedDelete(parseInt(id, 10), 'folder', userId); 
        }
        res.json({ success: true, message: '项目已移至回收站' });
    } catch (error) {
        res.status(500).json({ success: false, message: '删除失败: ' + error.message });
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
        if (fileInfo && fileInfo.storage_type === 'telegram' && fileInfo.thumb_file_id) {
            const storage = storageManager.getStorage();
            const link = await storage.getUrl(fileInfo.thumb_file_id);
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

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', fileInfo.mimetype || 'application/octet-stream');
    
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

        if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav' || fileInfo.storage_type === 's3') {
            const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id, { start, end });
            stream.pipe(res);
        } else if (fileInfo.storage_type === 'telegram') {
            const link = await storage.getUrl(fileInfo.file_id);
            if (link) {
                const response = await axios({ method: 'get', url: link, responseType: 'stream', headers: { 'Range': `bytes=${start}-${end}` } });
                response.data.pipe(res);
            } else {
                res.status(404).send('无法获取文件链接');
            }
        }
    } else {
        res.setHeader('Content-Length', totalSize || -1);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);

        if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav' || fileInfo.storage_type === 's3') {
            const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id);
            stream.pipe(res);
        } else if (fileInfo.storage_type === 'telegram') {
            const link = await storage.getUrl(fileInfo.file_id);
            if (link) {
                const response = await axios({ method: 'get', url: link, responseType: 'stream' });
                response.data.pipe(res);
            } else {
                res.status(404).send('无法获取文件链接');
            }
        }
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
        } else if (fileInfo.storage_type === 'telegram') {
            const link = await storage.getUrl(fileInfo.file_id);
            if (link) {
                const response = await axios.get(link, { responseType: 'text' });
                res.send(response.data);
            } else { res.status(404).send('无法获取文件链接'); }
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

        await new Promise((resolveAll) => {
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
                    archive.append(`错误：无法附加档案 "${file.path}"。\n错误讯息: ${err.message}`, { name: `${file.path} (错误).txt` });
                }
            };
            
            const runTask = () => {
                if (tasks.length === 0 && activeTasks === 0) {
                    return resolveAll();
                }
                while (activeTasks < CONCURRENCY_LIMIT && tasks.length > 0) {
                    activeTasks++;
                    const file = tasks.shift(); 

                    processFile(file)
                        .catch(err => {})
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
    
    // 系统信息
    const uptime = process.uptime();
    const days = Math.floor(uptime / (3600 * 24));
    const hours = Math.floor((uptime % (3600 * 24)) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeString = `${days}天 ${hours}小时 ${minutes}分`;

    res.json({ 
        storageMode: config.storageMode,
        uploadMode: config.uploadMode || 'stream',
        systemInfo: {
            nodeVersion: process.version,
            uptime: uptimeString,
            platform: process.platform,
            memoryUsage: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB'
        }
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
    const oldPassword = (config.webdav && config.webdav.password) ? config.webdav.password : '';
    config.webdav = { 
        url, 
        username,
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
                    const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id);
                     textContent = await new Promise((resolve, reject) => {
                        let data = '';
                        stream.on('data', chunk => data += chunk);
                        stream.on('end', () => resolve(data));
                        stream.on('error', err => reject(err));
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
        if (fileInfo && fileInfo.storage_type === 'telegram' && fileInfo.thumb_file_id) {
            const storage = storageManager.getStorage();
            const link = await storage.getUrl(fileInfo.thumb_file_id);
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
