// server.js (最终正式版)

require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser'); // <--- 引入 cookie-parser
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

const jsonReplacer = (key, value) => {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
};
app.set('json replacer', jsonReplacer);

const TMP_DIR = path.join(__dirname, 'data', 'tmp');

// const log = (level, file, func, message, ...args) => {
//     // const timestamp = new Date().toISOString();
//     // console.log(`[${timestamp}] [${level}] [${file}:${func}] - ${message}`, ...args);
// };

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

const PORT = process.env.PORT || 8100;

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-strong-random-secret-here-please-change',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 注意：此处的 maxAge 将被 /login 路由中的逻辑覆盖
}));

// --- *** 关键修正 1: 修复会话持久化问题 *** ---
// 将分享链接的 session cookie 改为会话级 cookie
// 移除了 cookie.maxAge 属性，这样浏览器会在无痕窗口完全关闭后可靠地删除它
const shareSession = session({
  secret: process.env.SESSION_SECRET + '-share',
  resave: false,
  saveUninitialized: true,
  cookie: { /* maxAge 已被移除 */ }
});

app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use(cookieParser()); // <--- 使用 cookie-parser

// --- 新增：自动登入中间件 ---
async function checkRememberMeCookie(req, res, next) {
    // 1. 如果使用者已经透过 session 登入了，则无需执行任何操作
    if (req.session.loggedIn) {
        return next();
    }
    
    // 2. 取得 "remember_me" cookie
    const rememberToken = req.cookies.remember_me;
    
    if (rememberToken) {
        try {
            // 3. 尝试从数据库中寻找这个 token
            const tokenData = await data.findAuthToken(rememberToken);
            
            // 4. 验证 Token 是否存在且未过期
            if (tokenData && tokenData.expires_at > Date.now()) {
                const user = { id: tokenData.user_id, username: tokenData.username, is_admin: tokenData.is_admin };
                
                // 5. 验证通过，为使用者建立新会话
                req.session.loggedIn = true;
                req.session.userId = user.id;
                req.session.isAdmin = !!user.is_admin;
                req.session.unlockedFolders = [];
                
                // 6. (安全强化) 移除旧 Token
                await data.deleteAuthToken(rememberToken);
                
                // 7. (安全强化) 产生一个新 Token (滚动令牌机制)
                const newRememberToken = crypto.randomBytes(64).toString('hex');
                const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 天
                await data.createAuthToken(user.id, newRememberToken, expiresAt);
                
                // 8. 设定新的 "remember_me" cookie
                res.cookie('remember_me', newRememberToken, {
                    path: '/',
                    httpOnly: true, // 仅伺服器可存取
                    secure: req.protocol === 'https', // 仅在 HTTPS 下传输
                    maxAge: 30 * 24 * 60 * 60 * 1000 // Cookie 效期 30 天
                });
                
            } else if (tokenData) {
                // 9. Token 存在但已过期，将其从数据库删除
                await data.deleteAuthToken(rememberToken);
                res.clearCookie('remember_me', { path: '/' });
            } else {
                // 10. Token 无效 (在数据库中找不到)，清除 cookie
                res.clearCookie('remember_me', { path: '/' });
            }
        } catch (err) {
            // 11. 处理查询数据库等错误
            console.error('检查 "remember_me" cookie 时出错:', err);
            res.clearCookie('remember_me', { path: '/' });
        }
    }
    
    // 12. 无论如何都继续下一个中间件
    return next();
}

app.use(checkRememberMeCookie); // <--- 在所有路由之前应用此中间件

// (推荐) 定时清理过期的 Token, 每天一次
setInterval(async () => {
    try {
        const result = await data.deleteExpiredAuthTokens();
        if (result && result.changes > 0) {
             // console.log(`[Scheduler] 清理了 ${result.changes} 个过期的登入令牌。`);
        }
    } catch (e) {
        console.error("定时清除过期 token 失败:", e);
    }
}, 1000 * 60 * 60 * 24); // 每天执行一次
// --- 中间件结束 ---


// --- *** 关键修正：处理 API 请求的会话过期 *** ---
function requireLogin(req, res, next) {
  if (req.session.loggedIn) return next();
  
  // 检查是否为 XHR (API) 请求
  if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
    // 对 API 请求发送 401 状态码
    return res.status(401).json({ success: false, message: '会话已过期，请重新登入。' });
  } else {
    // 对非 API 的页面请求重定向到登入页
    res.redirect('/login');
  }
}
// --- *** 修正结束 *** ---

function requireAdmin(req, res, next) {
    if (req.session.loggedIn && req.session.isAdmin) {
        return next();
    }
    // --- *** 关键修正：处理 API 请求的会话过期 (管理员) *** ---
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('json'))) {
        return res.status(403).json({ success: false, message: '权限不足。' });
    } else {
        res.status(403).send('权限不足');
    }
}

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views/login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'views/register.html')));
app.get('/editor', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/editor.html')));

// --- *** 伺服器端修改：/login 路由 *** ---
app.post('/login', async (req, res) => {
    try {
        const user = await data.findUserByName(req.body.username);
        if (user && await bcrypt.compare(req.body.password, user.password)) {
            req.session.loggedIn = true;
            req.session.userId = user.id;
            req.session.isAdmin = !!user.is_admin;
            req.session.unlockedFolders = [];

            // --- 新增：保持登陆逻辑 ---
            if (req.body.remember) {
                // --- 关键修改：设定持久化 Token ---
                const rememberToken = crypto.randomBytes(64).toString('hex');
                const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 天
                
                try {
                    // 1. 将 Token 存入数据库
                    await data.createAuthToken(user.id, rememberToken, expiresAt);
                    
                    // 2. 设定 "remember_me" cookie
                    res.cookie('remember_me', rememberToken, {
                        path: '/',
                        httpOnly: true,
                        secure: req.protocol === 'https', // 在生产环境中应为 true
                        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 天
                    });
                    
                    // 3. 设定会话 cookie 的 maxAge (与原逻辑保持一致)
                    req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
                    
                } catch (tokenError) {
                    console.error("建立 auth token 失败:", tokenError);
                    // 即使 token 失败，也继续登入（但不保持）
                    req.session.cookie.expires = false;
                    req.session.cookie.maxAge = null;
                }
                // --- 修改结束 ---
            } else {
                // 未勾选，使用预设的会话 cookie (浏览器关闭时失效)
                req.session.cookie.expires = false;
                req.session.cookie.maxAge = null;
            }
            // --- 逻辑结束 ---

            res.redirect('/');
        } else {
            res.status(401).send('帐号或密码错误');
        }
    } catch(error) {
        res.status(500).send('登入时发生错误');
    }
});
// --- *** 修改结束 *** ---

app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).send('请提供使用者名称和密码');
    }
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
    // --- 新增：登出时清除 remember_me token ---
    const rememberToken = req.cookies.remember_me;
    if (rememberToken) {
        // 异步删除，无需等待
        data.deleteAuthToken(rememberToken).catch(err => {
            console.error("删除 auth token 失败:", err);
        });
    }
    res.clearCookie('remember_me', { path: '/' });
    // --- 新增结束 ---

    req.session.destroy(err => {
        if (err) {
            return res.redirect('/');
        }
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

app.post('/upload', requireLogin, (req, res) => {
    const { folderId, resolutions: resolutionsJSON, caption } = req.query;
    const userId = req.session.userId;
    const storage = storageManager.getStorage();
    const MAX_FILENAME_BYTES = 255; 

    try {
        if (!folderId) throw new Error('folderId is missing from query parameters');
        const initialFolderId = parseInt(folderId, 10);
        if (isNaN(initialFolderId)) throw new Error('Invalid folderId');
        
        const resolutions = JSON.parse(resolutionsJSON || '{}');
        
        const busboy = Busboy({ headers: req.headers });
        const uploadPromises = [];

        busboy.on('file', (fieldname, fileStream, fileInfo) => {
            const relativePath = Buffer.from(fieldname, 'latin1').toString('utf8');
            
            const fileUploadPromise = (async () => {
                const { mimeType } = fileInfo;
                const pathParts = relativePath.split('/').filter(p => p);
                let finalFilename = pathParts.pop() || relativePath;

                // --- *** 关键修正：改用字节长度进行验证 *** ---
                if (Buffer.byteLength(finalFilename, 'utf8') > MAX_FILENAME_BYTES) {
                    fileStream.resume(); 
                    throw new Error(`档名 "${finalFilename.substring(0, 30)}..." 过长 (超过 ${MAX_FILENAME_BYTES} 字节)。`);
                }
                // --- 修正结束 ---

                const action = resolutions[relativePath] || 'upload';

                if (action === 'skip') {
                    fileStream.resume();
                    return { skipped: true };
                }

                const folderPathParts = pathParts;

                const targetFolderId = await data.resolvePathToFolderId(initialFolderId, folderPathParts, userId);
                
                if (action === 'overwrite') {
                    const existingItem = await data.findItemInFolder(finalFilename, targetFolderId, userId);
                    if (existingItem) {
                        await data.unifiedDelete(existingItem.id, existingItem.type, userId);
                    }
                } else if (action === 'rename') {
                    finalFilename = await data.findAvailableName(finalFilename, targetFolderId, userId, false);
                } else {
                    const conflict = await data.findItemInFolder(finalFilename, targetFolderId, userId);
                    if (conflict) {
                        fileStream.resume();
                        return { skipped: true };
                    }
                }
                
                await storage.upload(fileStream, finalFilename, mimeType, userId, targetFolderId, caption || '');
                return { skipped: false };
            })().catch(err => {
                fileStream.resume();
                throw err;
            });
            uploadPromises.push(fileUploadPromise);
        });

        busboy.on('finish', async () => {
            try {
                const results = await Promise.all(uploadPromises);
                const allSkipped = results.length > 0 && results.every(r => r.skipped);

                if (allSkipped) {
                     res.json({ success: true, skippedAll: true, message: '所有文件都因冲突而被跳过' });
                } else {
                     res.json({ success: true, message: '上传完成' });
                }
            } catch (error) {
                if (!res.headersSent) {
                    res.status(500).json({ success: false, message: `上传任务执行失败: ${error.message}` });
                }
            }
        });

        busboy.on('error', (err) => {
            req.unpipe(busboy);
            if (!res.headersSent) {
                res.status(500).json({ success: false, message: '上传解析失败' });
            }
        });

        req.pipe(busboy);

    } catch (err) {
        res.status(400).json({ success: false, message: `请求预处理失败: ${err.message}` });
    }
});

app.post('/api/text-file', requireLogin, async (req, res) => {
    const { mode, fileId, folderId, fileName, content } = req.body;
    const userId = req.session.userId;
    const storage = storageManager.getStorage();

    if (!fileName) {
        return res.status(400).json({ success: false, message: '档名无效' });
    }

    const tempFilePath = path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.txt`);

    try {
        await fsp.writeFile(tempFilePath, content, 'utf8');
        
        if (mode === 'edit' && fileId) {
            const filesToUpdate = await data.getFilesByIds([fileId], userId);
            if (filesToUpdate.length === 0) {
                return res.status(404).json({ success: false, message: '找不到要编辑的原始档案' });
            }
            const originalFile = filesToUpdate[0];

            if (fileName !== originalFile.fileName) {
                const conflict = await data.checkFullConflict(fileName, originalFile.folder_id, userId);
                if (conflict) {
                    return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夾。' });
                }
            }

            if (originalFile.storage_type === 'telegram') {
                const fileStream = fs.createReadStream(tempFilePath);
                await data.unifiedDelete(originalFile.message_id, 'file', userId);
                const result = await storage.upload(fileStream, fileName, 'text/plain', userId, originalFile.folder_id);
                return res.json({ success: true, fileId: result.fileId });
            } else {
                const newRelativePath = path.posix.join(path.posix.dirname(originalFile.file_id), fileName);
                if (originalFile.storage_type === 'local') {
                    const newFullPath = path.join(__dirname, 'data', 'uploads', String(userId), newRelativePath);
                    await fsp.mkdir(path.dirname(newFullPath), { recursive: true });
                    await fsp.copyFile(tempFilePath, newFullPath);
                    if (originalFile.file_id !== newRelativePath && fs.existsSync(path.join(__dirname, 'data', 'uploads', String(userId), originalFile.file_id))) {
                         await fsp.unlink(path.join(__dirname, 'data', 'uploads', String(userId), originalFile.file_id));
                    }
                } else if (originalFile.storage_type === 'webdav') {
                    const fileStream = fs.createReadStream(tempFilePath);
                    const client = storage.getClient();
                    await client.putFileContents(newRelativePath, fileStream, { overwrite: true });
                    if (originalFile.file_id !== newRelativePath) {
                        await client.deleteFile(originalFile.file_id);
                    }
                }
                const stats = await fsp.stat(tempFilePath);
                await data.updateFile(fileId, { fileName, size: stats.size, date: Date.now(), file_id: newRelativePath }, userId);
                return res.json({ success: true, fileId: fileId });
            }
        } else if (mode === 'create' && folderId) {
            const conflict = await data.checkFullConflict(fileName, folderId, userId);
            if (conflict) {
                return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夾。' });
            }
            const fileStream = fs.createReadStream(tempFilePath);
            const result = await storage.upload(fileStream, fileName, 'text/plain', userId, folderId);
            res.json({ success: true, fileId: result.fileId });
        } else {
            return res.status(400).json({ success: false, message: '请求参数无效' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: '伺服器内部错误: ' + error.message });
    } finally {
        if (fs.existsSync(tempFilePath)) {
            await fsp.unlink(tempFilePath).catch(err => {});
        }
    }
});
app.get('/api/file-info/:id', requireLogin, async (req, res) => {
    try {
        const fileId = parseInt(req.params.id, 10);
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

app.post('/delete-multiple', requireLogin, async (req, res) => {
    const { messageIds = [], folderIds = [] } = req.body;
    const userId = req.session.userId;
    try {
        for(const id of messageIds) { await data.unifiedDelete(id, 'file', userId); }
        for(const id of folderIds) { await data.unifiedDelete(id, 'folder', userId); }
        res.json({ success: true, message: '删除成功' });
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
            result = await data.renameFile(parseInt(id, 10), newName, userId);
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
        const messageId = parseInt(req.params.message_id, 10);
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

        if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav') {
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
        
        // --- *** 关键修正：将预设改为 'attachment' 以强制下载 *** ---
        // 原始设定为 'inline'，导致浏览器尝试开启文字档案而非下载。
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);
        
        // 原始的 ?download=true 检查逻辑已不再必要
        // if (req.query.download) {
        //     res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);
        // }

        if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav') {
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
        const messageId = parseInt(req.params.message_id, 10);
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
        const messageId = parseInt(req.params.message_id, 10);
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
        if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav') {
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
            const directFiles = await data.getFilesByIds(messageIds, userId);
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
        archive.pipe(res);
        for (const file of filesToArchive) {
             if (file.storage_type === 'local' || file.storage_type === 'webdav') {
                const stream = await storage.stream(file.file_id, userId);
                archive.append(stream, { name: file.path });
             } else if (file.storage_type === 'telegram') {
                const link = await storage.getUrl(file.file_id);
                if (link) {
                    const response = await axios({ url: link, method: 'GET', responseType: 'stream' });
                    archive.append(response.data, { name: file.path });
                }
            }
        }
        await archive.finalize();
    } catch (error) {
        res.status(500).send('压缩档案时发生错误');
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
        const result = await data.createShareLink(parseInt(itemId, 10), itemType, expiresIn, req.session.userId, password, customExpiresAt);
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
        const result = await data.cancelShare(parseInt(itemId, 10), itemType, req.session.userId);
        res.json(result);
    } catch (error) { res.status(500).json({ success: false, message: '取消分享失败' }); }
});

app.post('/api/scan/local', requireAdmin, async (req, res) => {
    const { userId } = req.body;
    const log = [];
    try {
        if (!userId) throw new Error('未提供使用者 ID');
        const userUploadDir = path.join(__dirname, 'data', 'uploads', String(userId));
        if (!fs.existsSync(userUploadDir)) {
            log.push({ message: `使用者 ${userId} 的本地储存目录不存在，跳过。`, type: 'warn' });
            return res.json({ success: true, log });
        }
        const rootFolder = await data.getRootFolder(userId);
        if (!rootFolder) {
            throw new Error(`找不到使用者 ${userId} 的根目录`);
        }
        async function scanDirectory(dir) {
            const entries = await fsp.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = path.relative(userUploadDir, fullPath).replace(/\\/g, '/');
                const fileId = relativePath;
                if (entry.isDirectory()) {
                    await scanDirectory(fullPath);
                } else {
                    const existing = await data.findFileByFileId(fileId, userId);
                    if (existing) {
                        log.push({ message: `已存在: ${relativePath}，跳过。`, type: 'info' });
                    } else {
                        const stats = await fsp.stat(fullPath);
                        const folderPath = path.dirname(relativePath).replace(/\\/g, '/');
                        const folderId = await data.findOrCreateFolderByPath(folderPath, userId);
                        const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
                        await data.addFile({ message_id: messageId, fileName: entry.name, mimetype: 'application/octet-stream', size: stats.size, file_id: fileId, date: stats.mtime.getTime() }, folderId, userId, 'local');
                        log.push({ message: `已汇入: ${relativePath}`, type: 'success' });
                    }
                }
            }
        }
        await scanDirectory(userUploadDir);
        res.json({ success: true, log });
    } catch (error) {
        log.push({ message: `扫描本地文件时出错: ${error.message}`, type: 'error' });
        res.status(500).json({ success: false, message: error.message, log });
    }
});

app.post('/api/scan/webdav', requireAdmin, async (req, res) => {
    const { userId } = req.body;
    const log = [];
    try {
        if (!userId) throw new Error('未提供使用者 ID');
        const { createClient } = require('webdav');
        const config = storageManager.readConfig();
        if (!config.webdav || !config.webdav.url) {
            throw new Error('WebDAV 设定不完整');
        }
        const client = createClient(config.webdav.url, { username: config.webdav.username, password: config.webdav.password });
        async function scanWebdavDirectory(remotePath) {
            const contents = await client.getDirectoryContents(remotePath, { deep: true });
            for (const item of contents) {
                if (item.type === 'file') {
                    const existing = await data.findFileByFileId(item.filename, userId);
                     if (existing) {
                        log.push({ message: `已存在: ${item.filename}，跳过。`, type: 'info' });
                    } else {
                        const folderPath = path.dirname(item.filename).replace(/\\/g, '/');
                        const folderId = await data.findOrCreateFolderByPath(folderPath, userId);
                        const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
                        await data.addFile({ message_id: messageId, fileName: item.basename, mimetype: item.mime || 'application/octet-stream', size: item.size, file_id: item.filename, date: new Date(item.lastmod).getTime() }, folderId, userId, 'webdav');
                        log.push({ message: `已汇入: ${item.filename}`, type: 'success' });
                    }
                }
            }
        }
        await scanWebdavDirectory('/');
        res.json({ success: true, log });
    } catch (error) {
        let errorMessage = error.message;
        if (error.response && error.response.status === 403) {
            errorMessage = '存取被拒绝 (403 Forbidden)。这通常意味着您的 WebDAV 伺服器不允许列出目录内容。请检查您帐号的权限，确保它有读取和浏览目录的权限。';
            log.push({ message: '扫描失败：无法列出远端目录内容。', type: 'error' });
        }
        log.push({ message: `详细错误: ${errorMessage}`, type: 'error' });
        res.status(500).json({ success: false, message: errorMessage, log });
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
        // --- *** 关键修正 2: 修复代理缓存问题 *** ---
        // 强制设置 HTTP 响应头，禁止任何代理或浏览器缓存此页面
        // 这是为了防止已解锁的分享页面被缓存，导致其他用户无需密码即可访问
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
                if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav') {
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
        // --- *** 关键修正 2: 修复代理缓存问题 *** ---
        // 强制设置 HTTP 响应头，禁止任何代理或浏览器缓存此页面
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
        const fileInfo = await data.findFileInSharedFolder(parseInt(fileId, 10), folderToken);
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
        const fileInfo = await data.findFileInSharedFolder(parseInt(fileId, 10), folderToken);
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
    res.json({ mode: storageManager.readConfig().storageMode });
});

app.post('/api/admin/storage-mode', requireAdmin, (req, res) => {
    const { mode } = req.body;
    if (storageManager.setStorageMode(mode)) {
        res.json({ success: true, message: '设定已储存。' });
    } else {
        res.status(400).json({ success: false, message: '无效的模式' });
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
    config.webdav = { url, username };
    if (password) {
        config.webdav.password = password;
    }
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
