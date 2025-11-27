document.addEventListener('DOMContentLoaded', () => {
    // --- 全局拦截器：处理 401 未授权和网络错误 ---
    axios.interceptors.response.use(
        (response) => response,
        (error) => {
            if (error.response && error.response.status === 401) {
                window.location.href = '/login';
                return new Promise(() => {});
            }
            if (!error.response && error.request) {
                window.location.href = '/login';
                return new Promise(() => {});
            }
            return Promise.reject(error);
        }
    );

    // --- 界面调整：移动进度条位置 ---
    const dropZone = document.getElementById('dropZone');
    const dragUploadProgressArea = document.getElementById('dragUploadProgressArea');
    if (dragUploadProgressArea && dropZone) {
        dropZone.parentNode.insertBefore(dragUploadProgressArea, dropZone.nextSibling);
    }

    // --- 输入模式检测 ---
    const body = document.body;
    body.classList.add('using-mouse');
    window.addEventListener('keydown', (e) => {
        if (['Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', ' '].includes(e.key)) {
            body.classList.remove('using-mouse');
            body.classList.add('using-keyboard');
        }
    });
    window.addEventListener('mousemove', () => {
        if (!body.classList.contains('using-mouse')) {
            body.classList.remove('using-keyboard');
            body.classList.add('using-mouse');
        }
    });
    window.addEventListener('mousedown', () => {
        body.classList.remove('using-keyboard');
        body.classList.add('using-mouse');
    });

    // --- DOM 元素获取 ---
    const homeLink = document.getElementById('homeLink');
    const itemGrid = document.getElementById('itemGrid');
    const breadcrumb = document.getElementById('breadcrumb');
    const contextMenu = document.getElementById('contextMenu');
    const selectionInfo = document.getElementById('selectionInfo');
    const multiSelectToggleBtn = document.getElementById('multiSelectToggleBtn');
    const createFolderBtn = document.getElementById('createFolderBtn');
    const searchForm = document.getElementById('searchForm');
    const searchInput = document.getElementById('searchInput');
    const openBtn = document.getElementById('openBtn');
    const previewBtn = document.getElementById('previewBtn');
    const shareBtn = document.getElementById('shareBtn');
    const renameBtn = document.getElementById('renameBtn');
    const moveBtn = document.getElementById('moveBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const textEditBtn = document.getElementById('textEditBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const changePasswordBtn = document.getElementById('changePasswordBtn');
    
    // 模态框
    const previewModal = document.getElementById('previewModal');
    const modalContent = document.getElementById('modalContent');
    const closeModal = document.querySelector('.close-button');
    const moveModal = document.getElementById('moveModal');
    const moveModalTitle = document.getElementById('moveModalTitle');
    const folderTree = document.getElementById('folderTree');
    const confirmMoveBtn = document.getElementById('confirmMoveBtn');
    const cancelMoveBtn = document.getElementById('cancelMoveBtn');
    const conflictModal = document.getElementById('conflictModal');
    const conflictModalTitle = document.getElementById('conflictModalTitle');
    const conflictFileName = document.getElementById('conflictFileName');
    const conflictOptions = document.getElementById('conflictOptions');
    const applyToAllContainer = document.getElementById('applyToAllContainer');
    const applyToAllCheckbox = document.getElementById('applyToAllCheckbox');
    const folderConflictModal = document.getElementById('folderConflictModal');
    const folderConflictName = document.getElementById('folderConflictName');
    const folderConflictOptions = document.getElementById('folderConflictOptions');
    const applyToAllFoldersContainer = document.getElementById('applyToAllFoldersContainer');
    const applyToAllFoldersCheckbox = document.getElementById('applyToAllFoldersCheckbox');
    const shareModal = document.getElementById('shareModal');
    const uploadModal = document.getElementById('uploadModal');
    const showUploadModalBtn = document.getElementById('showUploadModalBtn');
    const closeUploadModalBtn = document.getElementById('closeUploadModalBtn');
    const uploadForm = document.getElementById('uploadForm');
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
    const fileListContainer = document.getElementById('file-selection-list');
    const folderSelect = document.getElementById('folderSelect');
    const uploadNotificationArea = document.getElementById('uploadNotificationArea');
    const dragUploadProgressBar = document.getElementById('dragUploadProgressBar');
    const viewSwitchBtn = document.getElementById('view-switch-btn');
    const itemListView = document.getElementById('itemListView');
    const itemListBody = document.getElementById('itemListBody');
    const contextMenuSeparator1 = document.getElementById('contextMenuSeparator1');
    const contextMenuSeparator2 = document.getElementById('contextMenuSeparator2');
    const contextMenuSeparatorTop = document.getElementById('contextMenuSeparatorTop');
    const lockBtn = document.getElementById('lockBtn');
    const copyBtn = document.getElementById('copyBtn'); // 复制按钮
    
    // 密码模态框
    const passwordModal = document.getElementById('passwordModal');
    const passwordModalTitle = document.getElementById('passwordModalTitle');
    const passwordPromptText = document.getElementById('passwordPromptText');
    const passwordForm = document.getElementById('passwordForm');
    const passwordInput = document.getElementById('passwordInput');
    const oldPasswordContainer = document.getElementById('oldPasswordContainer');
    const oldPasswordInput = document.getElementById('oldPasswordInput');
    const confirmPasswordContainer = document.getElementById('confirmPasswordContainer');
    const confirmPasswordInput = document.getElementById('confirmPasswordInput');
    const passwordSubmitBtn = document.getElementById('passwordSubmitBtn');
    const passwordCancelBtn = document.getElementById('passwordCancelBtn');
    const listHeader = document.querySelector('.list-header');

    // 配额显示
    const quotaContainer = document.getElementById('quotaContainer');
    const quotaText = document.getElementById('quotaText');
    const quotaFill = document.getElementById('quotaFill');

    // --- 状态变量 ---
    let isMultiSelectMode = false;
    let currentFolderId = 1;
    let currentEncryptedFolderId = null;
    let currentFolderContents = { folders: [], files: [] };
    let selectedItems = new Map();
    let moveTargetFolderId = null;
    let moveTargetEncryptedFolderId = null;
    let isSearchMode = false;
    const MAX_TELEGRAM_SIZE = 1000 * 1024 * 1024;
    let foldersLoaded = false;
    let currentView = localStorage.getItem('viewMode') || 'grid';
    let currentSort = { key: 'name', order: 'asc' };
    let lastClickedItemId = null;
    
    // 操作状态
    let isCopyOperation = false;
    let passwordPromise = {};
    let conflictQueue = [];
    let currentConflictResolutions = {};
    let currentConflictCallback = null;

    const EDITABLE_EXTENSIONS = ['.txt', '.md', '.json', '.js', '.css', '.html', '.xml', '.yaml', '.yml', '.log', '.ini', '.cfg', '.conf', '.sh', '.bat', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.go', '.rs', '.ts', '.sql'];

    // --- 辅助函数 ---
    function isEditableFile(fileName) {
        if (!fileName) return false;
        return EDITABLE_EXTENSIONS.some(ext => fileName.toLowerCase().endsWith(ext));
    }

    function isImage(filename) {
        if (!filename) return false;
        const ext = filename.split('.').pop().toLowerCase();
        return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    }

    const formatBytes = (bytes, decimals = 2) => {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
    };
    
    const formatDateTime = (timestamp) => {
        if (!timestamp) return '—';
        return new Date(timestamp).toLocaleString('zh-CN', {
            year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
        }).replace(/\//g, '-');
    };

    function showNotification(message, type = 'info', container = null) {
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.textContent = message;
        if (container) {
            notification.classList.add('local');
            container.innerHTML = '';
            container.appendChild(notification);
        } else {
            notification.classList.add('global');
            const existingNotif = document.querySelector('.notification.global');
            if (existingNotif) existingNotif.remove();
            document.body.appendChild(notification);
            setTimeout(() => { if (notification.parentElement) notification.parentElement.removeChild(notification); }, 5000);
        }
    }

    // --- 配额更新 ---
    async function updateQuota() {
        if (!quotaContainer) return;
        try {
            const res = await axios.get('/api/user/quota');
            const { max, used } = res.data;
            const percent = Math.min(100, (used / max) * 100);
            quotaText.textContent = `${formatBytes(used)} / ${formatBytes(max)}`;
            quotaFill.style.width = `${percent}%`;
            quotaFill.classList.remove('warning', 'danger');
            if (percent > 90) quotaFill.classList.add('danger');
            else if (percent > 70) quotaFill.classList.add('warning');
            quotaContainer.style.display = 'flex';
        } catch (e) {
            quotaContainer.style.display = 'none';
        }
    }

    // --- 上传逻辑 ---
    const performUpload = async (url, formData, isDrag = false) => {
        const progressBar = isDrag ? dragUploadProgressBar : document.getElementById('progressBar');
        const progressArea = isDrag ? dragUploadProgressArea : document.getElementById('progressArea');
        const submitBtn = isDrag ? null : uploadSubmitBtn;
        const notificationContainer = isDrag ? null : uploadNotificationArea;
    
        progressArea.style.display = 'block';
        progressBar.style.width = '0%';
        progressBar.textContent = '0%';
        if (submitBtn) submitBtn.disabled = true;
    
        try {
            const res = await axios.post(url, formData, {
                onUploadProgress: p => {
                    const percent = Math.round((p.loaded * 100) / p.total);
                    progressBar.style.width = percent + '%';
                    progressBar.textContent = percent + '%';
                }
            });
            if (res.data.success) {
                if (!isDrag) uploadModal.style.display = 'none';
                if (res.data.skippedAll) showNotification('没有文件被上传，所有冲突的项目都已被跳过。', 'info');
                else showNotification('上传成功！', 'success');
                fileInput.value = '';
                folderInput.value = '';
                loadFolderContents(currentEncryptedFolderId);
            } else {
                showNotification(`上传失败: ${res.data.message}`, 'error', notificationContainer);
            }
        } catch (error) {
            if (error.response) showNotification('上传失败: ' + (error.response?.data?.message || '服务器错误'), 'error', notificationContainer);
        } finally {
            if (submitBtn) submitBtn.disabled = false;
            setTimeout(() => { progressArea.style.display = 'none'; }, 2000);
        }
    };
    
    const uploadFiles = async (allFilesData, targetFolderId, isDrag = false) => {
        if (allFilesData.length === 0) {
            showNotification('请选择文件或文件夹。', 'error', !isDrag ? uploadNotificationArea : null);
            return;
        }
        const MAX_FILENAME_BYTES = 255; 
        const encoder = new TextEncoder();
        const longFileNames = allFilesData.filter(data => encoder.encode(data.relativePath.split('/').pop()).length > MAX_FILENAME_BYTES);
        if (longFileNames.length > 0) {
            const fileNames = longFileNames.map(data => `"${data.relativePath.split('/').pop()}"`).join(', ');
            showNotification(`部分档名过长 (超过 ${MAX_FILENAME_BYTES} 字节)，无法上传: ${fileNames}`, 'error', !isDrag ? uploadNotificationArea : null);
            return;
        }
        const notificationContainer = isDrag ? null : uploadNotificationArea;
        const oversizedFiles = allFilesData.filter(data => data.file.size > MAX_TELEGRAM_SIZE);
        if (oversizedFiles.length > 0) {
            const fileNames = oversizedFiles.map(data => `"${data.file.name}"`).join(', ');
            showNotification(`文件 ${fileNames} 过大，超过 ${formatBytes(MAX_TELEGRAM_SIZE)} 的限制。`, 'error', notificationContainer);
            return;
        }

        const filesToCheck = allFilesData.map(data => ({ relativePath: data.relativePath }));
        let existenceData = [];
        try {
            const res = await axios.post('/api/check-existence', { files: filesToCheck, folderId: targetFolderId });
            existenceData = res.data.files;
        } catch (error) {
            if (error.response) showNotification(error.response?.data?.message || '检查文件是否存在时出错。', 'error', notificationContainer);
            return;
        }

        const resolutions = {};
        const conflicts = existenceData.filter(f => f.exists).map(f => f.relativePath);
        if (conflicts.length > 0) {
            const conflictResult = await handleConflict(conflicts, '档案');
            if (conflictResult.aborted) {
                showNotification('上传操作已取消。', 'info', notificationContainer);
                return;
            }
            Object.assign(resolutions, conflictResult.resolutions);
        }

        const formData = new FormData();
        allFilesData.forEach(data => formData.append(data.relativePath, data.file));
        const params = new URLSearchParams();
        params.append('folderId', targetFolderId);
        params.append('resolutions', JSON.stringify(resolutions));
        if (!isDrag) {
            const captionInput = document.getElementById('uploadCaption');
            if (captionInput && captionInput.value) params.append('caption', captionInput.value);
        }
        await performUpload(`/upload?${params.toString()}`, formData, isDrag);
    };

    // --- 内容加载 ---
    const loadFolderContents = async (encryptedFolderId) => {
        try {
            isSearchMode = false;
            if (searchInput) searchInput.value = '';
            currentEncryptedFolderId = encryptedFolderId; 
            const res = await axios.get(`/api/folder/${encryptedFolderId}`);
            
            if (res.data.locked) {
                const { password } = await promptForPassword(`资料夾 "${res.data.path[res.data.path.length-1].name}" 已加密`, '请输入密码以存取:');
                if (password === null) { 
                    const parent = res.data.path.length > 1 ? res.data.path[res.data.path.length - 2] : null;
                    if (parent && parent.encrypted_id) history.back();
                    return;
                }
                try {
                    const currentFolderOriginalId = res.data.path[res.data.path.length - 1].id;
                    await axios.post(`/api/folder/${currentFolderOriginalId}/verify`, { password });
                    loadFolderContents(encryptedFolderId);
                } catch (error) {
                    alert('密码错误！');
                    const parent = res.data.path.length > 1 ? res.data.path[res.data.path.length - 2] : null;
                    if (parent && parent.encrypted_id) loadFolderContents(parent.encrypted_id);
                }
                return;
            }

            currentFolderContents = res.data.contents;
            currentFolderId = res.data.path[res.data.path.length - 1].id;
            const currentIds = new Set([...res.data.contents.folders.map(f => String(f.id)), ...res.data.contents.files.map(f => String(f.id))]);
            selectedItems.forEach((_, key) => { if (!currentIds.has(key)) selectedItems.delete(key); });
            
            renderBreadcrumb(res.data.path);
            renderItems(currentFolderContents.folders, currentFolderContents.files);
            updateContextMenu();
            updateQuota();
        } catch (error) {
            itemGrid.innerHTML = '<p>加载内容失败。</p>';
            itemListBody.innerHTML = '<p>加载内容失败。</p>';
        }
    };

    const executeSearch = async (query) => {
        try {
            isSearchMode = true;
            const res = await axios.get(`/api/search?q=${encodeURIComponent(query)}`);
            currentFolderContents = res.data.contents;
            selectedItems.clear();
            renderBreadcrumb(res.data.path);
            renderItems(currentFolderContents.folders, currentFolderContents.files);
            updateContextMenu();
        } catch (error) {
            itemGrid.innerHTML = '<p>搜寻失败。</p>';
            itemListBody.innerHTML = '<p>搜寻失败。</p>';
        }
    };

    const renderBreadcrumb = (path) => {
        breadcrumb.innerHTML = '';
        if(!path || path.length === 0) return;
        path.forEach((p, index) => {
            if (index > 0) breadcrumb.innerHTML += '<span class="separator">/</span>';
            if (p.id === null) { breadcrumb.innerHTML += `<span>${p.name}</span>`; return; }
            const link = document.createElement(index === path.length - 1 && !isSearchMode ? 'span' : 'a');
            link.textContent = p.name === '/' ? '根目录' : p.name;
            if (link.tagName === 'A') {
                link.href = '#';
                link.dataset.encryptedFolderId = p.encrypted_id;
            }
            breadcrumb.appendChild(link);
        });
    };
    
    const sortItems = (folders, files) => {
        const { key, order } = currentSort;
        const direction = order === 'asc' ? 1 : -1;
        const sortedFolders = [...folders].sort((a, b) => key === 'name' ? a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) * direction : a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
        const sortedFiles = [...files].sort((a, b) => {
            if (key === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) * direction;
            if (key === 'size') return (a.size - b.size) * direction;
            if (key === 'date') return (a.date - b.date) * direction;
            return 0;
        });
        return { folders: sortedFolders, files: sortedFiles };
    };
    
    const renderItems = (folders, files) => {
        const parentGrid = itemGrid;
        const parentList = itemListBody;
        parentGrid.innerHTML = '';
        parentList.innerHTML = '';
        const { folders: sortedFolders, files: sortedFiles } = sortItems(folders, files);
        const allItems = [...sortedFolders, ...sortedFiles];
        
        if (allItems.length === 0) {
            const msg = isSearchMode ? '找不到符合条件的文件。' : '这个资料夾是空的。';
            if (currentView === 'grid') parentGrid.innerHTML = `<p>${msg}</p>`;
            else parentList.innerHTML = `<div class="list-item"><p>${msg}</p></div>`;
            return;
        }
        allItems.forEach(item => {
            if (currentView === 'grid') parentGrid.appendChild(createItemCard(item));
            else parentList.appendChild(createListItem(item));
        });
        updateSortIndicator();
    };

    const createItemCard = (item) => {
        const card = document.createElement('div');
        card.className = 'item-card';
        card.dataset.id = item.id;
        card.dataset.type = item.type;
        card.dataset.name = item.name === '/' ? '根目录' : item.name;
        if (item.type === 'folder') {
            card.dataset.isLocked = item.is_locked;
            card.dataset.encryptedFolderId = item.encrypted_id;
        }
        card.setAttribute('tabindex', '0');
        let iconHtml = '';
        if (item.type === 'file') {
            const fullFile = currentFolderContents.files.find(f => f.id === item.id) || item;
            if (fullFile.storage_type === 'telegram' && fullFile.thumb_file_id) iconHtml = `<img src="/thumbnail/${item.id}" alt="缩图" loading="lazy">`;
            else if (fullFile.mimetype && fullFile.mimetype.startsWith('image/')) iconHtml = `<img src="/download/proxy/${item.id}" alt="图片" loading="lazy">`;
            else if (fullFile.mimetype && fullFile.mimetype.startsWith('video/')) iconHtml = `<video src="/download/proxy/${item.id}#t=0.1" preload="metadata" muted></video>`;
            else iconHtml = `<i class="fas ${getFileIconClass(item.mimetype, item.name)}"></i>`;
        } else {
            iconHtml = `<i class="fas ${item.is_locked ? 'fa-lock' : 'fa-folder'}"></i>`;
        }
        card.innerHTML = `<div class="item-icon">${iconHtml}</div><div class="item-info"><h5 title="${item.name}">${item.name === '/' ? '根目录' : item.name}</h5></div>`;
        if (selectedItems.has(String(item.id))) card.classList.add('selected');
        return card;
    };

    const createListItem = (item) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'list-item';
        itemDiv.dataset.id = item.id;
        itemDiv.dataset.type = item.type;
        itemDiv.dataset.name = item.name === '/' ? '根目录' : item.name;
        if (item.type === 'folder') {
            itemDiv.dataset.isLocked = item.is_locked;
            itemDiv.dataset.encryptedFolderId = item.encrypted_id;
        }
        itemDiv.setAttribute('tabindex', '0');
        const icon = item.type === 'folder' ? (item.is_locked ? 'fa-lock' : 'fa-folder') : getFileIconClass(item.mimetype, item.name);
        const name = item.name === '/' ? '根目录' : item.name;
        const size = item.type === 'file' && item.size ? formatBytes(item.size) : '—';
        const date = item.date ? formatDateTime(item.date) : '—';
        itemDiv.innerHTML = `<div class="list-icon"><i class="fas ${icon}"></i></div><div class="list-name" title="${name}">${name}</div><div class="list-size">${size}</div><div class="list-date">${date}</div>`;
        if (selectedItems.has(String(item.id))) itemDiv.classList.add('selected');
        return itemDiv;
    };

    const getFileIconClass = (mimetype, fileName) => {
        const lowerFileName = (fileName || '').toLowerCase();
        const archiveExtensions = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg'];
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff'];
        for (const ext of archiveExtensions) if (lowerFileName.endsWith('.' + ext)) return 'fa-file-archive';
        for (const ext of imageExtensions) if (lowerFileName.endsWith('.' + ext)) return 'fa-file-image';
        if (!mimetype) return 'fa-file';
        if (mimetype.startsWith('image/')) return 'fa-file-image';
        if (mimetype.startsWith('video/')) return 'fa-file-video';
        if (mimetype.startsWith('audio/')) return 'fa-file-audio';
        if (mimetype.includes('pdf')) return 'fa-file-pdf';
        if (mimetype.includes('archive') || mimetype.includes('zip')) return 'fa-file-archive';
        if (mimetype.startsWith('text/')) return 'fa-file-alt';
        return 'fa-file';
    };
    
    const updateContextMenu = (targetItem = null) => {
        const count = selectedItems.size;
        const hasSelection = count > 0;
        const singleSelection = count === 1;
        const firstSelectedItem = hasSelection ? selectedItems.values().next().value : null;
        selectionInfo.textContent = hasSelection ? `已选择 ${count} 个项目` : '';
        selectionInfo.style.display = hasSelection ? 'block' : 'none';
        contextMenuSeparatorTop.style.display = hasSelection ? 'block' : 'none';
    
        const generalButtons = [createFolderBtn, textEditBtn];
        const itemSpecificButtons = [openBtn, previewBtn, moveBtn, shareBtn, renameBtn, downloadBtn, deleteBtn, contextMenuSeparator1, lockBtn, copyBtn];
    
        if (isMultiSelectMode) {
            multiSelectToggleBtn.innerHTML = '<i class="fas fa-times"></i> <span class="button-text">退出多选模式</span>';
            multiSelectToggleBtn.style.display = 'block';
        } else {
            multiSelectToggleBtn.innerHTML = '<i class="fas fa-check-square"></i> <span class="button-text">进入多选模式</span>';
            multiSelectToggleBtn.style.display = !targetItem ? 'block' : 'none';
        }

        if (hasSelection) {
            generalButtons.forEach(btn => btn.style.display = 'none');
            itemSpecificButtons.forEach(btn => btn.style.display = 'flex');
            selectAllBtn.style.display = 'block';
            contextMenuSeparator2.style.display = 'block';
    
            const isSingleEditableFile = singleSelection && firstSelectedItem.type === 'file' && isEditableFile(firstSelectedItem.name);
            textEditBtn.style.display = isSingleEditableFile ? 'flex' : 'none';
            if (isSingleEditableFile) {
                textEditBtn.innerHTML = '<i class="fas fa-edit"></i> <span class="button-text">编辑文件</span>';
                textEditBtn.title = '编辑文字档';
            }
            contextMenuSeparator1.style.display = isSingleEditableFile ? 'block' : 'none';

            const containsLockedFolder = Array.from(selectedItems.keys()).some(id => {
                const itemEl = document.querySelector(`.item-card[data-id="${id}"], .list-item[data-id="${id}"]`);
                return itemEl && itemEl.dataset.type === 'folder' && (itemEl.dataset.isLocked === 'true' || itemEl.dataset.isLocked === '1');
            });
            const isSingleLockedFolder = singleSelection && firstSelectedItem.type === 'folder' && containsLockedFolder;
            
            if(singleSelection){
                openBtn.innerHTML = firstSelectedItem.type === 'folder' ? '<i class="fas fa-folder-open"></i> <span class="button-text">打开</span>' : '<i class="fas fa-external-link-alt"></i> <span class="button-text">打开</span>';
            }
            openBtn.disabled = !singleSelection;
            previewBtn.disabled = !singleSelection || firstSelectedItem.type === 'folder';
            renameBtn.disabled = !singleSelection;
            moveBtn.disabled = count === 0 || isSearchMode || containsLockedFolder;
            copyBtn.disabled = count === 0;
            shareBtn.disabled = !singleSelection || isSingleLockedFolder;
            downloadBtn.disabled = count === 0 || containsLockedFolder;
            deleteBtn.disabled = count === 0 || containsLockedFolder;
            lockBtn.disabled = !singleSelection || firstSelectedItem.type !== 'folder';
            if(singleSelection && firstSelectedItem.type === 'folder'){
                 const isLocked = containsLockedFolder;
                 lockBtn.innerHTML = isLocked ? '<i class="fas fa-unlock"></i> <span class="button-text">管理密码</span>' : '<i class="fas fa-lock"></i> <span class="button-text">加密</span>';
                 lockBtn.title = isLocked ? '修改或移除密码' : '设定密码';
            }
        } else {
            generalButtons.forEach(btn => btn.style.display = 'block');
            itemSpecificButtons.forEach(btn => btn.style.display = 'none');
            selectAllBtn.style.display = 'block';
            contextMenuSeparator2.style.display = 'block';
            textEditBtn.innerHTML = '<i class="fas fa-file-alt"></i> <span class="button-text">新建文件</span>';
            textEditBtn.title = '新建文字档';
        }
    };

    const updateSortIndicator = () => {
        listHeader.querySelectorAll('[data-sort]').forEach(el => {
            el.classList.remove('sort-asc', 'sort-desc');
            const icon = el.querySelector('.sort-icon');
            if(icon) icon.remove();
        });
        const activeHeader = listHeader.querySelector(`[data-sort="${currentSort.key}"]`);
        if (activeHeader) {
            activeHeader.classList.add(currentSort.order === 'asc' ? 'sort-asc' : 'sort-desc');
            const icon = document.createElement('i');
            icon.className = `fas fa-caret-${currentSort.order === 'asc' ? 'up' : 'down'} sort-icon`;
            activeHeader.appendChild(icon);
        }
    };

    const rerenderSelection = () => {
        document.querySelectorAll('.item-card, .list-item').forEach(el => {
            el.classList.toggle('selected', selectedItems.has(el.dataset.id));
        });
    };

    const loadFoldersForSelect = async () => {
        if (foldersLoaded) return;
        try {
            const res = await axios.get('/api/folders');
            const folders = res.data;
            const folderMap = new Map(folders.map(f => [f.id, { ...f, children: [] }]));
            const tree = [];
            folderMap.forEach(f => {
                if (f.parent_id && folderMap.has(f.parent_id)) folderMap.get(f.parent_id).children.push(f);
                else tree.push(f);
            });
            folderSelect.innerHTML = '';
            const buildOptions = (node, prefix = '') => {
                const option = document.createElement('option');
                option.value = node.id;
                option.textContent = prefix + (node.name === '/' ? '根目录' : node.name);
                folderSelect.appendChild(option);
                node.children.sort((a,b) => a.name.localeCompare(b.name)).forEach(child => buildOptions(child, prefix + '　'));
            };
            tree.sort((a,b) => a.name.localeCompare(b.name)).forEach(buildOptions);
            foldersLoaded = true;
        } catch (error) {}
    };
    
    const switchView = (view) => {
        if (view === 'grid') {
            itemGrid.style.display = 'grid';
            itemListView.style.display = 'none';
            viewSwitchBtn.innerHTML = '<i class="fas fa-list"></i>';
            currentView = 'grid';
        } else {
            itemGrid.style.display = 'none';
            itemListView.style.display = 'block';
            viewSwitchBtn.innerHTML = '<i class="fas fa-th"></i>';
            currentView = 'list';
        }
        renderItems(currentFolderContents.folders, currentFolderContents.files);
    };

    async function handleFolderConflict(folderName, totalConflicts) {
        return new Promise((resolve) => {
            folderConflictName.textContent = folderName;
            applyToAllFoldersContainer.style.display = totalConflicts > 1 ? 'block' : 'none';
            applyToAllFoldersCheckbox.checked = false;
            folderConflictModal.style.display = 'flex';
            folderConflictOptions.onclick = (e) => {
                const action = e.target.dataset.action;
                if (!action) return;
                folderConflictModal.style.display = 'none';
                folderConflictOptions.onclick = null;
                resolve({ action, applyToAll: applyToAllFoldersCheckbox.checked });
            };
        });
    }

    async function handleConflict(conflicts, operationType = '档案') {
        const resolutions = {};
        let applyToAllAction = null;
        let aborted = false;
        for (const conflictName of conflicts) {
            if (applyToAllAction) { resolutions[conflictName] = applyToAllAction; continue; }
            const action = await new Promise((resolve) => {
                conflictModalTitle.textContent = `${operationType}冲突`;
                conflictFileName.textContent = conflictName;
                applyToAllContainer.style.display = conflicts.length > 1 ? 'block' : 'none';
                applyToAllCheckbox.checked = false;
                conflictModal.style.display = 'flex';
                conflictOptions.onclick = (e) => {
                    const chosenAction = e.target.dataset.action;
                    if (!chosenAction) return;
                    conflictModal.style.display = 'none';
                    conflictOptions.onclick = null;
                    if (applyToAllCheckbox.checked) applyToAllAction = chosenAction;
                    resolve(chosenAction);
                };
            });
            if (action === 'abort') { aborted = true; break; }
            resolutions[conflictName] = action;
        }
        return { aborted, resolutions };
    }
    
    function promptForPassword(title, text, showOldPassword = false, showConfirm = false) {
        return new Promise((resolve, reject) => {
            passwordPromise.resolve = resolve;
            passwordPromise.reject = reject;
            passwordModalTitle.textContent = title;
            passwordPromptText.textContent = text;
            oldPasswordContainer.style.display = showOldPassword ? 'block' : 'none';
            confirmPasswordContainer.style.display = showConfirm ? 'block' : 'none';
            passwordInput.value = '';
            oldPasswordInput.value = '';
            confirmPasswordInput.value = '';
            passwordModal.style.display = 'flex';
            passwordInput.focus();
        });
    }

    // --- 初始化事件监听器 ---
    function setupEventListeners() {
        passwordForm.addEventListener('submit', (e) => {
            e.preventDefault();
            passwordModal.style.display = 'none';
            passwordPromise.resolve({ password: passwordInput.value, oldPassword: oldPasswordInput.value, confirmPassword: confirmPasswordInput.value });
        });
        passwordCancelBtn.addEventListener('click', () => {
            passwordModal.style.display = 'none';
            passwordPromise.resolve({password: null});
        });

        dropZone.addEventListener('keydown', handleKeyDown);
        dropZone.addEventListener('focusin', (e) => {
            const target = e.target.closest('.item-card, .list-item');
            if (target && body.classList.contains('using-keyboard') && !isMultiSelectMode) {
                selectedItems.clear();
                selectedItems.set(target.dataset.id, { type: target.dataset.type, name: target.dataset.name, encrypted_id: target.dataset.encryptedFolderId });
                rerenderSelection();
                updateContextMenu();
            }
        });

        if (listHeader) {
            listHeader.addEventListener('click', (e) => {
                const target = e.target.closest('[data-sort]');
                if (!target) return;
                const sortKey = target.dataset.sort;
                if (currentSort.key === sortKey) currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
                else { currentSort.key = sortKey; currentSort.order = 'asc'; }
                renderItems(currentFolderContents.folders, currentFolderContents.files);
            });
        }

        if (logoutBtn) logoutBtn.addEventListener('click', () => window.location.href = '/logout');
        if (changePasswordBtn) {
            changePasswordBtn.addEventListener('click', async () => {
                const oldPassword = prompt('请输入您的旧密码：');
                if (!oldPassword) return;
                const newPassword = prompt('请输入您的新密码 (至少 4 个字元)：');
                if (!newPassword) return;
                if (newPassword.length < 4) { alert('密码长度至少需要 4 个字元。'); return; }
                const confirmPassword = prompt('请再次输入新密码以确认：');
                if (newPassword !== confirmPassword) { alert('两次输入的密码不一致！'); return; }
                try {
                    const res = await axios.post('/api/user/change-password', { oldPassword, newPassword });
                    if (res.data.success) alert('密码修改成功！');
                } catch (error) { alert('密码修改失败：' + (error.response?.data?.message || '服务器错误')); }
            });
        }
        if (fileInput) fileInput.addEventListener('change', () => {
            fileListContainer.innerHTML = '';
            if (fileInput.files.length > 0) {
                for (const file of fileInput.files) {
                    const li = document.createElement('li');
                    li.textContent = file.name;
                    fileListContainer.appendChild(li);
                }
                uploadSubmitBtn.style.display = 'block';
                folderInput.value = '';
            }
        });
        if (folderInput) folderInput.addEventListener('change', (e) => {
            const files = e.target.files;
            if (files.length > 0) {
                const folderName = files[0].webkitRelativePath.split('/')[0];
                fileListContainer.innerHTML = `<li>已选择文件夹: <b>${folderName}</b> (包含 ${files.length} 个文件)</li>`;
                uploadSubmitBtn.style.display = 'block';
                fileInput.value = '';
            }
        });
        if (uploadForm) uploadForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const filesToProcess = folderInput.files.length > 0 ? folderInput.files : fileInput.files;
            const targetFolderId = folderSelect.value;
            const allFilesData = Array.from(filesToProcess).map(f => ({ relativePath: f.webkitRelativePath || f.name, file: f }));
            uploadFiles(allFilesData, targetFolderId, false);
        });

        if (dropZone) {
            dropZone.addEventListener('click', (e) => {
                if (!e.target.closest('.item-card') && !e.target.closest('.list-item')) {
                     clearSelection();
                     hideContextMenu();
                }
            });
            dropZone.addEventListener('contextmenu', e => {
                e.preventDefault();
                const targetItem = e.target.closest('.item-card, .list-item');
                if (targetItem && !isMultiSelectMode && !e.ctrlKey && !e.metaKey) {
                    if (!selectedItems.has(targetItem.dataset.id)) {
                        selectedItems.clear();
                        selectedItems.set(targetItem.dataset.id, { type: targetItem.dataset.type, name: targetItem.dataset.name, encrypted_id: targetItem.dataset.encryptedFolderId });
                        rerenderSelection();
                    }
                } else if (!targetItem && !isMultiSelectMode) {
                    selectedItems.clear();
                    rerenderSelection();
                }
                updateContextMenu(targetItem);
                contextMenu.style.display = 'flex';
                const { clientX: mouseX, clientY: mouseY } = e;
                const { x, y } = dropZone.getBoundingClientRect();
                let menuX = mouseX - x;
                let menuY = mouseY - y + dropZone.scrollTop;
                const menuWidth = contextMenu.offsetWidth;
                const menuHeight = contextMenu.offsetHeight;
                const dropZoneWidth = dropZone.clientWidth;
                if (menuX + menuWidth > dropZoneWidth) menuX = dropZoneWidth - menuWidth - 5;
                if (menuY + menuHeight > dropZone.scrollHeight) menuY = dropZone.scrollHeight - menuHeight - 5;
                if (menuY < dropZone.scrollTop) menuY = dropZone.scrollTop;
                contextMenu.style.top = `${menuY}px`;
                contextMenu.style.left = `${menuX}px`;
            });
            window.addEventListener('click', (e) => { if (!contextMenu.contains(e.target)) contextMenu.style.display = 'none'; });
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => dropZone.addEventListener(eventName, (e) => { e.preventDefault(); e.stopPropagation(); }));
            ['dragenter', 'dragover'].forEach(eventName => dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover')));
            ['dragleave', 'drop'].forEach(eventName => dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover')));
            dropZone.addEventListener('drop', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                dropZone.classList.remove('dragover');
                const items = e.dataTransfer.items;
                if (!items || items.length === 0) return;
                const getFileWithRelativePath = (entry) => {
                    return new Promise((resolve, reject) => {
                        if (entry.isFile) entry.file(file => resolve([{ relativePath: entry.fullPath.substring(1), file: file }]), err => reject(err));
                        else if (entry.isDirectory) {
                            const dirReader = entry.createReader();
                            let allEntries = [];
                            const readEntries = () => dirReader.readEntries(async (entries) => {
                                if (entries.length === 0) resolve((await Promise.all(allEntries.map(getFileWithRelativePath))).flat());
                                else { allEntries.push(...entries); readEntries(); }
                            }, err => reject(err));
                            readEntries();
                        } else resolve([]);
                    });
                };
                try {
                    const entries = Array.from(items).map(item => item.webkitGetAsEntry());
                    const allFilesData = (await Promise.all(entries.map(getFileWithRelativePath))).flat().filter(Boolean);
                    if (allFilesData.length > 0) uploadFiles(allFilesData, currentFolderId, true);
                    else showNotification('找不到可上传的文件。', 'warn');
                } catch (error) { showNotification('读取拖放的文件夹时出错。', 'error'); }
            });
        }

        if (homeLink) homeLink.addEventListener('click', (e) => { e.preventDefault(); window.history.pushState(null, '', '/'); window.location.href = '/'; });
        if (itemGrid) { itemGrid.addEventListener('click', handleItemClick); itemGrid.addEventListener('dblclick', handleItemDblClick); }
        if (itemListBody) { itemListBody.addEventListener('click', handleItemClick); itemListBody.addEventListener('dblclick', handleItemDblClick); }
        if (viewSwitchBtn) viewSwitchBtn.addEventListener('click', () => switchView(currentView === 'grid' ? 'list' : 'grid'));
        if (multiSelectToggleBtn) multiSelectToggleBtn.addEventListener('click', () => {
            isMultiSelectMode = !isMultiSelectMode;
            document.body.classList.toggle('selection-mode-active', isMultiSelectMode);
            if (!isMultiSelectMode) { selectedItems.clear(); rerenderSelection(); }
            updateContextMenu();
            contextMenu.style.display = 'none';
        });
        if (breadcrumb) breadcrumb.addEventListener('click', e => {
            e.preventDefault();
            const link = e.target.closest('a');
            if (link && link.dataset.encryptedFolderId) {
                const encryptedId = link.dataset.encryptedFolderId;
                window.history.pushState(null, '', `/view/${encryptedId}`);
                loadFolderContents(encryptedId);
            }
        });
        window.addEventListener('popstate', () => {
            if (document.getElementById('itemGrid')) {
                const pathParts = window.location.pathname.split('/');
                const viewIndex = pathParts.indexOf('view');
                if (viewIndex !== -1 && pathParts.length > viewIndex + 1) loadFolderContents(pathParts[viewIndex + 1]);
                else window.location.href = '/';
            }
        });
        if (createFolderBtn) createFolderBtn.addEventListener('click', async () => {
            contextMenu.style.display = 'none';
            const name = prompt('请输入新资料夾的名称：');
            if (name && name.trim()) {
                try {
                    await axios.post('/api/folder', { name: name.trim(), parentId: currentFolderId });
                    foldersLoaded = false; 
                    loadFolderContents(currentEncryptedFolderId);
                } catch (error) { alert(error.response?.data?.message || '建立失败'); }
            }
        });
        if (searchForm) searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const query = searchInput.value.trim();
            if (query) executeSearch(query);
            else if(isSearchMode) loadFolderContents(currentEncryptedFolderId);
        });
        if (selectAllBtn) selectAllBtn.addEventListener('click', () => {
            contextMenu.style.display = 'none';
            const allVisibleItems = [...currentFolderContents.folders, ...currentFolderContents.files];
            const allVisibleIds = allVisibleItems.map(item => String(item.id));
            const isAllSelected = allVisibleItems.length > 0 && allVisibleIds.every(id => selectedItems.has(id));
            if (isAllSelected) selectedItems.clear();
            else allVisibleItems.forEach(item => selectedItems.set(String(item.id), { type: item.type, name: item.name, encrypted_id: item.encrypted_id }));
            rerenderSelection();
            updateContextMenu();
        });
        if (showUploadModalBtn) showUploadModalBtn.addEventListener('click', async () => {
            await loadFoldersForSelect();
            folderSelect.value = currentFolderId;
            uploadNotificationArea.innerHTML = '';
            uploadForm.reset();
            fileListContainer.innerHTML = '';
            uploadSubmitBtn.style.display = 'block';
            uploadModal.style.display = 'flex';
        });
        if (closeUploadModalBtn) closeUploadModalBtn.addEventListener('click', () => uploadModal.style.display = 'none');
        
        if (shareBtn && shareModal) {
            const expiresInSelect = document.getElementById('expiresInSelect');
            const customExpiresInput = document.getElementById('customExpiresInput');
            const confirmShareBtn = document.getElementById('confirmShareBtn');
            const cancelShareBtn = document.getElementById('cancelShareBtn');
            const shareLinkContainer = document.getElementById('shareLinkContainer');
            const copyLinkBtn = document.getElementById('copyLinkBtn');
            const closeShareModalBtn = document.getElementById('closeShareModalBtn');
            const sharePasswordInput = document.getElementById('sharePasswordInput');
            const shareOptions = document.getElementById('shareOptions');
            const shareResult = document.getElementById('shareResult');
        
            expiresInSelect.addEventListener('change', () => {
                if (expiresInSelect.value === 'custom') {
                    customExpiresInput.style.display = 'block';
                    const now = new Date();
                    now.setHours(now.getHours() + 1);
                    customExpiresInput.value = now.toISOString().slice(0,16);
                } else customExpiresInput.style.display = 'none';
            });
            shareBtn.addEventListener('click', () => {
                if (shareBtn.disabled) return;
                contextMenu.style.display = 'none';
                shareOptions.style.display = 'block';
                shareResult.style.display = 'none';
                sharePasswordInput.value = '';
                expiresInSelect.value = '24h';
                customExpiresInput.style.display = 'none';
                shareModal.style.display = 'flex';
            });
            cancelShareBtn.addEventListener('click', () => shareModal.style.display = 'none');
            closeShareModalBtn.addEventListener('click', () => shareModal.style.display = 'none');
            confirmShareBtn.addEventListener('click', async () => {
                const [itemId, item] = selectedItems.entries().next().value;
                const payload = { itemId, itemType: item.type, expiresIn: expiresInSelect.value, password: sharePasswordInput.value };
                if (payload.expiresIn === 'custom') {
                    payload.customExpiresAt = new Date(customExpiresInput.value).getTime();
                    if (isNaN(payload.customExpiresAt) || payload.customExpiresAt <= Date.now()) { alert('无效时间'); return; }
                }
                try {
                    const res = await axios.post('/share', payload);
                    if (res.data.success) {
                        shareLinkContainer.textContent = res.data.url;
                        shareOptions.style.display = 'none';
                        shareResult.style.display = 'block';
                    } else alert('创建失败: ' + res.data.message);
                } catch { alert('请求失败'); }
            });
            copyLinkBtn.addEventListener('click', () => navigator.clipboard.writeText(shareLinkContainer.textContent).then(() => {
                copyLinkBtn.textContent = '已复制!'; setTimeout(() => copyLinkBtn.textContent = '复制链接', 2000);
            }));
        }
        
        if (previewBtn) previewBtn.addEventListener('click', async () => {
            if (previewBtn.disabled) return;
            contextMenu.style.display = 'none';
            const messageId = selectedItems.keys().next().value;
            const file = currentFolderContents.files.find(f => String(f.id) === messageId);
            if (!file) return;
            previewModal.style.display = 'flex';
            modalContent.innerHTML = '正在加载预览...';
            const downloadUrl = `/download/proxy/${messageId}`;
            if (file.mimetype && file.mimetype.startsWith('image/')) modalContent.innerHTML = `<img src="${downloadUrl}" alt="预览">`;
            else if (file.mimetype && file.mimetype.startsWith('video/')) modalContent.innerHTML = `<video src="${downloadUrl}" controls autoplay></video>`;
            else if (file.mimetype && (file.mimetype.startsWith('text/') || isEditableFile(file.name))) {
                try {
                    const res = await axios.get(`/file/content/${messageId}`);
                    const escaped = res.data.replace(/&/g, "&amp;").replace(/</g, "&lt;");
                    modalContent.innerHTML = `<pre><code>${escaped}</code></pre>`;
                } catch { modalContent.innerHTML = '无法载入内容。'; }
            } else modalContent.innerHTML = `<div class="no-preview"><i class="fas fa-file"></i><p>不支持预览</p><a href="${downloadUrl}" class="upload-link-btn" download>下载</a></div>`;
        });

        if (openBtn) openBtn.addEventListener('click', () => {
            if (openBtn.disabled) return;
            contextMenu.style.display = 'none';
            const [id, item] = selectedItems.entries().next().value;
            if (item.type === 'folder') {
                const el = document.querySelector(`.item-card[data-id="${id}"], .list-item[data-id="${id}"]`);
                if (el) handleItemDblClick({ target: el });
            } else previewBtn.click();
        });

        if (renameBtn) renameBtn.addEventListener('click', async () => {
             if (renameBtn.disabled) return;
             contextMenu.style.display = 'none';
             const [id, item] = selectedItems.entries().next().value;
             const newName = prompt('新名称:', item.name);
             if (newName && newName.trim() && newName !== item.name) {
                 try {
                    await axios.post('/rename', { id, newName: newName.trim(), type: item.type });
                    loadFolderContents(currentEncryptedFolderId);
                 } catch (error) { alert('重命名失败'); }
             }
        });

        if (downloadBtn) downloadBtn.addEventListener('click', async () => {
            if (downloadBtn.disabled) return;
            contextMenu.style.display = 'none';
            const messageIds = [], folderIds = [];
            selectedItems.forEach((item, id) => item.type === 'file' ? messageIds.push(id) : folderIds.push(parseInt(id)));
            if (messageIds.length === 0 && folderIds.length === 0) return;
            if (messageIds.length === 1 && folderIds.length === 0) { window.location.href = `/download/proxy/${messageIds[0]}`; return; }
            try {
                const res = await axios.post('/api/download-archive', { messageIds, folderIds }, { responseType: 'blob' });
                const url = window.URL.createObjectURL(new Blob([res.data]));
                const link = document.createElement('a');
                link.href = url;
                link.setAttribute('download', `download-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
                document.body.appendChild(link); link.click(); document.body.removeChild(link);
            } catch { alert('下载失败'); }
        });

        if (deleteBtn) deleteBtn.addEventListener('click', async () => {
            if (selectedItems.size === 0) return;
            contextMenu.style.display = 'none';
            if (!confirm(`确定要删除选中的 ${selectedItems.size} 个项目吗？`)) return;
            const filesToDelete = [], foldersToDelete = [];
            selectedItems.forEach((item, id) => item.type === 'file' ? filesToDelete.push(id) : foldersToDelete.push(parseInt(id)));
            try {
                await axios.post('/delete-multiple', { messageIds: filesToDelete, folderIds: foldersToDelete });
                loadFolderContents(currentEncryptedFolderId);
                updateQuota();
            } catch { alert('删除失败'); }
        });

        // 移动/复制
        if (moveBtn) moveBtn.addEventListener('click', () => { if (selectedItems.size > 0) openMoveCopyModal(false); });
        if (copyBtn) copyBtn.addEventListener('click', () => { if (selectedItems.size > 0) openMoveCopyModal(true); });
        if (folderTree) folderTree.addEventListener('click', e => {
            const target = e.target.closest('.folder-item');
            if (!target || target.style.cursor === 'not-allowed') return;
            const prev = folderTree.querySelector('.folder-item.selected');
            if (prev) prev.classList.remove('selected');
            target.classList.add('selected');
            moveTargetFolderId = parseInt(target.dataset.folderId);
            moveTargetEncryptedFolderId = target.dataset.encryptedFolderId;
            confirmMoveBtn.disabled = false;
        });
        if (cancelMoveBtn) cancelMoveBtn.addEventListener('click', () => moveModal.style.display = 'none');
        
        if (confirmMoveBtn) {
            confirmMoveBtn.addEventListener('click', async () => {
                if (!moveTargetFolderId) return;
                const resolutions = {};
                let isAborted = false, applyToAllFolderAction = null;

                async function resolveConflictsRecursively(itemsToMove, currentTargetFolderId, currentTargetEncryptedFolderId, pathPrefix = '') {
                    if (isAborted) return;
                    const checkRes = await axios.post('/api/check-move-conflict', { itemIds: itemsToMove.map(item => item.id), targetFolderId: currentTargetFolderId });
                    const { fileConflicts, folderConflicts } = checkRes.data;
                    const destRes = await axios.get(`/api/folder/${currentTargetEncryptedFolderId}`);
                    const destFolderMap = new Map(destRes.data.contents.folders.map(f => [f.name, { id: f.id, encrypted_id: f.encrypted_id }]));

                    for (const folderName of folderConflicts) {
                        const fullPath = pathPrefix ? `${pathPrefix}/${folderName}` : folderName;
                        let action;
                        if(applyToAllFolderAction) action = applyToAllFolderAction;
                        else {
                            const result = await handleFolderConflict(fullPath, folderConflicts.length);
                            action = result.action;
                            if(result.applyToAll) applyToAllFolderAction = action;
                        }
                        if (action === 'abort') { isAborted = true; return; }
                        resolutions[fullPath] = action;
                        if (action === 'merge') {
                            const sourceFolder = itemsToMove.find(item => item.name === folderName && item.type === 'folder');
                            const destData = destFolderMap.get(folderName);
                            if (sourceFolder && destData) {
                                const srcRes = await axios.get(`/api/folder/${sourceFolder.encrypted_id}`);
                                const subItems = [...srcRes.data.contents.folders, ...srcRes.data.contents.files].map(item => ({
                                    id: item.id, name: item.name, type: item.type, encrypted_id: item.encrypted_id
                                }));
                                if(subItems.length > 0) await resolveConflictsRecursively(subItems, destData.id, destData.encrypted_id, fullPath);
                                if (isAborted) return;
                            }
                        }
                    }
                    if (fileConflicts.length > 0) {
                        const result = await handleConflict(fileConflicts.map(n => pathPrefix ? `${pathPrefix}/${n}` : n), '档案');
                        if (result.aborted) { isAborted = true; return; }
                        Object.assign(resolutions, result.resolutions);
                    }
                }

                try {
                    const topItems = Array.from(selectedItems.entries()).map(([id, item]) => ({
                        id: item.type === 'file' ? id : parseInt(id), type: item.type, name: item.name, encrypted_id: item.encrypted_id
                    }));
                    confirmMoveBtn.textContent = "处理中...";
                    confirmMoveBtn.disabled = true;
                    await resolveConflictsRecursively(topItems, moveTargetFolderId, moveTargetEncryptedFolderId);
                    if (isAborted) { moveModal.style.display = 'none'; showNotification('已取消', 'info'); return; }
                    
                    const endpoint = isCopyOperation ? '/api/copy' : '/api/move';
                    const res = await axios.post(endpoint, { itemIds: topItems.map(i => i.id), targetFolderId: moveTargetFolderId, resolutions });
                    
                    moveModal.style.display = 'none';
                    loadFolderContents(currentEncryptedFolderId);
                    updateQuota();
                    showNotification(res.data.message || (isCopyOperation ? '复制成功' : '移动成功'), 'success');
                } catch (e) {
                    moveModal.style.display = 'none';
                    alert('操作失败：' + (e.response?.data?.message || e.message));
                } finally {
                    confirmMoveBtn.disabled = false;
                    confirmMoveBtn.textContent = isCopyOperation ? "确定复制" : "确定移动";
                }
            });
        }

        if (closeModal) closeModal.onclick = () => { previewModal.style.display = 'none'; modalContent.innerHTML = ''; };
        if (cancelMoveBtn) cancelMoveBtn.addEventListener('click', () => moveModal.style.display = 'none');
        if (textEditBtn) textEditBtn.addEventListener('click', () => {
            contextMenu.style.display = 'none';
            if (selectedItems.size === 0) window.open(`/editor?mode=create&folderId=${currentFolderId}`, '_blank');
            else if (selectedItems.size === 1) window.open(`/editor?mode=edit&fileId=${selectedItems.keys().next().value}`, '_blank');
        });
        
        if (lockBtn) lockBtn.addEventListener('click', async () => {
            contextMenu.style.display = 'none';
            const [id, item] = selectedItems.entries().next().value;
            const folderId = parseInt(id);
            const isLocked = document.querySelector(`.item-card[data-id="${id}"], .list-item[data-id="${id}"]`).dataset.isLocked === 'true';
            
            if (isLocked) {
                const action = prompt('请输入 "change" 修改密码，或 "unlock" 移除密码。');
                if (action === 'unlock') {
                    const { password } = await promptForPassword('移除密码', '输入密码以移除加密:');
                    if (!password) return;
                    try { await axios.post(`/api/folder/${folderId}/unlock`, { password }); showNotification('已移除密码', 'success'); loadFolderContents(currentEncryptedFolderId); } catch { alert('失败'); }
                } else if (action === 'change') {
                    const { password, oldPassword, confirmPassword } = await promptForPassword('修改密码', '新密码:', true, true);
                    if (!password) return;
                    if (password !== confirmPassword) { alert('密码不匹配'); return; }
                    try { await axios.post(`/api/folder/${folderId}/lock`, { oldPassword, password }); showNotification('修改成功', 'success'); } catch { alert('失败'); }
                }
            } else {
                const { password, confirmPassword } = await promptForPassword('加密资料夾', '新密码:', false, true);
                if (!password) return;
                if (password !== confirmPassword) { alert('密码不匹配'); return; }
                try { await axios.post(`/api/folder/${folderId}/lock`, { password }); showNotification('加密成功', 'success'); loadFolderContents(currentEncryptedFolderId); } catch { alert('失败'); }
            }
        });

        window.addEventListener('click', (e) => {
            if (e.target === previewModal) { previewModal.style.display = 'none'; modalContent.innerHTML = ''; }
            if (e.target === uploadModal) uploadModal.style.display = 'none';
            if (e.target === moveModal) moveModal.style.display = 'none';
            if (e.target === shareModal) shareModal.style.display = 'none';
            if (e.target === passwordModal) { passwordModal.style.display = 'none'; if(passwordPromise.resolve) passwordPromise.resolve({password:null}); }
        });
        window.addEventListener('message', (event) => { if (event.data === 'refresh-files') loadFolderContents(currentEncryptedFolderId); });
    }

    // --- 移动/复制模态框 ---
    function openMoveCopyModal(isCopy) {
        isCopyOperation = isCopy;
        moveModalTitle.textContent = isCopy ? "复制到..." : "移动到...";
        confirmMoveBtn.textContent = isCopy ? "确定复制" : "确定移动";
        moveTargetFolderId = null;
        confirmMoveBtn.disabled = true;
        moveModal.style.display = 'flex';
        renderFolderTree();
    }
    
    async function renderFolderTree() {
        folderTree.innerHTML = '<div class="loading">加载文件夹...</div>';
        try {
            const res = await axios.get('/api/folders');
            const folders = res.data;
            const root = folders.find(f => !f.parent_id);
            if (!root) { folderTree.innerHTML = '无可用文件夹'; return; }
            
            const folderMap = new Map(folders.map(f => [f.id, { ...f, children: [] }]));
            folders.forEach(f => { if(f.parent_id) folderMap.get(f.parent_id)?.children.push(f); });
            
            const disabledIds = new Set();
            if (!isCopyOperation) {
                selectedItems.forEach((item, id) => {
                    if (item.type === 'folder') {
                        const fid = parseInt(id);
                        disabledIds.add(fid);
                        const disableChildren = (pid) => folderMap.get(pid)?.children.forEach(c => { disabledIds.add(c.id); disableChildren(c.id); });
                        disableChildren(fid);
                    }
                });
            }

            const buildHtml = (node, level) => {
                let html = `<div class="folder-item" data-folder-id="${node.id}" data-encrypted-folder-id="${node.encrypted_id}" style="padding-left:${level*20}px; color:${disabledIds.has(node.id) ? '#ccc' : 'inherit'}; cursor:${disabledIds.has(node.id) ? 'not-allowed' : 'pointer'}"><i class="fas fa-folder"></i> ${node.name==='/'?'根目录':node.name}</div>`;
                node.children.sort((a,b)=>a.name.localeCompare(b.name)).forEach(c => html += buildHtml(folderMap.get(c.id), level+1));
                return html;
            };
            folderTree.innerHTML = buildHtml(folderMap.get(root.id), 0);
        } catch { folderTree.innerHTML = '加载失败'; }
    }

    const handleItemClick = (e) => {
        const target = e.target.closest('.item-card, .list-item');
        if (!target) return;
        const id = target.dataset.id;
        if (isMultiSelectMode || e.ctrlKey || e.metaKey) {
            if (selectedItems.has(id)) selectedItems.delete(id);
            else selectedItems.set(id, { type: target.dataset.type, name: target.dataset.name, encrypted_id: target.dataset.encryptedFolderId });
        } else {
            selectedItems.clear();
            selectedItems.set(id, { type: target.dataset.type, name: target.dataset.name, encrypted_id: target.dataset.encryptedFolderId });
        }
        rerenderSelection();
        updateContextMenu();
    };

    const handleItemDblClick = async (e) => {
        if (isMultiSelectMode) return;
        const target = e.target.closest('.item-card, .list-item');
        if (target && target.dataset.type === 'folder') {
            if (!target.dataset.encryptedFolderId) return;
            if (target.dataset.isLocked === 'true') {
                try {
                    const { password } = await promptForPassword(`资料夾已加密`, '请输入密码:');
                    if (!password) return;
                    await axios.post(`/api/folder/${target.dataset.id}/verify`, { password });
                    window.history.pushState(null, '', `/view/${target.dataset.encryptedFolderId}`);
                    loadFolderContents(target.dataset.encryptedFolderId);
                } catch { alert('验证失败'); }
            } else {
                window.history.pushState(null, '', `/view/${target.dataset.encryptedFolderId}`);
                loadFolderContents(target.dataset.encryptedFolderId);
            }
        } else if (target) previewBtn.click();
    };

    const handleKeyDown = (e) => {
        const el = document.activeElement;
        if (!el || (!el.classList.contains('item-card') && !el.classList.contains('list-item'))) return;
        if (e.key === 'Enter') { e.preventDefault(); handleItemDblClick({ target: el }); }
        else if (e.key === ' ') { e.preventDefault(); handleItemClick({ target: el, ctrlKey: true }); }
        else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            const items = Array.from(dropZone.querySelectorAll('.item-card:not([style*="display: none"]), .list-item:not([style*="display: none"])'));
            const idx = items.indexOf(el);
            let next = idx;
            if (currentView === 'grid') {
                const cols = window.getComputedStyle(itemGrid).gridTemplateColumns.split(' ').length;
                if (e.key === 'ArrowUp') next -= cols;
                if (e.key === 'ArrowDown') next += cols;
                if (e.key === 'ArrowLeft') next -= 1;
                if (e.key === 'ArrowRight') next += 1;
            } else {
                if (e.key === 'ArrowUp') next -= 1;
                if (e.key === 'ArrowDown') next += 1;
            }
            if (next >= 0 && next < items.length) items[next].focus();
        }
    };

    // --- 初始化调用 ---
    setupEventListeners();
    setupDragAndDrop();
    updateViewModeUI();
    updateQuota();

    if (document.getElementById('itemGrid')) {
        const pathParts = window.location.pathname.split('/');
        const viewIndex = pathParts.indexOf('view');
        if (viewIndex !== -1 && pathParts.length > viewIndex + 1) loadFolderContents(pathParts[viewIndex + 1]);
        else window.location.href = '/';
    }
});
