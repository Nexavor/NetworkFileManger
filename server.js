require('dotenv').config();
const express = require('express');
const session = require('express-session');
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
const { encrypt, decrypt } = require('./utils.js');

const app = express();

const jsonReplacer = (key, value) => {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
};
app.set('json replacer', jsonReplacer);

const TMP_DIR = path.join(__dirname, 'data', 'tmp');

const log = (level, file, func, message, ...args) => {};

async function cleanupTempDir() {
    try {
        if (!fs.existsSync(TMP_DIR)) {
            await fsp.mkdir(TMP_DIR, { recursive: true });
        } else {
            const files = await fsp.readdir(TMP_DIR);
            for (const file of files) {
                try {
                    await fsp.unlink(path.join(TMP_DIR, file));
                } catch (err) {}
            }
        }
    } catch (error) {}
}
cleanupTempDir();

const PORT = process.env.PORT || 8100;

app.use(session({
  secret: process.env.SESSION_SECRET || 'your-strong-random-secret-here-please-change',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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
        if (err) return res.redirect('/');
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

app.get('/', requireLogin, (req, res) => {
    db.get("SELECT id FROM folders WHERE user_id = ? AND parent_id IS NULL", [req.session.userId], (err, rootFolder) => {
        if (err || !rootFolder) {
            data.createFolder('/', null, req.session.userId)
                .then(newRoot => res.redirect(`/view/${encrypt(`folder/${newRoot.id}`)}`))
                .catch(() => res.status(500).send("找不到您的根目录，也无法建立。"));
            return;
        }
        res.redirect(`/view/${encrypt(`folder/${rootFolder.id}`)}`);
    });
});

app.get('/view/:encryptedPath', requireLogin, (req, res) => {
    res.sendFile(path.join(__dirname, 'views/manager.html'));
});

app.get('/shares-page', requireLogin, (req, res) => res.sendFile(path.join(__dirname, 'views/shares.html')));
app.get('/admin', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/admin.html')));
app.get('/scan', requireAdmin, (req, res) => res.sendFile(path.join(__dirname, 'views/scan.html')));

app.post('/upload', requireLogin, (req, res) => {
    const { folderId, resolutions: resolutionsJSON, caption } = req.query;
    const userId = req.session.userId;
    const storage = storageManager.getStorage();

    try {
        if (!folderId) throw new Error('folderId is missing');
        const initialFolderId = parseInt(folderId, 10);
        if (isNaN(initialFolderId)) throw new Error('Invalid folderId');
        
        const resolutions = JSON.parse(resolutionsJSON || '{}');
        const busboy = Busboy({ headers: req.headers });
        const uploadPromises = [];

        busboy.on('file', (fieldname, fileStream, fileInfo) => {
            const relativePath = Buffer.from(fieldname, 'latin1').toString('utf8');
            const fileUploadPromise = (async () => {
                const { mimeType } = fileInfo;
                const action = resolutions[relativePath] || 'upload';

                if (action === 'skip') {
                    fileStream.resume();
                    return { skipped: true };
                }

                const pathParts = relativePath.split('/').filter(p => p);
                let finalFilename = pathParts.pop() || relativePath;
                const targetFolderId = await data.resolvePathToFolderId(initialFolderId, pathParts, userId);
                
                if (action === 'overwrite') {
                    const existingItem = await data.findItemInFolder(finalFilename, targetFolderId, userId);
                    if (existingItem) await data.unifiedDelete(existingItem.id, existingItem.type, userId);
                } else if (action === 'rename') {
                    finalFilename = await data.findAvailableName(finalFilename, targetFolderId, userId, false);
                } else {
                    if (await data.findItemInFolder(finalFilename, targetFolderId, userId)) {
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
                res.json({ success: true, skippedAll: allSkipped, message: allSkipped ? '所有文件都因冲突而被跳过' : '上传完成' });
            } catch (error) {
                if (!res.headersSent) res.status(500).json({ success: false, message: `上传任务执行失败: ${error.message}` });
            }
        });

        busboy.on('error', (err) => {
            req.unpipe(busboy);
            if (!res.headersSent) res.status(500).json({ success: false, message: '上传解析失败' });
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

    if (!fileName) return res.status(400).json({ success: false, message: '档名无效' });

    const tempFilePath = path.join(TMP_DIR, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.txt`);

    try {
        await fsp.writeFile(tempFilePath, content, 'utf8');
        
        if (mode === 'edit' && fileId) {
            const [originalFile] = await data.getFilesByIds([fileId], userId);
            if (!originalFile) return res.status(404).json({ success: false, message: '找不到要编辑的原始档案' });

            if (fileName !== originalFile.fileName && await data.checkFullConflict(fileName, originalFile.folder_id, userId)) {
                return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
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
                    // *** 关键修正：使用 fs 而不是未定义的 fsSync ***
                    if (originalFile.file_id !== newRelativePath && fs.existsSync(path.join(__dirname, 'data', 'uploads', String(userId), originalFile.file_id))) {
                         await fsp.unlink(path.join(__dirname, 'data', 'uploads', String(userId), originalFile.file_id));
                    }
                } else if (originalFile.storage_type === 'webdav') {
                    const fileStream = fs.createReadStream(tempFilePath);
                    const client = storage.getClient();
                    await client.putFileContents(newRelativePath, fileStream, { overwrite: true });
                    if (originalFile.file_id !== newRelativePath) await client.deleteFile(originalFile.file_id);
                }
                const stats = await fsp.stat(tempFilePath);
                await data.updateFile(fileId, { fileName, size: stats.size, date: Date.now(), file_id: newRelativePath }, userId);
                return res.json({ success: true, fileId: fileId });
            }
        } else if (mode === 'create' && folderId) {
            if (await data.checkFullConflict(fileName, folderId, userId)) {
                return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
            }
            const fileStream = fs.createReadStream(tempFilePath);
            const result = await storage.upload(fileStream, fileName, 'text/plain', userId, folderId);
            res.json({ success: true, fileId: result.fileId });
        } else {
            return res.status(400).json({ success: false, message: '请求参数无效' });
        }
    } catch (error) {
        res.status(500).json({ success: false, message: `伺服器内部错误: ${error.message}` });
    } finally {
        if (fs.existsSync(tempFilePath)) await fsp.unlink(tempFilePath).catch(err => {});
    }
});

app.get('/api/file-info/:id', requireLogin, async (req, res) => {
    try {
        const fileId = parseInt(req.params.id, 10);
        const [fileInfo] = await data.getFilesByIds([fileId], req.session.userId);
        if (fileInfo) res.json(fileInfo);
        else res.status(404).json({ success: false, message: '找不到档案资讯' });
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
            filesToCheck.map(async ({ relativePath }) => {
                const pathParts = (relativePath || '').split('/');
                const fileName = pathParts.pop() || relativePath;
                const targetFolderId = await data.findFolderByPath(initialFolderId, pathParts, userId);
                if (targetFolderId === null) return { name: fileName, relativePath, exists: false, messageId: null };
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
        res.status(500).json({ success: false, message: `检查名称冲突时出错: ${error.message}` });
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

app.get('/api/folder/:encryptedPath', requireLogin, async (req, res) => {
    try {
        const decryptedPath = decrypt(req.params.encryptedPath);
        if (!decryptedPath || !decryptedPath.startsWith('folder/')) {
            return res.status(400).json({ success: false, message: '无效的资料夹路径' });
        }
        const folderId = parseInt(decryptedPath.split('/')[1], 10);
        if (isNaN(folderId)) return res.status(400).json({ success: false, message: '无效的资料夹 ID' });

        const userId = req.session.userId;
        const folderDetails = await data.getFolderDetails(folderId, userId);
        if (!folderDetails) return res.status(404).json({ success: false, message: '找不到资料夹' });

        const createEncryptedPath = async (id) => {
            const breadcrumb = await data.getFolderPath(id, userId);
            return breadcrumb.map(p => ({ id: encrypt(`folder/${p.id}`), name: p.name }));
        };

        if (folderDetails.is_locked && !req.session.unlockedFolders.includes(folderId)) {
            return res.json({ locked: true, path: await createEncryptedPath(folderId) });
        }

        const contents = await data.getFolderContents(folderId, userId);
        res.json({ contents, path: await createEncryptedPath(folderId) });
    } catch (error) {
        res.status(500).json({ success: false, message: '读取资料夾内容失败。' });
    }
});

app.post('/api/folder', requireLogin, async (req, res) => {
    const { name, parentId } = req.body;
    const userId = req.session.userId;
    if (!name || !parentId) return res.status(400).json({ success: false, message: '缺少资料夾名称或父 ID。' });
    
    try {
        if (await data.checkFullConflict(name, parentId, userId)) {
            return res.status(409).json({ success: false, message: '同目录下已存在同名档案或资料夹。' });
        }
        const result = await data.createFolder(name, parentId, userId);
        const storage = storageManager.getStorage();
        if (storage.type === 'local' || storage.type === 'webdav') {
            const newFolderPathParts = await data.getFolderPath(result.id, userId);
            const newFullPath = path.posix.join(...newFolderPathParts.slice(1).map(p => p.name));
            if (storage.type === 'local') {
                await fsp.mkdir(path.join(__dirname, 'data', 'uploads', String(userId), newFullPath), { recursive: true });
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
        if (!password || password.length < 4) return res.status(400).json({ success: false, message: '密码长度至少需要 4 个字元。' });
        const folder = await data.getFolderDetails(id, userId);
        if (!folder) return res.status(404).json({ success: false, message: '找不到资料夹。' });

        if (folder.is_locked) {
            if (!oldPassword) return res.status(400).json({ success: false, message: '需要提供旧密码才能修改。' });
            if (!await bcrypt.compare(oldPassword, folder.password)) {
                return res.status(401).json({ success: false, message: '旧密码不正确。' });
            }
        }
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        await data.setFolderPassword(id, hashedPassword, userId);
        res.json({ success: true, message: '资料夹密码已设定/更新。' });
    } catch (error) {
        res.status(500).json({ success: false, message: `操作失败：${error.message}` });
    }
});

app.post('/api/folder/:id/unlock', requireLogin, async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;
        const userId = req.session.userId;
        if (!password) return res.status(400).json({ success: false, message: '需要提供密码才能解锁。' });
        if (!await data.verifyFolderPassword(id, password, userId)) {
            return res.status(401).json({ success: false, message: '密码不正确。' });
        }
        await data.setFolderPassword(id, null, userId);
        if (req.session.unlockedFolders) {
            req.session.unlockedFolders = req.session.unlockedFolders.filter(folderId => folderId !== parseInt(id));
        }
        res.json({ success: true, message: '资料夹已成功解锁（移除密码）。' });
    } catch (error) {
        res.status(500).json({ success: false, message: `操作失败：${error.message}` });
    }
});

app.post('/api/folder/:id/verify', requireLogin, async (req, res) => {
    try {
        const { id } = req.params;
        const { password } = req.body;
        const userId = req.session.userId;
        if (await data.verifyFolderPassword(id, password, userId)) {
            if (!req.session.unlockedFolders) req.session.unlockedFolders = [];
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
    res.json(await data.getAllFolders(req.session.userId));
});

app.post('/api/move', requireLogin, async (req, res) => {
    try {
        const { itemIds, targetFolderId, resolutions = {} } = req.body;
        const userId = req.session.userId;
        if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0 || !targetFolderId) {
            return res.status(400).json({ success: false, message: '无效的请求参数。' });
        }
        let moved = 0, skipped = 0, errors = [];
        for (const itemId of itemIds) {
            try {
                const [item] = await data.getItemsByIds([itemId], userId);
                if (!item) { skipped++; continue; }
                const report = await data.moveItem(item.id, item.type, targetFolderId, userId, { resolutions });
                moved += report.moved;
                skipped += report.skipped;
                if (report.errors > 0) errors.push(`项目 "${item.name}" 处理失败。`);
            } catch (err) {
                errors.push(err.message);
            }
        }
        let message = `操作完成。`;
        if (errors.length) message = `操作完成，但出现错误: ${errors.join(', ')}`;
        else if (moved && skipped) message = `操作完成，${moved} 个项目已移动，${skipped} 个项目被跳过。`;
        else if (!moved && skipped) message = "所有选定项目均被跳过。";
        else if (moved) message = `${moved} 个项目移动成功。`;
        res.json({ success: errors.length === 0, message });
    } catch (error) {
        res.status(500).json({ success: false, message: `移动失败：${error.message}` });
    }
});

app.post('/delete-multiple', requireLogin, async (req, res) => {
    const { messageIds = [], folderIds = [] } = req.body;
    const userId = req.session.userId;
    try {
        for(const id of messageIds) await data.unifiedDelete(id, 'file', userId);
        for(const id of folderIds) await data.unifiedDelete(id, 'folder', userId);
        res.json({ success: true, message: '删除成功' });
    } catch (error) {
        res.status(500).json({ success: false, message: `删除失败: ${error.message}` });
    }
});

app.post('/rename', requireLogin, async (req, res) => {
    try {
        const { id, newName, type } = req.body;
        const userId = req.session.userId;
        if (!id || !newName || !type) return res.status(400).json({ success: false, message: '缺少必要参数。'});
        let result;
        if (type === 'file') result = await data.renameFile(parseInt(id, 10), newName, userId);
        else if (type === 'folder') result = await data.renameFolder(parseInt(id, 10), newName, userId);
        else return res.status(400).json({ success: false, message: '无效的项目类型。'});
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: `重命名失败: ${error.message}` });
    }
});

app.get('/thumbnail/:message_id', requireLogin, async (req, res) => {
    try {
        const messageId = parseInt(req.params.message_id, 10);
        if (!await data.isFileAccessible(messageId, req.session.userId, req.session.unlockedFolders)) {
            return res.status(403).send('权限不足');
        }
        const [fileInfo] = await data.getFilesByIds([messageId], req.session.userId);
        if (fileInfo?.storage_type === 'telegram' && fileInfo.thumb_file_id) {
            const link = await storageManager.getStorage().getUrl(fileInfo.thumb_file_id);
            if (link) return res.redirect(link);
        }
        const placeholder = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': placeholder.length }).end(placeholder);
    } catch (error) { res.status(500).send('获取缩图失败'); }
});

async function handleFileStream(req, res, fileInfo) {
    const storage = storageManager.getStorage();
    const { range } = req.headers;
    const totalSize = fileInfo.size;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', fileInfo.mimetype || 'application/octet-stream');
    
    if (range && totalSize) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;
        if (start >= totalSize) return res.status(416).send(`Requested range not satisfiable\n${start} >= ${totalSize}`);
        
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Content-Length': (end - start) + 1,
        });
        if (fileInfo.storage_type === 'telegram') {
            const link = await storage.getUrl(fileInfo.file_id);
            if (!link) return res.status(404).send('无法获取文件链接');
            axios.get(link, { responseType: 'stream', headers: { 'Range': `bytes=${start}-${end}` } }).then(response => response.data.pipe(res));
        } else {
            (await storage.stream(fileInfo.file_id, fileInfo.user_id, { start, end })).pipe(res);
        }
    } else {
        res.setHeader('Content-Length', totalSize || -1);
        const disposition = req.query.download ? 'attachment' : 'inline';
        res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(fileInfo.fileName)}`);
        
        if (fileInfo.storage_type === 'telegram') {
            const link = await storage.getUrl(fileInfo.file_id);
            if (!link) return res.status(404).send('无法获取文件链接');
            axios.get(link, { responseType: 'stream' }).then(response => response.data.pipe(res));
        } else {
            (await storage.stream(fileInfo.file_id, fileInfo.user_id)).pipe(res);
        }
    }
}

app.get('/download/proxy/:message_id', requireLogin, async (req, res) => {
    try {
        const messageId = parseInt(req.params.message_id, 10);
        if (!await data.isFileAccessible(messageId, req.session.userId, req.session.unlockedFolders)) {
            return res.status(403).send('权限不足');
        }
        const [fileInfo] = await data.getFilesByIds([messageId], req.session.userId);
        if (!fileInfo) return res.status(404).send('文件信息未找到');
        await handleFileStream(req, res, fileInfo);
    } catch (error) {
        if (!res.headersSent) res.status(500).send(`下载代理失败: ${error.message}`);
    }
});

app.get('/file/content/:message_id', requireLogin, async (req, res) => {
    try {
        const messageId = parseInt(req.params.message_id, 10);
        if (!await data.isFileAccessible(messageId, req.session.userId, req.session.unlockedFolders)) {
            return res.status(403).send('权限不足');
        }
        const [fileInfo] = await data.getFilesByIds([messageId], req.session.userId);
        if (!fileInfo || !fileInfo.file_id) return res.status(404).send('文件信息未找到');
        
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        if (fileInfo.storage_type === 'telegram') {
            const link = await storageManager.getStorage().getUrl(fileInfo.file_id);
            if (link) axios.get(link, { responseType: 'text' }).then(response => res.send(response.data));
            else res.status(404).send('无法获取文件链接');
        } else {
            (await storageManager.getStorage().stream(fileInfo.file_id, fileInfo.user_id)).pipe(res);
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

        if (!messageIds.length && !folderIds.length) return res.status(400).send('未提供任何项目 ID');
        let filesToArchive = [];
        if (messageIds.length) {
            const directFiles = await data.getFilesByIds(messageIds, userId);
            filesToArchive.push(...directFiles.map(f => ({ ...f, path: f.fileName })));
        }
        for (const folderId of folderIds) {
            const folderInfo = (await data.getFolderPath(folderId, userId)).pop();
            const nestedFiles = await data.getFilesRecursive(folderId, userId, folderInfo ? folderInfo.name : 'folder');
            filesToArchive.push(...nestedFiles);
        }
        if (!filesToArchive.length) return res.status(404).send('找不到任何可下载的档案');
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        res.attachment('download.zip');
        archive.pipe(res);

        for (const file of filesToArchive) {
             if (file.storage_type === 'telegram') {
                const link = await storage.getUrl(file.file_id);
                if (link) archive.append((await axios.get(link, { responseType: 'stream' })).data, { name: file.path });
             } else {
                archive.append(await storage.stream(file.file_id, userId), { name: file.path });
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
        if (!itemId || !itemType || !expiresIn) return res.status(400).json({ success: false, message: '缺少必要参数。' });
        const result = await data.createShareLink(parseInt(itemId, 10), itemType, expiresIn, req.session.userId);
        if (result.success) {
            res.json({ success: true, url: `${req.protocol}://${req.get('host')}/share/view/${itemType}/${result.token}` });
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
        res.json(shares.map(item => ({...item, share_url: `${req.protocol}://${req.get('host')}/share/view/${item.type}/${item.share_token}`})));
    } catch (error) { res.status(500).json({ success: false, message: '获取分享列表失败' }); }
});

app.post('/api/cancel-share', requireLogin, async (req, res) => {
    try {
        const { itemId, itemType } = req.body;
        if (!itemId || !itemType) return res.status(400).json({ success: false, message: '缺少必要参数' });
        res.json(await data.cancelShare(parseInt(itemId, 10), itemType, req.session.userId));
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
        if (!await data.getRootFolder(userId)) throw new Error(`找不到使用者 ${userId} 的根目录`);

        async function scanDirectory(dir) {
            for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
                const fullPath = path.join(dir, entry.name);
                const relativePath = path.relative(userUploadDir, fullPath).replace(/\\/g, '/');
                if (entry.isDirectory()) await scanDirectory(fullPath);
                else {
                    if (await data.findFileByFileId(relativePath, userId)) {
                        log.push({ message: `已存在: ${relativePath}，跳过。`, type: 'info' });
                    } else {
                        const stats = await fsp.stat(fullPath);
                        const folderId = await data.findOrCreateFolderByPath(path.dirname(relativePath).replace(/\\/g, '/'), userId);
                        await data.addFile({
                            message_id: BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000)),
                            fileName: entry.name,
                            mimetype: 'application/octet-stream',
                            size: stats.size,
                            file_id: relativePath,
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
        if (!config.webdav || !config.webdav.url) throw new Error('WebDAV 设定不完整');
        const client = createClient(config.webdav.url, { username: config.webdav.username, password: config.webdav.password });
        
        for (const item of await client.getDirectoryContents('/', { deep: true })) {
            if (item.type === 'file') {
                if (await data.findFileByFileId(item.filename, userId)) {
                    log.push({ message: `已存在: ${item.filename}，跳过。`, type: 'info' });
                } else {
                    const folderId = await data.findOrCreateFolderByPath(path.dirname(item.filename).replace(/\\/g, '/'), userId);
                    await data.addFile({
                        message_id: BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000)),
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
        res.json({ success: true, log });
    } catch (error) {
        let errorMessage = error.message;
        if (error.response?.status === 403) {
            errorMessage = '存取被拒绝 (403 Forbidden)。这通常意味着您的 WebDAV 伺服器不允许列出目录内容。';
            log.push({ message: '扫描失败：无法列出远端目录内容。', type: 'error' });
        }
        log.push({ message: `详细错误: ${errorMessage}`, type: 'error' });
        res.status(500).json({ success: false, message: errorMessage, log });
    }
});

app.get('/share/view/file/:token', async (req, res) => {
    try {
        const fileInfo = await data.getFileByShareToken(req.params.token);
        if (fileInfo) {
            let textContent = null;
            if (fileInfo.mimetype?.startsWith('text/')) {
                const storage = storageManager.getStorage();
                if (fileInfo.storage_type === 'telegram') {
                    const link = await storage.getUrl(fileInfo.file_id);
                    if (link) textContent = (await axios.get(link, { responseType: 'text' })).data;
                } else {
                    const stream = await storage.stream(fileInfo.file_id, fileInfo.user_id);
                    textContent = await new Promise((resolve, reject) => {
                        let data = '';
                        stream.on('data', chunk => data += chunk).on('end', () => resolve(data)).on('error', reject);
                    });
                }
            }
            if (textContent !== null) res.setHeader('Content-Type', 'text/plain; charset=utf-8').send(textContent);
            else res.render('share-view', { file: fileInfo, downloadUrl: `/share/download/file/${req.params.token}`, textContent: null });
        } else {
            res.status(404).render('share-error', { message: '此分享连结无效或已过期。' });
        }
    } catch (error) { res.status(500).render('share-error', { message: '处理分享请求时发生错误。' }); }
});

app.get('/share/view/folder/:token/:path(*)?', async (req, res) => {
    try {
        const { token, path: requestedPath } = req.params;
        const pathSegments = requestedPath ? requestedPath.split('/').filter(p => p) : [];
        const folderInfo = await data.findFolderBySharePath(token, pathSegments);

        if (folderInfo) {
            const breadcrumbPath = await data.getFolderPath(folderInfo.id, folderInfo.user_id);
            const rootShareFolder = await data.getFolderByShareToken(token);
            const rootPathIndex = breadcrumbPath.findIndex(p => p.id === rootShareFolder.id);
            const shareBreadcrumb = breadcrumbPath.slice(rootPathIndex).map((p, index, arr) => ({
                name: p.name,
                link: index < arr.length - 1 ? `/share/view/folder/${token}/${arr.slice(1, index + 1).map(s => s.name).join('/')}` : null
            }));
            res.render('share-folder-view', {
                folder: folderInfo,
                contents: await data.getFolderContents(folderInfo.id, folderInfo.user_id),
                breadcrumb: shareBreadcrumb,
                token: token
            });
        } else {
            res.status(404).render('share-error', { message: '此分享连结无效、已过期或路径不正确。' });
        }
    } catch (error) {
        res.status(500).render('share-error', { message: '处理分享请求时发生错误。' });
    }
});

app.get('/share/download/file/:token', async (req, res) => {
    try {
        const fileInfo = await data.getFileByShareToken(req.params.token);
        if (!fileInfo) return res.status(404).send('文件信息未找到或分享链接已过期');
        await handleFileStream(req, res, fileInfo);
    } catch (error) { 
        if (!res.headersSent) res.status(500).send(`下载失败: ${error.message}`);
    }
});

app.get('/share/thumbnail/:folderToken/:fileId', async (req, res) => {
    try {
        const fileInfo = await data.findFileInSharedFolder(parseInt(req.params.fileId, 10), req.params.folderToken);
        if (fileInfo?.storage_type === 'telegram' && fileInfo.thumb_file_id) {
            const link = await storageManager.getStorage().getUrl(fileInfo.thumb_file_id);
            if (link) return res.redirect(link);
        }
        const placeholder = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': placeholder.length }).end(placeholder);
    } catch (error) {
        res.status(500).send('获取缩图失败');
    }
});

app.get('/share/download/:folderToken/:fileId', async (req, res) => {
    try {
        const fileInfo = await data.findFileInSharedFolder(parseInt(req.params.fileId, 10), req.params.folderToken);
        if (!fileInfo) return res.status(404).send('文件信息未找到或权限不足');
        await handleFileStream(req, res, fileInfo);
    } catch (error) {
        if (!res.headersSent) res.status(500).send(`下载失败: ${error.message}`);
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
        if (!user) return res.status(404).json({ success: false, message: '找不到使用者。' });
        if (!await bcrypt.compare(oldPassword, user.password)) {
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
    if (storageManager.setStorageMode(mode)) res.json({ success: true, message: '设定已储存。' });
    else res.status(400).json({ success: false, message: '无效的模式' });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        res.json(await data.listNormalUsers());
    } catch (error) {
        res.status(500).json({ success: false, message: '获取使用者列表失败。' });
    }
});

app.get('/api/admin/all-users', requireAdmin, async (req, res) => {
    try {
        res.json(await data.listAllUsers());
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
    if (!userId) return res.status(400).json({ success: false, message: '缺少使用者 ID。' });
    try {
        await data.deleteUser(userId);
        res.json({ success: true, message: '使用者已删除。' });
    } catch (error) {
        res.status(500).json({ success: false, message: '删除使用者失败。' });
    }
});

app.get('/api/admin/webdav', requireAdmin, (req, res) => {
    const { webdav = {} } = storageManager.readConfig();
    res.json(webdav.url ? [{ id: 1, ...webdav }] : []);
});

app.post('/api/admin/webdav', requireAdmin, (req, res) => {
    const { url, username, password } = req.body;
    if (!url || !username) return res.status(400).json({ success: false, message: '缺少必要参数' });
    const config = storageManager.readConfig();
    config.webdav = { url, username };
    if (password) config.webdav.password = password;
    if (storageManager.writeConfig(config)) res.json({ success: true, message: 'WebDAV 设定已储存' });
    else res.status(500).json({ success: false, message: '写入设定失败' });
});

app.delete('/api/admin/webdav/:id', requireAdmin, (req, res) => {
    const config = storageManager.readConfig();
    config.webdav = {};
    if (storageManager.writeConfig(config)) res.json({ success: true, message: 'WebDAV 设定已删除' });
    else res.status(500).json({ success: false, message: '删除设定失败' });
});
