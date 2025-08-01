require('dotenv').config();
const express = require('express');
const session = require('express-session');
const multer = require('multer');
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

const app = express();

// --- Temp File Directory and Cleanup ---
const TMP_DIR = path.join(__dirname, 'data', 'tmp');

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
            } catch (err) {
                // 在生产环境中，这类非致命警告可以被移除或记录到专门的日志文件
            }
        }
    } catch (error) {
        console.error(`[严重错误] 清理暂存目录失败: ${TMP_DIR}。`, error);
    }
}
cleanupTempDir();

const diskStorage = multer.diskStorage({
  destination: (req, res, cb) => cb(null, TMP_DIR)
});
const upload = multer({ storage: diskStorage, limits: { fileSize: 1000 * 1024 * 1024 } });
const PORT = process.env.PORT || 8100;

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-strong-random-secret-here-please-change',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// --- Middleware ---
const fixFileNameEncoding = (req, res, next) => {
    if (req.files) {
        req.files.forEach(file => {
            file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
        });
    }
    next();
};

function requireLogin(req, res, next) {
  if (req.session.loggedIn) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
    if (req.session.loggedIn && req.session.isAdmin) {
        return next();
    }
    res.status(403).send('权限不足');
}

// --- Routes ---
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
            // Attempt to create root folder if missing for some reason
            data.createFolder('/', null, req.session.userId)
                .then(newRoot => res.redirect(`/folder/${newRoot.id}`))
                .catch(() => res.status(500).send("找不到您的根目录，也无法建立。"));
            return;
        }
        res.redirect(`/folder/${rootFolder.id}`);
    });
});
app.get('/folder/:id', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/manager.html')));
app.get('/shares-page', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/shares.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin.html')));

app.get('/scan', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/scan.html')));

// --- API Endpoints ---
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

const uploadMiddleware = (req, res, next) => {
    upload.array('files')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, message: '文件大小超出限制。' });
            }
            if (err.code === 'EDQUOT' || err.errno === -122) {
                return res.status(507).json({ success: false, message: '上传失败：磁盘空间不足。' });
            }
            return res.status(500).json({ success: false, message: '上传档案到暂存区时发生错误。' });
        }
        next();
    });
};

app.post('/upload', requireLogin, async (req, res, next) => {
    await cleanupTempDir();
    next();
}, uploadMiddleware, fixFileNameEncoding, async (req, res) => {

    if (!req.files || req.files.length === 0) {
        return res.status(400).json({ success: false, message: '没有选择文件' });
    }

    const initialFolderId = parseInt(req.body.folderId, 10);
    const userId = req.session.userId;
    const storage = storageManager.getStorage();
    const resolutions = req.body.resolutions ? JSON.parse(req.body.resolutions) : {};
    let relativePaths = req.body.relativePaths;

    if (!relativePaths) {
        relativePaths = req.files.map(file => file.originalname);
    } else if (!Array.isArray(relativePaths)) {
        relativePaths = [relativePaths];
    }

    if (req.files.length !== relativePaths.length) {
        return res.status(400).json({ success: false, message: '上传档案和路径资讯不匹配。' });
    }

    const results = [];
    let skippedCount = 0;
    try {
        for (let i = 0; i < req.files.length; i++) {
            const file = req.files[i];
            const tempFilePath = file.path;
            const relativePath = relativePaths[i];
            
            const action = resolutions[relativePath] || 'upload';

            try {
                if (action === 'skip') {
                    skippedCount++;
                    continue;
                }

                const pathParts = (relativePath || file.originalname).split('/');
                let fileName = pathParts.pop() || file.originalname;
                const folderPathParts = pathParts;

                const targetFolderId = await data.resolvePathToFolderId(initialFolderId, folderPathParts, userId);
                
                if (action === 'overwrite') {
                    const existingItem = await data.findItemInFolder(fileName, targetFolderId, userId);
                    if (existingItem) {
                        await data.unifiedDelete(existingItem.id, existingItem.type, userId);
                    }
                } else if (action === 'rename') {
                    fileName = await data.findAvailableName(fileName, targetFolderId, userId, false);
                } else {
                    const conflict = await data.findItemInFolder(fileName, targetFolderId, userId);
                    if (conflict) {
                        skippedCount++;
                        continue;
                    }
                }

                const result = await storage.upload(tempFilePath, fileName, file.mimetype, userId, targetFolderId, req.body.caption || '');
                results.push(result);

            } finally {
                if (fs.existsSync(tempFilePath)) {
                    await fsp.unlink(tempFilePath).catch(err => {});
                }
            }
        }
        if (results.length === 0 && skippedCount > 0) {
            res.json({ success: true, skippedAll: true, message: '所有文件因冲突而被跳过。' });
        } else {
            res.json({ success: true, results });
        }
    } catch (error) {
        for (const file of req.files) {
            if (fs.existsSync(file.path)) {
                await fsp.unlink(file.path).catch(err => {});
            }
        }
        res.status(500).json({ success: false, message: '处理上传时发生错误: ' + error.message });
    }
});
app.post('/api/text-file', requireLogin, async (req, res) => {
    const { mode, fileId, folderId, fileName, content } = req.body;
    const userId = req.session.userId;
    const storage = storageManager.getStorage();

    if (!fileName || !fileName.endsWith('.txt')) {
        return res.status(400).json({ success: false, message: '档名无效或不是 .txt 档案' });
    }

    const tempFilePath = path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.txt`);

    try {
        await fsp.writeFile(tempFilePath, content, 'utf8');
        let result;

        if (mode === 'edit' && fileId) {
            const filesToUpdate = await data.getFilesByIds([fileId], userId);
            if (filesToUpdate.length > 0) {
                const originalFile = filesToUpdate[0];
                
                if (fileName !== originalFile.fileName) {
                    const conflict = await data.checkFullConflict(fileName, originalFile.folder_id, userId);
                    if (conflict) {
                        await fsp.unlink(tempFilePath).catch(err => {});
                        return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
                    }
                }
                
                await data.unifiedDelete(originalFile.message_id, 'file', userId);
                result = await storage.upload(tempFilePath, fileName, 'text/plain', userId, originalFile.folder_id);
            } else {
                return res.status(404).json({ success: false, message: '找不到要编辑的原始档案' });
            }
        } else if (mode === 'create' && folderId) {
             const conflict = await data.checkFullConflict(fileName, folderId, userId);
            if (conflict) {
                return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
            }
            result = await storage.upload(tempFilePath, fileName, 'text/plain', userId, folderId);
        } else {
            return res.status(400).json({ success: false, message: '请求参数无效' });
        }
        res.json({ success: true, fileId: result.fileId });
    } catch (error) {
        res.status(500).json({ success: false, message: '伺服器内部错误' });
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

        res.json({
            success: true,
            fileConflicts,
            folderConflicts
        });

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

app.get('/api/folder/:id', requireLogin, async (req, res) => {
    try {
        const folderId = parseInt(req.params.id, 10);
        const contents = await data.getFolderContents(folderId, req.session.userId);
        const path = await data.getFolderPath(folderId, req.session.userId);
        res.json({ contents, path });
    } catch (error) { res.status(500).json({ success: false, message: '读取资料夹内容失败。' }); }
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
         res.status(500).json({ success: false, message: error.message || '处理资料夹时发生错误。' });
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
        
        let totalMoved = 0;
        let totalSkipped = 0;
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
                if (report.errors > 0) {
                    errors.push(`项目 "${item.name}" 处理失败。`);
                }

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

app.get('/download/proxy/:message_id', requireLogin, async (req, res) => {
    try {
        const messageId = parseInt(req.params.message_id, 10);
        const [fileInfo] = await data.getFilesByIds([messageId], req.session.userId);
        
        if (!fileInfo || !fileInfo.file_id) {
            return res.status(404).send('文件信息未找到');
        }

        const storage = storageManager.getStorage();
        
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);
        if (fileInfo.mimetype) res.setHeader('Content-Type', fileInfo.mimetype);
        if (fileInfo.size) res.setHeader('Content-Length', fileInfo.size);

        if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav') {
            const stream = await storage.stream(fileInfo.file_id, req.session.userId);
            handleStream(stream, res);
        } else if (fileInfo.storage_type === 'telegram') {
            const link = await storage.getUrl(fileInfo.file_id);
            if (link) {
                const response = await axios({ method: 'get', url: link, responseType: 'stream' });
                response.data.pipe(res);
            } else { res.status(404).send('无法获取文件链接'); }
        }

    } catch (error) { 
        res.status(500).send('下载代理失败: ' + error.message); 
    }
});

app.get('/file/content/:message_id', requireLogin, async (req, res) => {
    try {
        const messageId = parseInt(req.params.message_id, 10);
        const [fileInfo] = await data.getFilesByIds([messageId], req.session.userId);

        if (!fileInfo || !fileInfo.file_id) {
            return res.status(404).send('文件信息未找到');
        }
        
        const storage = storageManager.getStorage();
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');

        if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav') {
            const stream = await storage.stream(fileInfo.file_id, req.session.userId);
            handleStream(stream, res);
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
        const { itemId, itemType, expiresIn } = req.body;
        if (!itemId || !itemType || !expiresIn) {
            return res.status(400).json({ success: false, message: '缺少必要参数。' });
        }
        
        const result = await data.createShareLink(parseInt(itemId, 10), itemType, expiresIn, req.session.userId);
        
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

// --- Scanner Endpoints ---
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
                const fileId = relativePath; // file_id is the relative path

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
                        await data.addFile({
                            message_id: messageId,
                            fileName: entry.name,
                            mimetype: 'application/octet-stream',
                            size: stats.size,
                            file_id: fileId,
                            date: stats.mtime.getTime(),
                        }, folderId, userId, 'local');
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
        const client = createClient(config.webdav.url, {
            username: config.webdav.username,
            password: config.webdav.password
        });
        
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
                        await data.addFile({
                            message_id: messageId,
                            fileName: item.basename,
                            mimetype: item.mime || 'application/octet-stream',
                            size: item.size,
                            file_id: item.filename,
                            date: new Date(item.lastmod).getTime(),
                        }, folderId, userId, 'webdav');
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

// --- Share Routes ---
app.get('/share/view/file/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const fileInfo = await data.getFileByShareToken(token);
        if (fileInfo) {
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
            res.render('share-view', { file: fileInfo, downloadUrl, textContent });
        } else {
            res.status(404).render('share-error', { message: '此分享连结无效或已过期。' });
        }
    } catch (error) { res.status(500).render('share-error', { message: '处理分享请求时发生错误。' }); }
});

app.get('/share/view/folder/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const folderInfo = await data.getFolderByShareToken(token);
        if (folderInfo) {
            const contents = await data.getFolderContents(folderInfo.id, folderInfo.user_id);
            res.render('share-folder-view', { folder: folderInfo, contents });
        } else {
            res.status(404).render('share-error', { message: '此分享连结无效或已过期。' });
        }
    } catch (error) { 
        res.status(500).render('share-error', { message: '处理分享请求时发生错误。' }); 
    }
});

function handleStream(stream, res) {
    stream.on('error', (err) => {
        if (!res.headersSent) {
            res.status(500).send('读取文件流时发生错误');
        }
        stream.destroy();
    }).on('close', () => {
        stream.destroy();
    }).pipe(res).on('finish', () => {
        stream.destroy();
    });
}

app.get('/share/download/file/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const fileInfo = await data.getFileByShareToken(token);
        if (!fileInfo || !fileInfo.file_id) {
             return res.status(404).send('文件信息未找到或分享链接已过期');
        }

        const storage = storageManager.getStorage();
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);

        if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav') {
            const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id);
            handleStream(stream, res);
        } else if (fileInfo.storage_type === 'telegram') {
            const link = await storage.getUrl(fileInfo.file_id);
            if (link) {
                const response = await axios({ method: 'get', url: link, responseType: 'stream' });
                response.data.pipe(res);
            } else { res.status(404).send('无法获取文件链接'); }
        }

    } catch (error) { res.status(500).send('下载失败'); }
});

app.get('/share/thumbnail/:folderToken/:fileId', async (req, res) => {
    try {
        const { folderToken, fileId } = req.params;
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

app.get('/share/download/:folderToken/:fileId', async (req, res) => {
    try {
        const { folderToken, fileId } = req.params;
        const fileInfo = await data.findFileInSharedFolder(parseInt(fileId, 10), folderToken);
        
        if (!fileInfo || !fileInfo.file_id) {
             return res.status(404).send('文件信息未找到或权限不足');
        }
        
        const storage = storageManager.getStorage();
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);

        if (fileInfo.storage_type === 'local' || fileInfo.storage_type === 'webdav') {
            const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id);
            handleStream(stream, res);
        } else if (fileInfo.storage_type === 'telegram') {
            const link = await storage.getUrl(fileInfo.file_id);
            if (link) {
                const response = await axios({ method: 'get', url: link, responseType: 'stream' });
                response.data.pipe(res);
            } else { res.status(404).send('无法获取文件链接'); }
        }
    } catch (error) {
        res.status(500).send('下载失败');
    }
});


app.listen(PORT, () => console.log(`✅ 伺服器已在 http://localhost:${PORT} 上运行`));
