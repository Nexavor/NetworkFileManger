document.addEventListener('DOMContentLoaded', () => {
    // --- 关键修正：将进度条从DOM中移到文件显示区外部 ---
    const dropZone = document.getElementById('dropZone');
    const container = document.querySelector('.container');
    const dragUploadProgressArea = document.getElementById('dragUploadProgressArea');
    if (container && dragUploadProgressArea && dropZone) {
        // 将进度条元素移动到 #dropZone 之后，成为其兄弟元素
        dropZone.parentNode.insertBefore(dragUploadProgressArea, dropZone.nextSibling);
    }
    // --- 修正结束 ---

    // 追踪最后互动方式 (滑鼠 vs 键盘)
    const body = document.body;
    body.classList.add('using-mouse'); // 预设是滑鼠

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

    // DOM 元素
    const homeLink = document.getElementById('homeLink');
    const itemGrid = document.getElementById('itemGrid');
    const breadcrumb = document.getElementById('breadcrumb');
    const contextMenu = document.getElementById('contextMenu');
    const selectionInfo = document.getElementById('selectionInfo');
    const multiSelectToggleBtn = document.getElementById('multiSelectToggleBtn');
    const createFolderBtn = document.getElementById('createFolderBtn');
    const searchForm = document.getElementById('searchForm');
    const searchInput = document.getElementById('searchInput');
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
    const previewModal = document.getElementById('previewModal');
    const modalContent = document.getElementById('modalContent');
    const closeModal = document.querySelector('.close-button');
    const moveModal = document.getElementById('moveModal');
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

    // 状态
    let isMultiSelectMode = false;
    let currentFolderId = 1;
    let currentEncryptedFolderId = null;
    let currentFolderContents = { folders: [], files: [] };
    let selectedItems = new Map();
    let moveTargetFolderId = null;
    let moveTargetEncryptedFolderId = null; // 修正：新增状态以储存加密ID
    let isSearchMode = false;
    const MAX_TELEGRAM_SIZE = 1000 * 1024 * 1024;
    let foldersLoaded = false;
    let currentView = 'grid';
    let currentSort = {
        key: 'name',
        order: 'asc' 
    };
    
    let passwordPromise = {};

    const EDITABLE_EXTENSIONS = [
        '.txt', '.md', '.json', '.js', '.css', '.html', '.xml', '.yaml', '.yml', 
        '.log', '.ini', '.cfg', '.conf', '.sh', '.bat', '.py', '.java', '.c', 
        '.cpp', '.h', '.hpp', '.cs', '.php', '.rb', '.go', '.rs', '.ts', '.sql'
    ];

    function isEditableFile(fileName) {
        if (!fileName) return false;
        const lowerCaseFileName = fileName.toLowerCase();
        return EDITABLE_EXTENSIONS.some(ext => lowerCaseFileName.endsWith(ext));
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
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
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
            setTimeout(() => {
                if (notification.parentElement) notification.parentElement.removeChild(notification);
            }, 5000);
        }
    }
    
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
                if (!isDrag) {
                    uploadModal.style.display = 'none';
                }
                if (res.data.skippedAll) {
                    showNotification('没有文件被上传，所有冲突的项目都已被跳过。', 'info');
                } else {
                    showNotification('上传成功！', 'success');
                }
                fileInput.value = '';
                folderInput.value = '';
                loadFolderContents(currentEncryptedFolderId);
            } else {
                showNotification(`上传失败: ${res.data.message}`, 'error', notificationContainer);
            }
        } catch (error) {
            showNotification('上传失败: ' + (error.response?.data?.message || '服务器错误'), 'error', notificationContainer);
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
        
        // --- *** 关键修正：优化前端档名长度验证 *** ---
        const MAX_FILENAME_LENGTH = 255;
        const longFileNames = allFilesData.filter(data => {
            const fileName = data.relativePath.split('/').pop(); // 只取档名部分
            return fileName.length > MAX_FILENAME_LENGTH;
        });

        if (longFileNames.length > 0) {
            const fileNames = longFileNames.map(data => `"${data.relativePath.split('/').pop()}"`).join(', ');
            showNotification(`部分档名过长 (超过 ${MAX_FILENAME_LENGTH} 个字元)，无法上传: ${fileNames}`, 'error', !isDrag ? uploadNotificationArea : null);
            return;
        }
        // --- 修正结束 ---

        const notificationContainer = isDrag ? null : uploadNotificationArea;

        const oversizedFiles = allFilesData.filter(data => data.file.size > MAX_TELEGRAM_SIZE);
        if (oversizedFiles.length > 0) {
            const fileNames = oversizedFiles.map(data => `"${data.file.name}"`).join(', ');
            showNotification(`文件 ${fileNames} 过大，超过 ${formatBytes(MAX_TELEGRAM_SIZE)} 的限制。`, 'error', notificationContainer);
            return;
        }

        const filesToCheck = allFilesData.map(data => ({
            relativePath: data.relativePath
        }));

        let existenceData = [];
        try {
            const res = await axios.post('/api/check-existence', { files: filesToCheck, folderId: targetFolderId });
            existenceData = res.data.files;
        } catch (error) {
            showNotification(error.response?.data?.message || '检查文件是否存在时出错。', 'error', notificationContainer);
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
        allFilesData.forEach(data => {
            formData.append(data.relativePath, data.file);
        });
        
        const params = new URLSearchParams();
        params.append('folderId', targetFolderId);
        params.append('resolutions', JSON.stringify(resolutions));

        if (!isDrag) {
            const captionInput = document.getElementById('uploadCaption');
            if (captionInput && captionInput.value) {
                params.append('caption', captionInput.value);
            }
        }
        
        const uploadUrl = `/upload?${params.toString()}`;
        
        await performUpload(uploadUrl, formData, isDrag);
    };

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
                    if (parent && parent.encrypted_id) {
                       history.back();
                    }
                    return;
                }
                try {
                    const currentFolderOriginalId = res.data.path[res.data.path.length - 1].id;
                    await axios.post(`/api/folder/${currentFolderOriginalId}/verify`, { password });
                    loadFolderContents(encryptedFolderId);
                } catch (error) {
                    alert('密码错误！');
                    const parent = res.data.path.length > 1 ? res.data.path[res.data.path.length - 2] : null;
                    if (parent && parent.encrypted_id) {
                       loadFolderContents(parent.encrypted_id);
                    }
                }
                return;
            }

            currentFolderContents = res.data.contents;
            currentFolderId = res.data.path[res.data.path.length - 1].id;

            const currentIds = new Set([...res.data.contents.folders.map(f => String(f.id)), ...res.data.contents.files.map(f => String(f.id))]);
            selectedItems.forEach((_, key) => {
                if (!currentIds.has(key)) {
                    selectedItems.delete(key);
                }
            });
            renderBreadcrumb(res.data.path);
            renderItems(currentFolderContents.folders, currentFolderContents.files);
            updateContextMenu();
        } catch (error) {
            if (error.response && error.response.status === 401) {
                window.location.href = '/login';
            }
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
            if (p.id === null) {
                breadcrumb.innerHTML += `<span>${p.name}</span>`;
                return;
            }
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

        const sortedFolders = [...folders].sort((a, b) => {
            if (key === 'name') {
                return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) * direction;
            }
            return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true });
        });

        const sortedFiles = [...files].sort((a, b) => {
            if (key === 'name') {
                return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) * direction;
            }
            if (key === 'size') {
                return (a.size - b.size) * direction;
            }
            if (key === 'date') {
                return (a.date - b.date) * direction;
            }
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
            if (currentView === 'grid') parentGrid.innerHTML = isSearchMode ? '<p>找不到符合条件的文件。</p>' : '<p>这个资料夾是空的。</p>';
            else parentList.innerHTML = isSearchMode ? '<div class="list-item"><p>找不到符合条件的文件。</p></div>' : '<div class="list-item"><p>这个资料夾是空的。</p></div>';
            return;
        }

        allItems.forEach(item => {
            if (currentView === 'grid') {
                parentGrid.appendChild(createItemCard(item));
            } else {
                parentList.appendChild(createListItem(item));
            }
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
            card.dataset.encryptedFolderId = item.encrypted_id; // 修正：添加加密ID
        }
        card.setAttribute('tabindex', '0');

        let iconHtml = '';
        if (item.type === 'file') {
            const fullFile = currentFolderContents.files.find(f => f.id === item.id) || item;
            if (fullFile.storage_type === 'telegram' && fullFile.thumb_file_id) {
                iconHtml = `<img src="/thumbnail/${item.id}" alt="缩图" loading="lazy">`;
            } else if (fullFile.mimetype && fullFile.mimetype.startsWith('image/')) {
                 iconHtml = `<img src="/download/proxy/${item.id}" alt="图片" loading="lazy">`;
            } else if (fullFile.mimetype && fullFile.mimetype.startsWith('video/')) {
                iconHtml = `<video src="/download/proxy/${item.id}#t=0.1" preload="metadata" muted></video>`;
            } else {
                 iconHtml = `<i class="fas ${getFileIconClass(item.mimetype, item.name)}"></i>`;
            }
        } else { // folder
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
            itemDiv.dataset.encryptedFolderId = item.encrypted_id; // 修正：添加加密ID
        }
        itemDiv.setAttribute('tabindex', '0');

        const icon = item.type === 'folder' ? (item.is_locked ? 'fa-lock' : 'fa-folder') : getFileIconClass(item.mimetype, item.name);
        const name = item.name === '/' ? '根目录' : item.name;
        const size = item.type === 'file' && item.size ? formatBytes(item.size) : '—';
        const date = item.date ? formatDateTime(item.date) : '—';


        itemDiv.innerHTML = `
            <div class="list-icon"><i class="fas ${icon}"></i></div>
            <div class="list-name" title="${name}">${name}</div>
            <div class="list-size">${size}</div>
            <div class="list-date">${date}</div>
        `;

        if (selectedItems.has(String(item.id))) {
            itemDiv.classList.add('selected');
        }

        return itemDiv;
    };

    const getFileIconClass = (mimetype, fileName) => {
        const lowerFileName = (fileName || '').toLowerCase();
        const archiveExtensions = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg'];
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff'];

        for (const ext of archiveExtensions) {
            if (lowerFileName.endsWith('.' + ext)) return 'fa-file-archive';
        }
        for (const ext of imageExtensions) {
            if (lowerFileName.endsWith('.' + ext)) return 'fa-file-image';
        }

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
        const itemSpecificButtons = [previewBtn, moveBtn, shareBtn, renameBtn, downloadBtn, deleteBtn, contextMenuSeparator1, lockBtn];
    
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

            previewBtn.disabled = !singleSelection || firstSelectedItem.type === 'folder';
            renameBtn.disabled = !singleSelection;
            moveBtn.disabled = count === 0 || isSearchMode || containsLockedFolder;

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
        } catch (error) {
            // console.error('加载资料夾列表失败', error);
        }
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
                resolve({
                    action,
                    applyToAll: applyToAllFoldersCheckbox.checked
                });
            };
        });
    }

    async function handleConflict(conflicts, operationType = '档案') {
        const resolutions = {};
        let applyToAllAction = null;
        let aborted = false;

        for (const conflictName of conflicts) {
            if (applyToAllAction) {
                resolutions[conflictName] = applyToAllAction;
                continue;
            }

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
                    
                    if (applyToAllCheckbox.checked) {
                        applyToAllAction = chosenAction;
                    }
                    resolve(chosenAction);
                };
            });

            if (action === 'abort') {
                aborted = true;
                break;
            }
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

    passwordForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const password = passwordInput.value;
        const oldPassword = oldPasswordInput.value;
        const confirmPassword = confirmPasswordInput.value;
        passwordModal.style.display = 'none';
        passwordPromise.resolve({ password, oldPassword, confirmPassword });
    });

    passwordCancelBtn.addEventListener('click', () => {
        passwordModal.style.display = 'none';
        passwordPromise.resolve({password: null});
    });

    // --- 事件监听 ---
    const handleKeyDown = (e) => {
        const activeElement = document.activeElement;
        const isItem = activeElement && (activeElement.classList.contains('item-card') || activeElement.classList.contains('list-item'));

        if (!isItem) return;

        if (e.key === 'Enter') {
            e.preventDefault();
            handleItemDblClick({ target: activeElement });
        } else if (e.key === ' ') {
            e.preventDefault();
            handleItemClick({ target: activeElement, ctrlKey: true });
        } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
            e.preventDefault();
            
            const items = Array.from(dropZone.querySelectorAll('.item-card:not([style*="display: none"]), .list-item:not([style*="display: none"])'));
            if (items.length === 0) return;

            const currentIndex = items.indexOf(activeElement);
            let nextIndex = currentIndex;

            if (currentView === 'grid') {
                const style = window.getComputedStyle(itemGrid);
                const columns = style.getPropertyValue('grid-template-columns').split(' ').length;
                switch (e.key) {
                    case 'ArrowUp':
                        nextIndex = Math.max(0, currentIndex - columns);
                        break;
                    case 'ArrowDown':
                        nextIndex = Math.min(items.length - 1, currentIndex + columns);
                        break;
                    case 'ArrowLeft':
                        nextIndex = Math.max(0, currentIndex - 1);
                        break;
                    case 'ArrowRight':
                        nextIndex = Math.min(items.length - 1, currentIndex + 1);
                        break;
                }
            } else { 
                switch (e.key) {
                    case 'ArrowUp':
                        nextIndex = Math.max(0, currentIndex - 1);
                        break;
                    case 'ArrowDown':
                        nextIndex = Math.min(items.length - 1, currentIndex + 1);
                        break;
                }
            }
            
            if (nextIndex !== currentIndex && items[nextIndex]) {
                items[nextIndex].focus();
            }
        }
    };
    if (dropZone) {
        dropZone.addEventListener('keydown', handleKeyDown);
        
        // --- *** 关键修正 开始 *** ---
        dropZone.addEventListener('focusin', (e) => {
            const target = e.target.closest('.item-card, .list-item');
            if (target && body.classList.contains('using-keyboard') && !isMultiSelectMode) {
                selectedItems.clear();
                selectedItems.set(target.dataset.id, { type: target.dataset.type, name: target.dataset.name, encrypted_id: target.dataset.encryptedFolderId });
                rerenderSelection();
                updateContextMenu();
            }
        });
        // --- *** 关键修正 结束 *** ---
    }

    if (listHeader) {
        listHeader.addEventListener('click', (e) => {
            const target = e.target.closest('[data-sort]');
            if (!target) return;

            const sortKey = target.dataset.sort;
            if (currentSort.key === sortKey) {
                currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
            } else {
                currentSort.key = sortKey;
                currentSort.order = 'asc';
            }
            renderItems(currentFolderContents.folders, currentFolderContents.files);
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            window.location.href = '/logout';
        });
    }

    if (changePasswordBtn) {
        changePasswordBtn.addEventListener('click', async () => {
            const oldPassword = prompt('请输入您的旧密码：');
            if (!oldPassword) return;

            const newPassword = prompt('请输入您的新密码 (至少 4 个字元)：');
            if (!newPassword) return;

            if (newPassword.length < 4) {
                alert('密码长度至少需要 4 个字元。');
                return;
            }

            const confirmPassword = prompt('请再次输入新密码以确认：');
            if (newPassword !== confirmPassword) {
                alert('两次输入的密码不一致！');
                return;
            }

            try {
                const res = await axios.post('/api/user/change-password', { oldPassword, newPassword });
                if (res.data.success) {
                    alert('密码修改成功！');
                }
            } catch (error) {
                alert('密码修改失败：' + (error.response?.data?.message || '服务器错误'));
            }
        });
    }
    
    if (fileInput) {
        fileInput.addEventListener('change', () => {
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
    }
    
    if (folderInput) {
        folderInput.addEventListener('change', (e) => {
            const files = e.target.files;
            if (files.length > 0) {
                const folderName = files[0].webkitRelativePath.split('/')[0];
                fileListContainer.innerHTML = `<li>已选择文件夹: <b>${folderName}</b> (包含 ${files.length} 个文件)</li>`;
                uploadSubmitBtn.style.display = 'block';
                fileInput.value = '';
            }
        });
    }
    
    if (uploadForm) {
        uploadForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const filesToProcess = folderInput.files.length > 0 ? folderInput.files : fileInput.files;
            const targetFolderId = folderSelect.value;
            const allFilesData = Array.from(filesToProcess).map(f => ({
                relativePath: f.webkitRelativePath || f.name,
                file: f
            }));
            uploadFiles(allFilesData, targetFolderId, false);
        });
    }

    if (dropZone) {
        dropZone.addEventListener('contextmenu', e => {
            e.preventDefault();
            const targetItem = e.target.closest('.item-card, .list-item');
    
            if (targetItem && !isMultiSelectMode && !e.ctrlKey && !e.metaKey) {
                if (!selectedItems.has(targetItem.dataset.id)) {
                    selectedItems.clear();
                    selectedItems.set(targetItem.dataset.id, {
                        type: targetItem.dataset.type,
                        name: targetItem.dataset.name,
                        encrypted_id: targetItem.dataset.encryptedFolderId
                    });
                    rerenderSelection();
                }
            } else if (!targetItem) {
                if (!isMultiSelectMode) {
                  selectedItems.clear();
                  rerenderSelection();
                }
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
    
            if (menuX + menuWidth > dropZoneWidth) {
                menuX = dropZoneWidth - menuWidth - 5;
            }
            if (menuY + menuHeight > dropZone.scrollHeight) {
                 menuY = dropZone.scrollHeight - menuHeight - 5;
            }
            if (menuY < dropZone.scrollTop) {
                menuY = dropZone.scrollTop;
            }

            contextMenu.style.top = `${menuY}px`;
            contextMenu.style.left = `${menuX}px`;
        });
        
        window.addEventListener('click', (e) => {
            if (!contextMenu.contains(e.target)) {
               contextMenu.style.display = 'none';
            }
        });

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
        });

        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'));
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'));
        });

        dropZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('dragover');
    
            const items = e.dataTransfer.items;
            if (!items || items.length === 0) return;
    
            const getFileWithRelativePath = (entry) => {
                return new Promise((resolve, reject) => {
                    if (entry.isFile) {
                        entry.file(file => {
                            const relativePath = entry.fullPath.startsWith('/') ? entry.fullPath.substring(1) : entry.fullPath;
                            resolve([{
                                relativePath: relativePath,
                                file: file
                            }]);
                        }, err => reject(err));
                    } else if (entry.isDirectory) {
                        const dirReader = entry.createReader();
                        let allEntries = [];
                        const readEntries = () => {
                            dirReader.readEntries(async (entries) => {
                                if (entries.length === 0) {
                                    try {
                                        const filesDataArrays = await Promise.all(allEntries.map(getFileWithRelativePath));
                                        resolve(filesDataArrays.flat());
                                    } catch (error) {
                                        reject(error);
                                    }
                                } else {
                                    allEntries.push(...entries);
                                    readEntries();
                                }
                            }, err => reject(err));
                        };
                        readEntries();
                    } else {
                        resolve([]);
                    }
                });
            };
        
            try {
                const entries = Array.from(items).map(item => item.webkitGetAsEntry());
                const filesDataPromises = entries.map(getFileWithRelativePath);
                const filesDataArrays = await Promise.all(filesDataPromises);
                const allFilesData = filesDataArrays.flat().filter(Boolean);
                
                if (allFilesData.length > 0) {
                    uploadFiles(allFilesData, currentFolderId, true);
                } else {
                    showNotification('找不到可上传的文件。', 'warn');
                }
            } catch (error) {
                showNotification('读取拖放的文件夹时出错。', 'error');
                console.error(error);
            }
        });
    }

    if (homeLink) {
        homeLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.history.pushState(null, '', '/');
            window.location.href = '/';
        });
    }
    const handleItemClick = (e) => {
        const target = e.target.closest('.item-card, .list-item');
        if (!target) return;
        const id = target.dataset.id;
        const type = target.dataset.type;
        const name = target.dataset.name;
        const encrypted_id = target.dataset.encryptedFolderId; // 修正：取得加密ID

        if (isMultiSelectMode || e.ctrlKey || e.metaKey) {
            if (selectedItems.has(id)) {
                selectedItems.delete(id);
            } else {
                selectedItems.set(id, { type, name, encrypted_id }); // 修正：储存加密ID
            }
        } else {
            selectedItems.clear();
            selectedItems.set(id, { type, name, encrypted_id }); // 修正：储存加密ID
        }
        rerenderSelection();
        updateContextMenu();
    };

    const handleItemDblClick = async (e) => {
        if (isMultiSelectMode) return;
        const target = e.target.closest('.item-card, .list-item');
        if (target && target.dataset.type === 'folder') {
            const folderId = parseInt(target.dataset.id, 10);
            const isLocked = target.dataset.isLocked === 'true' || target.dataset.isLocked === '1';
            const encryptedId = target.dataset.encryptedFolderId;

            if (!encryptedId) return;

            if (isLocked) {
                try {
                    const { password } = await promptForPassword(`资料夾 "${target.dataset.name}" 已加密`, '请输入密码以存取:');
                    if (password === null) return;
                    await axios.post(`/api/folder/${folderId}/verify`, { password });
                    window.history.pushState(null, '', `/view/${encryptedId}`);
                    loadFolderContents(encryptedId);
                } catch (error) {
                    alert(error.response?.data?.message || '验证失败');
                }
            } else {
                window.history.pushState(null, '', `/view/${encryptedId}`);
                loadFolderContents(encryptedId);
            }
        } else if (target && target.dataset.type === 'file') {
            if (selectedItems.size !== 1) {
                selectedItems.clear();
                selectedItems.set(target.dataset.id, { type: 'file', name: target.dataset.name });
                rerenderSelection();
            }
            previewBtn.click();
        }
    };
    
    if (itemGrid) {
        itemGrid.addEventListener('click', handleItemClick);
        itemGrid.addEventListener('dblclick', handleItemDblClick);
    }
    if (itemListBody) {
        itemListBody.addEventListener('click', handleItemClick);
        itemListBody.addEventListener('dblclick', handleItemDblClick);
    }
    
    if (viewSwitchBtn) {
        viewSwitchBtn.addEventListener('click', () => {
            switchView(currentView === 'grid' ? 'list' : 'grid');
        });
    }

    if (multiSelectToggleBtn) {
        multiSelectToggleBtn.addEventListener('click', () => {
            isMultiSelectMode = !isMultiSelectMode;
            document.body.classList.toggle('selection-mode-active', isMultiSelectMode);

            if (!isMultiSelectMode) {
                selectedItems.clear();
                rerenderSelection();
            }
            updateContextMenu();
            contextMenu.style.display = 'none';
        });
    }

    if (breadcrumb) {
        breadcrumb.addEventListener('click', e => {
            e.preventDefault();
            const link = e.target.closest('a');
            if (link && link.dataset.encryptedFolderId) {
                const encryptedId = link.dataset.encryptedFolderId;
                window.history.pushState(null, '', `/view/${encryptedId}`);
                loadFolderContents(encryptedId);
            }
        });
    }
    window.addEventListener('popstate', () => {
        if (document.getElementById('itemGrid')) {
            const pathParts = window.location.pathname.split('/');
            const viewIndex = pathParts.indexOf('view');
            if (viewIndex !== -1 && pathParts.length > viewIndex + 1) {
                const encryptedId = pathParts[viewIndex + 1];
                loadFolderContents(encryptedId);
            } else {
                window.location.href = '/';
            }
        }
    });
    if (createFolderBtn) {
        createFolderBtn.addEventListener('click', async () => {
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
    }
    if (searchForm) {
        searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const query = searchInput.value.trim();
            if (query) executeSearch(query);
            else if(isSearchMode) loadFolderContents(currentEncryptedFolderId);
        });
    }
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => {
            contextMenu.style.display = 'none';
            const allVisibleItems = [...currentFolderContents.folders, ...currentFolderContents.files];
            const allVisibleIds = allVisibleItems.map(item => String(item.id));
            const isAllSelected = allVisibleItems.length > 0 && allVisibleIds.every(id => selectedItems.has(id));
            if (isAllSelected) {
                selectedItems.clear();
            } else {
                allVisibleItems.forEach(item => selectedItems.set(String(item.id), { type: item.type, name: item.name, encrypted_id: item.encrypted_id }));
            }
            rerenderSelection();
            updateContextMenu();
        });
    }
    if (showUploadModalBtn) {
        showUploadModalBtn.addEventListener('click', async () => {
            await loadFoldersForSelect();
            folderSelect.value = currentFolderId;
            uploadNotificationArea.innerHTML = '';
            uploadForm.reset();
            fileListContainer.innerHTML = '';
            uploadSubmitBtn.style.display = 'block';
            uploadModal.style.display = 'flex';
        });
    }
    if (closeUploadModalBtn) {
        closeUploadModalBtn.addEventListener('click', () => {
            uploadModal.style.display = 'none';
        });
    }
    
    if (shareBtn && shareModal) {
        const shareOptions = document.getElementById('shareOptions');
        const shareResult = document.getElementById('shareResult');
        const expiresInSelect = document.getElementById('expiresInSelect');
        const customExpiresInput = document.getElementById('customExpiresInput');
        const confirmShareBtn = document.getElementById('confirmShareBtn');
        const cancelShareBtn = document.getElementById('cancelShareBtn');
        const shareLinkContainer = document.getElementById('shareLinkContainer');
        const copyLinkBtn = document.getElementById('copyLinkBtn');
        const closeShareModalBtn = document.getElementById('closeShareModalBtn');
        const sharePasswordInput = document.getElementById('sharePasswordInput');
    
        expiresInSelect.addEventListener('change', () => {
            if (expiresInSelect.value === 'custom') {
                customExpiresInput.style.display = 'block';
                const now = new Date();
                now.setHours(now.getHours() + 1);
                const year = now.getFullYear();
                const month = (now.getMonth() + 1).toString().padStart(2, '0');
                const day = now.getDate().toString().padStart(2, '0');
                const hours = now.getHours().toString().padStart(2, '0');
                const minutes = now.getMinutes().toString().padStart(2, '0');
                customExpiresInput.value = `${year}-${month}-${day}T${hours}:${minutes}`;
            } else {
                customExpiresInput.style.display = 'none';
            }
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
            const itemType = item.type;
            const expiresIn = expiresInSelect.value;
            const password = sharePasswordInput.value;
            
            const payload = { itemId, itemType, expiresIn, password };
    
            if (expiresIn === 'custom') {
                if (!customExpiresInput.value) {
                    alert('请选择一个有效的到期时间！');
                    return;
                }
                payload.customExpiresAt = new Date(customExpiresInput.value).getTime();
                if (isNaN(payload.customExpiresAt) || payload.customExpiresAt <= Date.now()) {
                    alert('自订的到期时间必须晚于现在！');
                    return;
                }
            }
            
            try {
                const res = await axios.post('/share', payload);
                if (res.data.success) {
                    shareLinkContainer.textContent = res.data.url;
                    shareOptions.style.display = 'none';
                    shareResult.style.display = 'block';
                } else {
                    alert('创建分享链接失败: ' + res.data.message);
                }
            } catch {
                alert('创建分享链接请求失败');
            }
        });
        copyLinkBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(shareLinkContainer.textContent).then(() => {
                copyLinkBtn.textContent = '已复制!';
                setTimeout(() => { copyLinkBtn.textContent = '复制链接'; }, 2000);
            });
        });
    }
    
    if (previewBtn) {
        previewBtn.addEventListener('click', async () => {
            if (previewBtn.disabled) return;
            contextMenu.style.display = 'none';
            const messageId = selectedItems.keys().next().value;
            const file = currentFolderContents.files.find(f => String(f.id) === messageId);
            if (!file) return;

            previewModal.style.display = 'flex';
            modalContent.innerHTML = '正在加载预览...';
            const downloadUrl = `/download/proxy/${messageId}`;

            if (file.mimetype && file.mimetype.startsWith('image/')) {
                modalContent.innerHTML = `<img src="${downloadUrl}" alt="图片预览">`;
            } else if (file.mimetype && file.mimetype.startsWith('video/')) {
                modalContent.innerHTML = `<video src="${downloadUrl}" controls autoplay></video>`;
            } else if (file.mimetype && (file.mimetype.startsWith('text/') || isEditableFile(file.name))) {
                try {
                    const res = await axios.get(`/file/content/${messageId}`);
                    const escapedContent = res.data.replace(/&/g, "&amp;").replace(/</g, "&lt;");
                    modalContent.innerHTML = `<pre><code>${escapedContent}</code></pre>`;
                } catch {
                    modalContent.innerHTML = '无法载入文字内容。';
                }
            } else {
                modalContent.innerHTML = `
                    <div class="no-preview">
                        <i class="fas fa-file"></i>
                        <p>此文件类型不支持预览。</p>
                        <a href="${downloadUrl}" class="upload-link-btn" download>下载文件</a>
                    </div>
                `;
            }
        });
    }
    if (renameBtn) {
        renameBtn.addEventListener('click', async () => {
             if (renameBtn.disabled) return;
             contextMenu.style.display = 'none';
             const [id, item] = selectedItems.entries().next().value;
             const newName = prompt('请输入新的名称:', item.name);
             if (newName && newName.trim() && newName !== item.name) {
                 try {
                    await axios.post('/rename', {
                        id: id,
                        newName: newName.trim(),
                        type: item.type
                    });
                    loadFolderContents(currentEncryptedFolderId);
                 } catch (error) {
                     alert('重命名失败: ' + (error.response?.data?.message || '服务器错误'));
                 }
             }
        });
    }
    if (downloadBtn) {
        downloadBtn.addEventListener('click', async () => {
            if (downloadBtn.disabled) return;
            contextMenu.style.display = 'none';
            const messageIds = [];
            const folderIds = [];
            selectedItems.forEach((item, id) => {
                if (item.type === 'file') messageIds.push(parseInt(id));
                else folderIds.push(parseInt(id));
            });
            if (messageIds.length === 0 && folderIds.length === 0) return;
            if (messageIds.length === 1 && folderIds.length === 0) {
                window.location.href = `/download/proxy/${messageIds[0]}`;
                return;
            }
            try {
                const response = await axios.post('/api/download-archive', { messageIds, folderIds }, { responseType: 'blob' });
                const url = window.URL.createObjectURL(new Blob([response.data]));
                const link = document.createElement('a');
                link.href = url;
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                link.setAttribute('download', `download-${timestamp}.zip`);
                document.body.appendChild(link);
                link.click();
                window.URL.revokeObjectURL(url);
                document.body.removeChild(link);
            } catch (error) {
                alert('下载压缩档失败！');
            }
        });
    }
    if (deleteBtn) {
        deleteBtn.addEventListener('click', async () => {
            if (selectedItems.size === 0) return;
            contextMenu.style.display = 'none';
            if (!confirm(`确定要删除这 ${selectedItems.size} 个项目吗？\n注意：删除资料夾将会一并删除其所有内容！`)) return;
            const filesToDelete = [], foldersToDelete = [];
            selectedItems.forEach((item, id) => {
                if (item.type === 'file') filesToDelete.push(parseInt(id));
                else foldersToDelete.push(parseInt(id));
            });
            try {
                await axios.post('/delete-multiple', { messageIds: filesToDelete, folderIds: foldersToDelete });
                loadFolderContents(currentEncryptedFolderId);
            } catch (error) { alert('删除失败: ' + (error.response?.data?.message || '请重试。')); }
        });
    }

    if (moveBtn) {
        moveBtn.addEventListener('click', async () => {
            if (selectedItems.size === 0) return;
            contextMenu.style.display = 'none';
            try {
                const res = await axios.get('/api/folders');
                const folders = res.data;
                folderTree.innerHTML = '';

                const folderMap = new Map(folders.map(f => [f.id, { ...f, children: [] }]));
                const tree = [];
                folderMap.forEach(f => {
                    if (f.parent_id && folderMap.has(f.parent_id)) {
                        folderMap.get(f.parent_id).children.push(f);
                    } else {
                        tree.push(f);
                    }
                });

                const disabledFolderIds = new Set();
                selectedItems.forEach((item, id) => {
                    if (item.type === 'folder') {
                        const folderId = parseInt(id);
                        disabledFolderIds.add(folderId);
                        const findDescendants = (parentId) => {
                            const parentNode = folderMap.get(parentId);
                            if (parentNode && parentNode.children) {
                                parentNode.children.forEach(child => {
                                    disabledFolderIds.add(child.id);
                                    findDescendants(child.id);
                                });
                            }
                        };
                        findDescendants(folderId);
                    }
                });

                const buildTree = (node, prefix = '') => {
                    const isDisabled = disabledFolderIds.has(node.id) || node.id === currentFolderId;

                    const item = document.createElement('div');
                    item.className = 'folder-item';
                    item.dataset.folderId = node.id;
                    item.dataset.encryptedFolderId = node.encrypted_id; // 修正：添加加密ID
                    item.textContent = prefix + (node.name === '/' ? '根目录' : node.name);

                    if (isDisabled) {
                        item.style.color = '#ccc';
                        item.style.cursor = 'not-allowed';
                    }

                    folderTree.appendChild(item);
                    node.children.sort((a,b) => a.name.localeCompare(b.name)).forEach(child => buildTree(child, prefix + '　'));
                };
                tree.sort((a,b) => a.name.localeCompare(b.name)).forEach(node => buildTree(node));

                moveModal.style.display = 'flex';
                moveTargetFolderId = null;
                moveTargetEncryptedFolderId = null;
                confirmMoveBtn.disabled = true;
            } catch { alert('无法获取资料夾列表。'); }
        });
    }
    if (folderTree) {
        folderTree.addEventListener('click', e => {
            const target = e.target.closest('.folder-item');
            if (!target || target.style.cursor === 'not-allowed') return;

            const previouslySelected = folderTree.querySelector('.folder-item.selected');
            if (previouslySelected) previouslySelected.classList.remove('selected');
            target.classList.add('selected');
            moveTargetFolderId = parseInt(target.dataset.folderId);
            moveTargetEncryptedFolderId = target.dataset.encryptedFolderId; // 修正：储存加密ID
            confirmMoveBtn.disabled = false;
        });
    }
    
    if (confirmMoveBtn) {
        confirmMoveBtn.addEventListener('click', async () => {
            if (!moveTargetFolderId) return;
    
            const resolutions = {};
            let isAborted = false;
            let applyToAllFolderAction = null;

            // 修正：更新函数签名以接收加密ID
            async function resolveConflictsRecursively(itemsToMove, currentTargetFolderId, currentTargetEncryptedFolderId, pathPrefix = '') {
                if (isAborted) return;
    
                const conflictCheckRes = await axios.post('/api/check-move-conflict', {
                    itemIds: itemsToMove.map(item => item.id),
                    targetFolderId: currentTargetFolderId
                });
                const { fileConflicts, folderConflicts } = conflictCheckRes.data;
    
                // 修正：使用加密ID获取目标资料夹内容
                const destFolderContentsRes = await axios.get(`/api/folder/${currentTargetEncryptedFolderId}`);
                // 修正：储存加密ID以供递回呼叫
                const destFolderMap = new Map(destFolderContentsRes.data.contents.folders.map(f => [f.name, { id: f.id, encrypted_id: f.encrypted_id }]));
    
                for (const folderName of folderConflicts) {
                    const fullPath = pathPrefix ? `${pathPrefix}/${folderName}` : folderName;
                    
                    let action;
                    if(applyToAllFolderAction) {
                        action = applyToAllFolderAction;
                    } else {
                        const result = await handleFolderConflict(fullPath, folderConflicts.length);
                        action = result.action;
                        if(result.applyToAll) {
                            applyToAllFolderAction = action;
                        }
                    }

                    if (action === 'abort') {
                        isAborted = true;
                        return;
                    }
                    resolutions[fullPath] = action;
    
                    if (action === 'merge') {
                        const sourceFolder = itemsToMove.find(item => item.name === folderName && item.type === 'folder');
                        const destSubFolderData = destFolderMap.get(folderName);
                        if (sourceFolder && destSubFolderData) {
                            // 修正：使用源子资料夹的加密ID获取其内容
                            const sourceSubFolderContentsRes = await axios.get(`/api/folder/${sourceFolder.encrypted_id}`);
                            const subItemsToMove = [...sourceSubFolderContentsRes.data.contents.folders, ...sourceSubFolderContentsRes.data.contents.files].map(item => ({
                                id: item.id,
                                name: item.name,
                                type: item.type,
                                encrypted_id: item.encrypted_id // 修正：传递加密ID
                            }));
                            
                            if(subItemsToMove.length > 0) {
                               // 修正：递回呼叫时传递加密ID
                               await resolveConflictsRecursively(subItemsToMove, destSubFolderData.id, destSubFolderData.encrypted_id, fullPath);
                            }
                            if (isAborted) return;
                        }
                    }
                }
    
                if (fileConflicts.length > 0) {
                    const prefixedFileConflicts = fileConflicts.map(name => pathPrefix ? `${pathPrefix}/${name}` : name);
                    const result = await handleConflict(prefixedFileConflicts, '档案');
    
                    if (result.aborted) {
                        isAborted = true;
                        return;
                    }
                    Object.assign(resolutions, result.resolutions);
                }
            }
    
            try {
                // 修正：从 selectedItems 中提取所有必要数据，包括加密ID
                const topLevelItems = Array.from(selectedItems.entries()).map(([id, item]) => ({
                    id: parseInt(id),
                    type: item.type,
                    name: item.name,
                    encrypted_id: item.encrypted_id
                }));
                
                // 修正：初始呼叫，传递加密和未加密的ID
                await resolveConflictsRecursively(topLevelItems, moveTargetFolderId, moveTargetEncryptedFolderId);
    
                if (isAborted) {
                    moveModal.style.display = 'none';
                    showNotification('移动操作已取消。', 'info');
                    return;
                }
    
                const response = await axios.post('/api/move', {
                    itemIds: topLevelItems.map(item => item.id),
                    targetFolderId: moveTargetFolderId,
                    resolutions 
                });
    
                moveModal.style.display = 'none';
                loadFolderContents(currentEncryptedFolderId);
                showNotification(response.data.message, 'success');
    
            } catch (error) {
                moveModal.style.display = 'none';
                alert('操作失败：' + (error.response?.data?.message || '服务器错误'));
            }
        });
    }

    if (closeModal) closeModal.onclick = () => {
        previewModal.style.display = 'none';
        modalContent.innerHTML = '';
    };
    if (cancelMoveBtn) cancelMoveBtn.addEventListener('click', () => moveModal.style.display = 'none');

    if (textEditBtn) {
        textEditBtn.addEventListener('click', () => {
            contextMenu.style.display = 'none';
            const selectionCount = selectedItems.size;
            if (selectionCount === 0) {
                window.open(`/editor?mode=create&folderId=${currentFolderId}`, '_blank');
            } else if (selectionCount === 1 && isEditableFile(selectedItems.values().next().value.name)) {
                const fileId = selectedItems.keys().next().value;
                window.open(`/editor?mode=edit&fileId=${fileId}`, '_blank');
            }
        });
    }

    lockBtn.addEventListener('click', async () => {
        contextMenu.style.display = 'none';
        const [id, item] = selectedItems.entries().next().value;
        const folderId = parseInt(id);
        const folderName = item.name;

        const folderElement = document.querySelector(`.item-card[data-id="${id}"], .list-item[data-id="${id}"]`);
        const isLocked = folderElement.dataset.isLocked === 'true' || folderElement.dataset.isLocked === '1';

        if (isLocked) {
            const action = prompt(`资料夾 "${folderName}" 已加密。\n请输入 "change" 来修改密码，或输入 "unlock" 来移除密码。`);
            if (action === 'unlock') {
                const { password } = await promptForPassword(`移除密码`, `请输入 "${folderName}" 的密码以移除加密:`);
                if (password === null) return;
                try {
                    await axios.post(`/api/folder/${folderId}/unlock`, { password });
                    showNotification('资料夾密码已移除。', 'success');
                    loadFolderContents(currentEncryptedFolderId);
                } catch (error) {
                    alert('密码错误或操作失败。');
                }
            } else if (action === 'change') {
                const { password, oldPassword, confirmPassword } = await promptForPassword(`修改密码`, `为 "${folderName}" 设定新密码:`, true, true);
                if (password === null) return;
                if (password !== confirmPassword) {
                    alert('两次输入的新密码不匹配！');
                    return;
                }
                try {
                    await axios.post(`/api/folder/${folderId}/lock`, { oldPassword, password });
                    showNotification('密码修改成功。', 'success');
                } catch (error) {
                    alert('操作失败: ' + (error.response?.data?.message || '未知错误'));
                }
            }
        } else {
            const { password, confirmPassword } = await promptForPassword(`加密资料夾`, `为 "${folderName}" 设定一个新密码 (至少4个字元):`, false, true);
            if (password === null) return;
            if (password !== confirmPassword) {
                alert('两次输入的密码不匹配！');
                return;
            }
            try {
                await axios.post(`/api/folder/${folderId}/lock`, { password });
                showNotification('资料夾已成功加密。', 'success');
                loadFolderContents(currentEncryptedFolderId);
            } catch (error) {
                alert('加密失败: ' + (error.response?.data?.message || '未知错误'));
            }
        }
    });

    window.addEventListener('message', (event) => {
        if (event.data === 'refresh-files') {
            loadFolderContents(currentEncryptedFolderId);
        }
    });
    
    // 初始化
    if (document.getElementById('itemGrid')) {
        const pathParts = window.location.pathname.split('/');
        const viewIndex = pathParts.indexOf('view');
        let encryptedId;
        if (viewIndex !== -1 && pathParts.length > viewIndex + 1) {
            encryptedId = pathParts[viewIndex + 1];
        }

        if (encryptedId) {
            loadFolderContents(encryptedId);
        } else {
           // 如果 URL 无效，导航到根目录
           window.location.href = '/';
        }
    }
});
