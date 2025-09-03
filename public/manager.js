document.addEventListener('DOMContentLoaded', () => {
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
    const dropZone = document.getElementById('dropZone');
    const dragUploadProgressArea = document.getElementById('dragUploadProgressArea');
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

    let isMultiSelectMode = false;
    let currentFolderId = null; // --- 修改：不再直接储存数字ID ---
    let currentFolderContents = { folders: [], files: [] };
    let selectedItems = new Map();
    let moveTargetFolderId = null;
    let isSearchMode = false;
    const MAX_TELEGRAM_SIZE = 1000 * 1024 * 1024;
    let foldersLoaded = false;
    let currentView = 'grid';
    let currentSort = { key: 'name', order: 'asc' };
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
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false
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
                if (!isDrag) uploadModal.style.display = 'none';
                showNotification(res.data.skippedAll ? '没有文件被上传，所有冲突的项目都已被跳过。' : '上传成功！', res.data.skippedAll ? 'info' : 'success');
                fileInput.value = '';
                folderInput.value = '';
                loadFolderContents(currentFolderId);
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
    
    const uploadFiles = async (filesOrData, targetFolderId, isDrag = false) => {
        const isDataArray = filesOrData.length > 0 && filesOrData[0].file;
        const notificationContainer = isDrag ? null : uploadNotificationArea;

        if (filesOrData.length === 0) {
            return showNotification('请选择文件或文件夹。', 'error', notificationContainer);
        }

        const allFilesData = isDataArray ? filesOrData : Array.from(filesOrData).map(f => ({
            relativePath: f.webkitRelativePath || f.name,
            file: f
        }));

        const oversizedFiles = allFilesData.filter(data => data.file.size > MAX_TELEGRAM_SIZE);
        if (oversizedFiles.length > 0) {
            const fileNames = oversizedFiles.map(data => `"${data.file.name}"`).join(', ');
            return showNotification(`文件 ${fileNames} 过大，超过 ${formatBytes(MAX_TELEGRAM_SIZE)} 的限制。`, 'error', notificationContainer);
        }

        try {
            const res = await axios.post('/api/check-existence', { files: allFilesData.map(d => ({ relativePath: d.relativePath })), folderId: targetFolderId });
            const conflicts = res.data.files.filter(f => f.exists).map(f => f.relativePath);
            
            const resolutions = {};
            if (conflicts.length > 0) {
                const conflictResult = await handleConflict(conflicts, '档案');
                if (conflictResult.aborted) {
                    return showNotification('上传操作已取消。', 'info', notificationContainer);
                }
                Object.assign(resolutions, conflictResult.resolutions);
            }

            const formData = new FormData();
            allFilesData.forEach(data => formData.append(data.relativePath, data.file));
            
            const params = new URLSearchParams({
                folderId: targetFolderId,
                resolutions: JSON.stringify(resolutions)
            });
            if (!isDrag && document.getElementById('uploadCaption').value) {
                params.append('caption', document.getElementById('uploadCaption').value);
            }
            
            await performUpload(`/upload?${params.toString()}`, formData, isDrag);
        } catch (error) {
            showNotification(error.response?.data?.message || '检查文件是否存在时出错。', 'error', notificationContainer);
        }
    };

    // --- 修改：此函式现在接收加密过的路径字串 ---
    const loadFolderContents = async (encryptedPath) => {
        try {
            isSearchMode = false;
            if (searchInput) searchInput.value = '';
            currentFolderId = encryptedPath; 
            const res = await axios.get(`/api/folder/${encryptedPath}`);
            
            if (res.data.locked) {
                const lastPathSegment = res.data.path[res.data.path.length-1];
                const { password } = await promptForPassword(`资料夹 "${lastPathSegment.name}" 已加密`, '请输入密码以存取:');
                
                if (password === null) { 
                    const parentEncryptedId = res.data.path.length > 1 ? res.data.path[res.data.path.length - 2].id : null;
                    if (parentEncryptedId) history.back();
                    return;
                }
                try {
                    const decryptedPath = atob(lastPathSegment.id.replace(/_/g, '/').replace(/-/g, '+'));
                    const folderIdToVerify = parseInt(decryptedPath.split('/')[1], 10);
                    await axios.post(`/api/folder/${folderIdToVerify}/verify`, { password });
                    loadFolderContents(encryptedPath);
                } catch (error) {
                    alert('密码错误！');
                    const parentEncryptedId = res.data.path.length > 1 ? res.data.path[res.data.path.length - 2].id : null;
                    if (parentEncryptedId) loadFolderContents(parentEncryptedId);
                }
                return;
            }

            currentFolderContents = res.data.contents;
            const currentIds = new Set([...res.data.contents.folders.map(f => String(f.id)), ...res.data.contents.files.map(f => String(f.id))]);
            selectedItems.forEach((_, key) => {
                if (!currentIds.has(key)) selectedItems.delete(key);
            });
            renderBreadcrumb(res.data.path);
            renderItems(currentFolderContents.folders, currentFolderContents.files);
            updateContextMenu();
        } catch (error) {
            if (error.response && error.response.status === 401) window.location.href = '/login';
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
            const link = document.createElement(index === path.length - 1 && !isSearchMode ? 'span' : 'a');
            link.textContent = p.name === '/' ? '根目录' : p.name;
            if (link.tagName === 'A') {
                link.href = '#';
                // --- 修改：使用加密后的 ID ---
                link.dataset.encryptedPath = p.id;
            }
            breadcrumb.appendChild(link);
        });
    };
    
    const sortItems = (folders, files) => {
        const { key, order } = currentSort;
        const direction = order === 'asc' ? 1 : -1;
        const collator = new Intl.Collator('zh-Hans-CN', { numeric: true });

        const sortedFolders = [...folders].sort((a, b) => collator.compare(a.name, b.name) * direction);
        const sortedFiles = [...files].sort((a, b) => {
            if (key === 'name') return collator.compare(a.name, b.name) * direction;
            if (key === 'size') return (a.size - b.size) * direction;
            if (key === 'date') return (a.date - b.date) * direction;
            return 0;
        });

        return { folders: sortedFolders, files: sortedFiles };
    };
    
    const renderItems = (folders, files) => {
        itemGrid.innerHTML = '';
        itemListBody.innerHTML = '';

        const { folders: sortedFolders, files: sortedFiles } = sortItems(folders, files);
        const allItems = [...sortedFolders, ...sortedFiles];
        
        if (allItems.length === 0) {
            const message = isSearchMode ? '找不到符合条件的文件。' : '这个资料夾是空的。';
            itemGrid.innerHTML = `<p>${message}</p>`;
            itemListBody.innerHTML = `<div class="list-item"><p>${message}</p></div>`;
            return;
        }

        allItems.forEach(item => {
            const element = currentView === 'grid' ? createItemCard(item) : createListItem(item);
            (currentView === 'grid' ? itemGrid : itemListBody).appendChild(element);
        });
        updateSortIndicator();
    };

    const createItemCard = (item) => {
        const card = document.createElement('div');
        card.className = 'item-card';
        card.dataset.id = item.id;
        card.dataset.type = item.type;
        card.dataset.name = item.name;
        if (item.type === 'folder') card.dataset.isLocked = item.is_locked;
        card.setAttribute('tabindex', '0');

        let iconHtml = '';
        if (item.type === 'file') {
            const fullFile = currentFolderContents.files.find(f => f.id === item.id) || item;
            if (fullFile.storage_type === 'telegram' && fullFile.thumb_file_id) {
                iconHtml = `<img src="/thumbnail/${item.id}" alt="缩图" loading="lazy">`;
            } else if (fullFile.mimetype?.startsWith('image/')) {
                 iconHtml = `<img src="/download/proxy/${item.id}" alt="图片" loading="lazy">`;
            } else if (fullFile.mimetype?.startsWith('video/')) {
                iconHtml = `<video src="/download/proxy/${item.id}#t=0.1" preload="metadata" muted></video>`;
            } else {
                 iconHtml = `<i class="fas ${getFileIconClass(item.mimetype, item.name)}"></i>`;
            }
        } else {
            iconHtml = `<i class="fas ${item.is_locked ? 'fa-lock' : 'fa-folder'}"></i>`;
        }

        card.innerHTML = `<div class="item-icon">${iconHtml}</div><div class="item-info"><h5 title="${item.name}">${item.name}</h5></div>`;
        if (selectedItems.has(String(item.id))) card.classList.add('selected');
        return card;
    };

    const createListItem = (item) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'list-item';
        itemDiv.dataset.id = item.id;
        itemDiv.dataset.type = item.type;
        itemDiv.dataset.name = item.name;
        if (item.type === 'folder') itemDiv.dataset.isLocked = item.is_locked;
        itemDiv.setAttribute('tabindex', '0');

        const icon = item.type === 'folder' ? (item.is_locked ? 'fa-lock' : 'fa-folder') : getFileIconClass(item.mimetype, item.name);
        const name = item.name;
        const size = item.type === 'file' && item.size ? formatBytes(item.size) : '—';
        const date = item.date ? formatDateTime(item.date) : '—';

        itemDiv.innerHTML = `
            <div class="list-icon"><i class="fas ${icon}"></i></div>
            <div class="list-name" title="${name}">${name}</div>
            <div class="list-size">${size}</div>
            <div class="list-date">${date}</div>
        `;
        if (selectedItems.has(String(item.id))) itemDiv.classList.add('selected');
        return itemDiv;
    };

    const getFileIconClass = (mimetype, fileName) => {
        const lowerFileName = (fileName || '').toLowerCase();
        const extensions = {
            'fa-file-archive': ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg'],
            'fa-file-image': ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff']
        };
        for (const icon in extensions) {
            if (extensions[icon].some(ext => lowerFileName.endsWith('.' + ext))) return icon;
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
    
        multiSelectToggleBtn.innerHTML = isMultiSelectMode ? '<i class="fas fa-times"></i> <span class="button-text">退出多选模式</span>' : '<i class="fas fa-check-square"></i> <span class="button-text">进入多选模式</span>';
        multiSelectToggleBtn.style.display = isMultiSelectMode || !targetItem ? 'block' : 'none';

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
                return itemEl?.dataset.type === 'folder' && (itemEl.dataset.isLocked === 'true' || itemEl.dataset.isLocked === '1');
            });
            const isSingleLockedFolder = singleSelection && firstSelectedItem.type === 'folder' && containsLockedFolder;

            previewBtn.disabled = !singleSelection || firstSelectedItem.type === 'folder';
            renameBtn.disabled = !singleSelection;
            moveBtn.disabled = count === 0 || isSearchMode || containsLockedFolder;
            shareBtn.disabled = !singleSelection || isSingleLockedFolder;
            downloadBtn.disabled = count === 0 || containsLockedFolder;
            deleteBtn.disabled = count === 0 || containsLockedFolder;
            
            lockBtn.disabled = !singleSelection || firstSelectedItem.type !== 'folder';
            if (singleSelection && firstSelectedItem.type === 'folder') {
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
        return new Promise((resolve) => {
            passwordPromise.resolve = resolve;
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
        const { value: password } = passwordInput;
        const { value: oldPassword } = oldPasswordInput;
        const { value: confirmPassword } = confirmPasswordInput;
        passwordModal.style.display = 'none';
        passwordPromise.resolve({ password, oldPassword, confirmPassword });
    });

    passwordCancelBtn.addEventListener('click', () => {
        passwordModal.style.display = 'none';
        passwordPromise.resolve({password: null});
    });

    const handleKeyDown = (e) => {
        const activeElement = document.activeElement;
        const isItem = activeElement?.matches('.item-card, .list-item');
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
                const columns = getComputedStyle(itemGrid).gridTemplateColumns.split(' ').length;
                switch (e.key) {
                    case 'ArrowUp': nextIndex = Math.max(0, currentIndex - columns); break;
                    case 'ArrowDown': nextIndex = Math.min(items.length - 1, currentIndex + columns); break;
                    case 'ArrowLeft': nextIndex = Math.max(0, currentIndex - 1); break;
                    case 'ArrowRight': nextIndex = Math.min(items.length - 1, currentIndex + 1); break;
                }
            } else { 
                switch (e.key) {
                    case 'ArrowUp': nextIndex = Math.max(0, currentIndex - 1); break;
                    case 'ArrowDown': nextIndex = Math.min(items.length - 1, currentIndex + 1); break;
                }
            }
            if (nextIndex !== currentIndex) items[nextIndex]?.focus();
        }
    };
    if (dropZone) {
        dropZone.addEventListener('keydown', handleKeyDown);
        dropZone.addEventListener('focusin', (e) => {
            const target = e.target.closest('.item-card, .list-item');
            if (target && body.classList.contains('using-keyboard') && !isMultiSelectMode) {
                selectedItems.clear();
                selectedItems.set(target.dataset.id, { type: target.dataset.type, name: target.dataset.name });
                rerenderSelection();
                updateContextMenu();
            }
        });
    }

    if (listHeader) {
        listHeader.addEventListener('click', (e) => {
            const target = e.target.closest('[data-sort]');
            if (!target) return;
            const sortKey = target.dataset.sort;
            currentSort.key = sortKey;
            currentSort.order = currentSort.order === 'asc' ? 'desc' : 'asc';
            renderItems(currentFolderContents.folders, currentFolderContents.files);
        });
    }

    if (logoutBtn) logoutBtn.addEventListener('click', () => window.location.href = '/logout');
    if (changePasswordBtn) changePasswordBtn.addEventListener('click', async () => {
        const oldPassword = prompt('请输入您的旧密码：');
        if (!oldPassword) return;
        const newPassword = prompt('请输入您的新密码 (至少 4 个字元)：');
        if (!newPassword || newPassword.length < 4) return alert('密码长度至少需要 4 个字元。');
        if (newPassword !== prompt('请再次输入新密码以确认：')) return alert('两次输入的密码不一致！');
        try {
            await axios.post('/api/user/change-password', { oldPassword, newPassword });
            alert('密码修改成功！');
        } catch (error) {
            alert('密码修改失败：' + (error.response?.data?.message || '服务器错误'));
        }
    });
    
    if (fileInput) fileInput.addEventListener('change', () => {
        fileListContainer.innerHTML = Array.from(fileInput.files).map(f => `<li>${f.name}</li>`).join('');
        if (fileInput.files.length) folderInput.value = '';
    });
    if (folderInput) folderInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            const folderName = e.target.files[0].webkitRelativePath.split('/')[0];
            fileListContainer.innerHTML = `<li>已选择文件夹: <b>${folderName}</b> (包含 ${e.target.files.length} 个文件)</li>`;
            fileInput.value = '';
        }
    });
    if (uploadForm) uploadForm.addEventListener('submit', (e) => {
        e.preventDefault();
        uploadFiles(folderInput.files.length ? folderInput.files : fileInput.files, folderSelect.value, false);
    });

    if (dropZone) {
        dropZone.addEventListener('contextmenu', e => {
            e.preventDefault();
            const targetItem = e.target.closest('.item-card, .list-item');
            if (targetItem && !isMultiSelectMode && !e.ctrlKey && !e.metaKey && !selectedItems.has(targetItem.dataset.id)) {
                selectedItems.clear();
                selectedItems.set(targetItem.dataset.id, { type: targetItem.dataset.type, name: targetItem.dataset.name });
                rerenderSelection();
            } else if (!targetItem && !isMultiSelectMode) {
                selectedItems.clear();
                rerenderSelection();
            }
            updateContextMenu(targetItem);
            contextMenu.style.display = 'flex';
            const { clientX: mouseX, clientY: mouseY } = e;
            const { x, y } = dropZone.getBoundingClientRect();
            let menuX = mouseX - x, menuY = mouseY - y + dropZone.scrollTop;
            const { offsetWidth: menuWidth, offsetHeight: menuHeight } = contextMenu;
            if (menuX + menuWidth > dropZone.clientWidth) menuX = dropZone.clientWidth - menuWidth - 5;
            if (menuY + menuHeight > dropZone.scrollHeight) menuY = dropZone.scrollHeight - menuHeight - 5;
            if (menuY < dropZone.scrollTop) menuY = dropZone.scrollTop;
            contextMenu.style.top = `${menuY}px`;
            contextMenu.style.left = `${menuX}px`;
        });
        
        window.addEventListener('click', e => !contextMenu.contains(e.target) && (contextMenu.style.display = 'none'));

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eName => dropZone.addEventListener(eName, e => { e.preventDefault(); e.stopPropagation(); }));
        ['dragenter', 'dragover'].forEach(eName => dropZone.addEventListener(eName, () => dropZone.classList.add('dragover')));
        ['dragleave', 'drop'].forEach(eName => dropZone.addEventListener(eName, () => dropZone.classList.remove('dragover')));

        dropZone.addEventListener('drop', async (e) => {
            dropZone.classList.remove('dragover');
            const items = e.dataTransfer.items;
            if (!items?.length) return;
            const getFileWithRelativePath = entry => new Promise((resolve, reject) => {
                if (entry.isFile) entry.file(file => resolve([{ relativePath: (entry.fullPath.startsWith('/') ? entry.fullPath.substring(1) : entry.fullPath), file }]), reject);
                else if (entry.isDirectory) {
                    const reader = entry.createReader();
                    let allEntries = [];
                    const readEntries = () => reader.readEntries(async entries => {
                        if (entries.length) {
                            allEntries.push(...entries);
                            readEntries();
                        } else resolve((await Promise.all(allEntries.map(getFileWithRelativePath))).flat());
                    }, reject);
                    readEntries();
                } else resolve([]);
            });
            try {
                const entries = Array.from(items).map(i => i.webkitGetAsEntry());
                const allFilesData = (await Promise.all(entries.map(getFileWithRelativePath))).flat().filter(Boolean);
                
                // --- 修改：拖曳上传也需要真实的 folderId ---
                const decryptedPath = atob(currentFolderId.replace(/_/g, '/').replace(/-/g, '+'));
                const realFolderId = parseInt(decryptedPath.split('/')[1], 10);

                if (allFilesData.length) uploadFiles(allFilesData, realFolderId, true);
                else showNotification('找不到可上传的文件。', 'warn');
            } catch (error) {
                showNotification('读取拖放的文件夹时出错。', 'error');
            }
        });
    }

    if (homeLink) homeLink.addEventListener('click', e => { e.preventDefault(); window.location.href = '/'; });
    const handleItemClick = e => {
        const target = e.target.closest('.item-card, .list-item');
        if (!target) return;
        const { id, type, name } = target.dataset;
        if (isMultiSelectMode || e.ctrlKey || e.metaKey) selectedItems.has(id) ? selectedItems.delete(id) : selectedItems.set(id, { type, name });
        else { selectedItems.clear(); selectedItems.set(id, { type, name }); }
        rerenderSelection();
        updateContextMenu();
    };

    const handleItemDblClick = async e => {
        if (isMultiSelectMode) return;
        const target = e.target.closest('.item-card, .list-item');
        if (target?.dataset.type === 'folder') {
            const folderId = parseInt(target.dataset.id, 10);
            // --- 修改：在导航前先加密 ---
            const encryptedPath = btoa(`folder/${folderId}`).replace(/\+/g, '-').replace(/\//g, '_');
            if (target.dataset.isLocked === 'true' || target.dataset.isLocked === '1') {
                try {
                    const { password } = await promptForPassword(`资料夾 "${target.dataset.name}" 已加密`, '请输入密码以存取:');
                    if (password === null) return;
                    await axios.post(`/api/folder/${folderId}/verify`, { password });
                    history.pushState(null, '', `/view/${encryptedPath}`);
                    loadFolderContents(encryptedPath);
                } catch (error) { alert(error.response?.data?.message || '验证失败'); }
            } else {
                history.pushState(null, '', `/view/${encryptedPath}`);
                loadFolderContents(encryptedPath);
            }
        } else if (target?.dataset.type === 'file') {
            if (selectedItems.size !== 1) {
                selectedItems.clear();
                selectedItems.set(target.dataset.id, { type: 'file', name: target.dataset.name });
                rerenderSelection();
            }
            previewBtn.click();
        }
    };
    
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
        const link = e.target.closest('a[data-encrypted-path]');
        if (link) {
            // --- 修改：使用加密路径进行导航 ---
            const encryptedPath = link.dataset.encryptedPath;
            history.pushState(null, '', `/view/${encryptedPath}`);
            loadFolderContents(encryptedPath);
        }
    });
    window.addEventListener('popstate', () => {
        if (document.getElementById('itemGrid')) {
            const pathParts = window.location.pathname.split('/');
            // --- 修改：从 URL 直接取得加密路径 ---
            if (pathParts[1] === 'view' && pathParts[2]) loadFolderContents(pathParts[2]);
            else window.location.href = '/';
        }
    });
    if (createFolderBtn) createFolderBtn.addEventListener('click', async () => {
        contextMenu.style.display = 'none';
        const name = prompt('请输入新资料夾的名称：');
        if (name?.trim()) {
            try {
                // --- 修改：取得真实的 folderId ---
                const decryptedPath = atob(currentFolderId.replace(/_/g, '/').replace(/-/g, '+'));
                const realFolderId = parseInt(decryptedPath.split('/')[1], 10);
                await axios.post('/api/folder', { name: name.trim(), parentId: realFolderId });
                foldersLoaded = false; 
                loadFolderContents(currentFolderId);
            } catch (error) { alert(error.response?.data?.message || '建立失败'); }
        }
    });
    if (searchForm) searchForm.addEventListener('submit', e => {
        e.preventDefault();
        const query = searchInput.value.trim();
        if (query) executeSearch(query);
        else if (isSearchMode) loadFolderContents(currentFolderId);
    });
    if (selectAllBtn) selectAllBtn.addEventListener('click', () => {
        contextMenu.style.display = 'none';
        const allItems = [...currentFolderContents.folders, ...currentFolderContents.files];
        if (allItems.length > 0 && allItems.every(item => selectedItems.has(String(item.id)))) selectedItems.clear();
        else allItems.forEach(item => selectedItems.set(String(item.id), { type: item.type, name: item.name }));
        rerenderSelection();
        updateContextMenu();
    });
    if (showUploadModalBtn) showUploadModalBtn.addEventListener('click', async () => {
        await loadFoldersForSelect();
        // --- 修改：设定 select 的值为真实 ID ---
        const decryptedPath = atob(currentFolderId.replace(/_/g, '/').replace(/-/g, '+'));
        folderSelect.value = parseInt(decryptedPath.split('/')[1], 10);
        uploadNotificationArea.innerHTML = '';
        uploadForm.reset();
        fileListContainer.innerHTML = '';
        uploadSubmitBtn.style.display = 'block';
        uploadModal.style.display = 'flex';
    });
    if (closeUploadModalBtn) closeUploadModalBtn.addEventListener('click', () => uploadModal.style.display = 'none');
    if (previewBtn) previewBtn.addEventListener('click', async () => {
        if (previewBtn.disabled) return;
        contextMenu.style.display = 'none';
        const messageId = selectedItems.keys().next().value;
        const file = currentFolderContents.files.find(f => String(f.id) === messageId);
        if (!file) return;

        previewModal.style.display = 'flex';
        modalContent.innerHTML = '正在加载预览...';
        const downloadUrl = `/download/proxy/${messageId}`;

        if (file.mimetype?.startsWith('image/')) modalContent.innerHTML = `<img src="${downloadUrl}" alt="图片预览">`;
        else if (file.mimetype?.startsWith('video/')) modalContent.innerHTML = `<video src="${downloadUrl}" controls autoplay></video>`;
        else if (file.mimetype?.startsWith('text/') || isEditableFile(file.name)) {
            try {
                const res = await axios.get(`/file/content/${messageId}`);
                modalContent.innerHTML = `<pre><code>${res.data.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</code></pre>`;
            } catch { modalContent.innerHTML = '无法载入文字内容。'; }
        } else {
            modalContent.innerHTML = `<div class="no-preview"><i class="fas fa-file"></i><p>此文件类型不支持预览。</p><a href="${downloadUrl}" class="upload-link-btn" download>下载文件</a></div>`;
        }
    });
    if (renameBtn) renameBtn.addEventListener('click', async () => {
         if (renameBtn.disabled) return;
         contextMenu.style.display = 'none';
         const [id, item] = selectedItems.entries().next().value;
         const newName = prompt('请输入新的名称:', item.name);
         if (newName?.trim() && newName !== item.name) {
             try {
                await axios.post('/rename', { id, newName: newName.trim(), type: item.type });
                loadFolderContents(currentFolderId);
             } catch (error) { alert('重命名失败: ' + (error.response?.data?.message || '服务器错误')); }
         }
    });
    if (downloadBtn) downloadBtn.addEventListener('click', async () => {
        if (downloadBtn.disabled) return;
        contextMenu.style.display = 'none';
        const { files: fileIds, folders: folderIds } = Array.from(selectedItems.entries()).reduce((acc, [id, {type}]) => {
            acc[type === 'file' ? 'files' : 'folders'].push(parseInt(id));
            return acc;
        }, { files: [], folders: [] });

        if (fileIds.length === 0 && folderIds.length === 0) return;
        if (fileIds.length === 1 && folderIds.length === 0) return window.location.href = `/download/proxy/${fileIds[0]}`;
        
        try {
            const response = await axios.post('/api/download-archive', { messageIds: fileIds, folderIds }, { responseType: 'blob' });
            const url = window.URL.createObjectURL(new Blob([response.data]));
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `download-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`);
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.URL.revokeObjectURL(url);
        } catch (error) { alert('下载压缩档失败！'); }
    });
    if (deleteBtn) deleteBtn.addEventListener('click', async () => {
        if (!selectedItems.size || !confirm(`确定要删除这 ${selectedItems.size} 个项目吗？\n注意：删除资料夾将会一并删除其所有内容！`)) return;
        contextMenu.style.display = 'none';
        const { files: messageIds, folders: folderIds } = Array.from(selectedItems.entries()).reduce((acc, [id, {type}]) => {
            acc[type === 'file' ? 'files' : 'folders'].push(parseInt(id));
            return acc;
        }, { files: [], folders: [] });
        try {
            await axios.post('/delete-multiple', { messageIds, folderIds });
            loadFolderContents(currentFolderId);
        } catch (error) { alert('删除失败: ' + (error.response?.data?.message || '请重试。')); }
    });

    if (moveBtn) moveBtn.addEventListener('click', async () => {
        if (!selectedItems.size) return;
        contextMenu.style.display = 'none';
        try {
            const res = await axios.get('/api/folders');
            folderTree.innerHTML = '';
            const folders = res.data;
            const folderMap = new Map(folders.map(f => [f.id, { ...f, children: [] }]));
            const tree = [];
            folderMap.forEach(f => {
                if (f.parent_id && folderMap.has(f.parent_id)) folderMap.get(f.parent_id).children.push(f);
                else tree.push(f);
            });

            const disabledFolderIds = new Set();
            selectedItems.forEach((item, id) => {
                if (item.type === 'folder') {
                    const folderId = parseInt(id);
                    disabledFolderIds.add(folderId);
                    const findDescendants = pid => folderMap.get(pid)?.children.forEach(c => { disabledFolderIds.add(c.id); findDescendants(c.id); });
                    findDescendants(folderId);
                }
            });
            
            // --- 修改：从加密 ID 解密出真实 ID ---
            const decryptedPath = atob(currentFolderId.replace(/_/g, '/').replace(/-/g, '+'));
            const realCurrentFolderId = parseInt(decryptedPath.split('/')[1], 10);
            
            const buildTree = (node, prefix = '') => {
                const isDisabled = disabledFolderIds.has(node.id) || node.id === realCurrentFolderId;
                const item = document.createElement('div');
                item.className = 'folder-item';
                item.dataset.folderId = node.id;
                item.textContent = prefix + (node.name === '/' ? '根目录' : node.name);
                if (isDisabled) { item.style.cssText = 'color: #ccc; cursor: not-allowed;'; }
                folderTree.appendChild(item);
                node.children.sort((a,b) => a.name.localeCompare(b.name)).forEach(child => buildOptions(child, prefix + '　'));
            };
            tree.sort((a,b) => a.name.localeCompare(b.name)).forEach(buildTree);

            moveModal.style.display = 'flex';
            moveTargetFolderId = null;
            confirmMoveBtn.disabled = true;
        } catch { alert('无法获取资料夾列表。'); }
    });
    if (folderTree) folderTree.addEventListener('click', e => {
        const target = e.target.closest('.folder-item');
        if (!target || target.style.cursor === 'not-allowed') return;
        folderTree.querySelector('.folder-item.selected')?.classList.remove('selected');
        target.classList.add('selected');
        moveTargetFolderId = parseInt(target.dataset.folderId);
        confirmMoveBtn.disabled = false;
    });
    
    if (confirmMoveBtn) confirmMoveBtn.addEventListener('click', async () => {
        if (!moveTargetFolderId) return;
        const resolutions = {};
        let isAborted = false;
        let applyToAllFolderAction = null;

        async function resolveConflictsRecursively(items, targetId, prefix = '') {
            if (isAborted) return;
            const { data: { fileConflicts, folderConflicts } } = await axios.post('/api/check-move-conflict', { itemIds: items.map(i => i.id), targetFolderId: targetId });
            
            const encryptedPath = btoa(`folder/${targetId}`).replace(/\+/g, '-').replace(/\//g, '_');
            const { data: { contents } } = await axios.get(`/api/folder/${encryptedPath}`);
            const destFolderMap = new Map(contents.folders.map(f => [f.name, f.id]));

            for (const name of folderConflicts) {
                const fullPath = prefix ? `${prefix}/${name}` : name;
                let action = applyToAllFolderAction;
                if (!action) {
                    const result = await handleFolderConflict(fullPath, folderConflicts.length);
                    action = result.action;
                    if(result.applyToAll) applyToAllFolderAction = action;
                }
                if (action === 'abort') { isAborted = true; return; }
                resolutions[fullPath] = action;

                if (action === 'merge') {
                    const sourceFolder = items.find(i => i.name === name && i.type === 'folder');
                    const destSubFolderId = destFolderMap.get(name);
                    if (sourceFolder && destSubFolderId) {
                        const sourceEncrypted = btoa(`folder/${sourceFolder.id}`).replace(/\+/g, '-').replace(/\//g, '_');
                        const { data: { contents: subContents } } = await axios.get(`/api/folder/${sourceEncrypted}`);
                        const subItems = [...subContents.folders, ...subContents.files].map(i => ({ id: i.id, name: i.name, type: i.type }));
                        if(subItems.length) await resolveConflictsRecursively(subItems, destSubFolderId, fullPath);
                        if (isAborted) return;
                    }
                }
            }

            if (fileConflicts.length) {
                const result = await handleConflict(fileConflicts.map(n => prefix ? `${prefix}/${n}` : n), '档案');
                if (result.aborted) { isAborted = true; return; }
                Object.assign(resolutions, result.resolutions);
            }
        }

        try {
            const topLevelItems = Array.from(selectedItems.entries()).map(([id, { type, name }]) => ({ id: parseInt(id), type, name }));
            await resolveConflictsRecursively(topLevelItems, moveTargetFolderId);

            if (isAborted) {
                moveModal.style.display = 'none';
                return showNotification('移动操作已取消。', 'info');
            }
            const response = await axios.post('/api/move', { itemIds: topLevelItems.map(i => i.id), targetFolderId: moveTargetFolderId, resolutions });
            moveModal.style.display = 'none';
            loadFolderContents(currentFolderId);
            showNotification(response.data.message, 'success');
        } catch (error) {
            moveModal.style.display = 'none';
            alert('操作失败：' + (error.response?.data?.message || '服务器错误'));
        }
    });

    if (shareBtn && shareModal) {
        const shareOptions = document.getElementById('shareOptions');
        const shareResult = document.getElementById('shareResult');
        const expiresInSelect = document.getElementById('expiresInSelect');
        const confirmShareBtn = document.getElementById('confirmShareBtn');
        const cancelShareBtn = document.getElementById('cancelShareBtn');
        const shareLinkContainer = document.getElementById('shareLinkContainer');
        const copyLinkBtn = document.getElementById('copyLinkBtn');
        const closeShareModalBtn = document.getElementById('closeShareModalBtn');

        shareBtn.addEventListener('click', () => {
            if (shareBtn.disabled) return;
            contextMenu.style.display = 'none';
            shareOptions.style.display = 'block';
            shareResult.style.display = 'none';
            shareModal.style.display = 'flex';
        });
        cancelShareBtn.addEventListener('click', () => shareModal.style.display = 'none');
        closeShareModalBtn.addEventListener('click', () => shareModal.style.display = 'none');
        confirmShareBtn.addEventListener('click', async () => {
            const [itemId, item] = selectedItems.entries().next().value;
            try {
                const res = await axios.post('/share', { itemId, itemType: item.type, expiresIn: expiresInSelect.value });
                if (res.data.success) {
                    shareLinkContainer.textContent = res.data.url;
                    shareOptions.style.display = 'none';
                    shareResult.style.display = 'block';
                } else alert('创建分享链接失败: ' + res.data.message);
            } catch { alert('创建分享链接请求失败'); }
        });
        copyLinkBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(shareLinkContainer.textContent).then(() => {
                copyLinkBtn.textContent = '已复制!';
                setTimeout(() => { copyLinkBtn.textContent = '复制链接'; }, 2000);
            });
        });
    }
    if (closeModal) closeModal.onclick = () => {
        previewModal.style.display = 'none';
        modalContent.innerHTML = '';
    };
    if (cancelMoveBtn) cancelMoveBtn.addEventListener('click', () => moveModal.style.display = 'none');

    if (textEditBtn) textEditBtn.addEventListener('click', () => {
        contextMenu.style.display = 'none';
        const selectionCount = selectedItems.size;
        // --- 修改：取得真实的 folderId ---
        const decryptedPath = atob(currentFolderId.replace(/_/g, '/').replace(/-/g, '+'));
        const realFolderId = parseInt(decryptedPath.split('/')[1], 10);

        if (selectionCount === 0) window.open(`/editor?mode=create&folderId=${realFolderId}`, '_blank');
        else if (selectionCount === 1 && isEditableFile(selectedItems.values().next().value.name)) {
            const fileId = selectedItems.keys().next().value;
            window.open(`/editor?mode=edit&fileId=${fileId}`, '_blank');
        }
    });

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
                    loadFolderContents(currentFolderId);
                } catch { alert('密码错误或操作失败。'); }
            } else if (action === 'change') {
                const { password, oldPassword, confirmPassword } = await promptForPassword(`修改密码`, `为 "${folderName}" 设定新密码:`, true, true);
                if (password === null || password !== confirmPassword) return alert('操作取消或两次输入的新密码不匹配！');
                try {
                    await axios.post(`/api/folder/${folderId}/lock`, { oldPassword, password });
                    showNotification('密码修改成功。', 'success');
                } catch (error) { alert('操作失败: ' + (error.response?.data?.message || '未知错误')); }
            }
        } else {
            const { password, confirmPassword } = await promptForPassword(`加密资料夾`, `为 "${folderName}" 设定一个新密码 (至少4个字元):`, false, true);
            if (password === null || password !== confirmPassword) return alert('操作取消或两次输入的新密码不匹配！');
            try {
                await axios.post(`/api/folder/${folderId}/lock`, { password });
                showNotification('资料夾已成功加密。', 'success');
                loadFolderContents(currentFolderId);
            } catch (error) { alert('加密失败: ' + (error.response?.data?.message || '未知错误')); }
        }
    });

    window.addEventListener('message', e => e.data === 'refresh-files' && loadFolderContents(currentFolderId));
    
    if (document.getElementById('itemGrid')) {
        const pathParts = window.location.pathname.split('/');
        // --- 修改：直接使用 URL 中的加密路径初始化 ---
        if(pathParts[1] === 'view' && pathParts[2]) loadFolderContents(pathParts[2]);
        else window.location.href = '/';
    }
});
