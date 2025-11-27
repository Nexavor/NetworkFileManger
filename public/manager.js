document.addEventListener('DOMContentLoaded', () => {
    // --- 全局变量 ---
    const dropZone = document.getElementById('dropZone');
    const itemGrid = document.getElementById('itemGrid');
    const itemListBody = document.getElementById('itemListBody');
    const itemListView = document.getElementById('itemListView');
    const breadcrumb = document.getElementById('breadcrumb');
    const searchForm = document.getElementById('searchForm');
    const searchInput = document.getElementById('searchInput');
    const contextMenu = document.getElementById('contextMenu');
    const dropZoneOverlay = document.getElementById('dropZoneOverlay');
    const viewSwitchBtn = document.getElementById('view-switch-btn');
    const changePasswordBtn = document.getElementById('changePasswordBtn');
    const showUploadModalBtn = document.getElementById('showUploadModalBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    
    // 模态框元素
    const previewModal = document.getElementById('previewModal');
    const previewModalContent = document.getElementById('modalContent');
    const closePreviewBtn = previewModal.querySelector('.close-button');
    
    const uploadModal = document.getElementById('uploadModal');
    const closeUploadModalBtn = document.getElementById('closeUploadModalBtn');
    const uploadForm = document.getElementById('uploadForm');
    const fileInput = document.getElementById('fileInput');
    const folderInput = document.getElementById('folderInput');
    const folderSelect = document.getElementById('folderSelect');
    const fileSelectionList = document.getElementById('file-selection-list');
    const progressBar = document.getElementById('progressBar');
    const progressArea = document.getElementById('progressArea');
    const uploadNotificationArea = document.getElementById('uploadNotificationArea');
    const uploadSubmitBtn = document.getElementById('uploadSubmitBtn');
    
    const moveModal = document.getElementById('moveModal');
    const moveModalTitle = document.getElementById('moveModalTitle');
    const folderTree = document.getElementById('folderTree');
    const confirmMoveBtn = document.getElementById('confirmMoveBtn');
    const cancelMoveBtn = document.getElementById('cancelMoveBtn');

    const passwordModal = document.getElementById('passwordModal');
    const passwordForm = document.getElementById('passwordForm');
    const passwordInput = document.getElementById('passwordInput');
    const oldPasswordContainer = document.getElementById('oldPasswordContainer');
    const oldPasswordInput = document.getElementById('oldPasswordInput');
    const confirmPasswordContainer = document.getElementById('confirmPasswordContainer');
    const confirmPasswordInput = document.getElementById('confirmPasswordInput');
    const passwordModalTitle = document.getElementById('passwordModalTitle');
    const passwordPromptText = document.getElementById('passwordPromptText');
    const passwordCancelBtn = document.getElementById('passwordCancelBtn');
    
    const shareModal = document.getElementById('shareModal');
    const expiresInSelect = document.getElementById('expiresInSelect');
    const customExpiresInput = document.getElementById('customExpiresInput');
    const sharePasswordInput = document.getElementById('sharePasswordInput');
    const confirmShareBtn = document.getElementById('confirmShareBtn');
    const cancelShareBtn = document.getElementById('cancelShareBtn');
    const shareOptions = document.getElementById('shareOptions');
    const shareResult = document.getElementById('shareResult');
    const shareLinkContainer = document.getElementById('shareLinkContainer');
    const copyLinkBtn = document.getElementById('copyLinkBtn');
    const closeShareModalBtn = document.getElementById('closeShareModalBtn');

    // 冲突处理模态框
    const conflictModal = document.getElementById('conflictModal');
    const conflictFileName = document.getElementById('conflictFileName');
    const conflictOptions = document.getElementById('conflictOptions');
    const applyToAllCheckbox = document.getElementById('applyToAllCheckbox');

    const folderConflictModal = document.getElementById('folderConflictModal');
    const folderConflictName = document.getElementById('folderConflictName');
    const folderConflictOptions = document.getElementById('folderConflictOptions');
    const applyToAllFoldersCheckbox = document.getElementById('applyToAllFoldersCheckbox');

    // 上下文菜单按钮
    const createFolderBtn = document.getElementById('createFolderBtn');
    const textEditBtn = document.getElementById('textEditBtn');
    const openBtn = document.getElementById('openBtn');
    const previewBtnContext = document.getElementById('previewBtn');
    const copyBtn = document.getElementById('copyBtn');
    const lockBtn = document.getElementById('lockBtn');
    const moveBtn = document.getElementById('moveBtn');
    const shareBtn = document.getElementById('shareBtn');
    const renameBtn = document.getElementById('renameBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const deleteBtn = document.getElementById('deleteBtn');
    const selectAllBtn = document.getElementById('selectAllBtn');
    const multiSelectToggleBtn = document.getElementById('multiSelectToggleBtn');

    // 配额相关
    const quotaContainer = document.getElementById('quotaContainer');
    const quotaText = document.getElementById('quotaText');
    const quotaFill = document.getElementById('quotaFill');

    // 状态变量
    let currentEncryptedFolderId = null; 
    let currentPath = [];
    let currentViewMode = localStorage.getItem('viewMode') || 'grid';
    let currentSort = { field: 'name', direction: 'asc' };
    let selectedItems = new Map();
    let isMultiSelectMode = false;
    let lastClickedItemId = null; 
    let allItems = []; 
    
    // 移动/复制/密码/冲突 操作相关变量
    let moveTargetFolderId = null;
    let isCopyOperation = false;
    let passwordCallback = null;
    let currentConflictResolutions = {}; // { relativePath: 'overwrite' | 'rename' | 'skip' }
    let conflictQueue = []; // 待处理的冲突列表
    let currentConflictCallback = null; // 解决当前冲突后的回调

    // Axios 拦截器
    axios.interceptors.response.use(response => response, error => {
        if (error.response && error.response.status === 401) {
            window.location.href = '/login';
            return new Promise(() => {});
        }
        return Promise.reject(error);
    });

    // --- 初始化 ---
    function init() {
        setupEventListeners();
        setupDragAndDrop();
        
        const pathParts = window.location.pathname.split('/');
        if (pathParts.length > 2 && pathParts[1] === 'view') {
            const encryptedId = pathParts[2];
            loadFolderContents(encryptedId);
        } else {
             window.location.href = '/';
        }
        
        updateViewModeUI();
        updateQuota();
    }

    // --- 核心功能：加载内容 ---
    async function loadFolderContents(encryptedFolderId) {
        if (!encryptedFolderId) return;
        currentEncryptedFolderId = encryptedFolderId;

        itemGrid.innerHTML = '<div class="loading-message"><i class="fas fa-spinner fa-spin"></i> 正在加载...</div>';
        itemListBody.innerHTML = '';
        
        try {
            const response = await axios.get(`/api/folder/${encryptedFolderId}`);
            
            if (response.data.locked) {
                currentPath = response.data.path;
                renderBreadcrumb();
                itemGrid.innerHTML = `
                    <div class="locked-folder-message">
                        <i class="fas fa-lock fa-3x"></i>
                        <h3>此资料夾已上锁</h3>
                        <p>请输入密码以检视内容</p>
                        <button id="unlockFolderBtn" class="primary-btn">解锁</button>
                    </div>
                `;
                document.getElementById('unlockFolderBtn').addEventListener('click', () => promptForPassword(encryptedFolderId, 'unlock'));
                updateQuota();
                return;
            }

            const { contents, path } = response.data;
            currentPath = path;
            allItems = [...contents.folders, ...contents.files];
            
            renderBreadcrumb();
            renderItems(allItems);
            clearSelection();
            updateQuota();

        } catch (error) {
            console.error('加载失败:', error);
            itemGrid.innerHTML = '<div class="error-message">加载失败，请重试。</div>';
            if (error.response && error.response.status === 404) {
                 alert('资料夾不存在');
                 window.location.href = '/';
            }
        }
    }

    // --- 核心功能：配额更新 ---
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

    // --- 渲染逻辑 ---
    function renderItems(items) {
        items.sort((a, b) => {
            let valA = a[currentSort.field];
            let valB = b[currentSort.field];
            if (typeof valA === 'string') valA = valA.toLowerCase();
            if (typeof valB === 'string') valB = valB.toLowerCase();
            if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
            if (valA > valB) return currentSort.direction === 'asc' ? 1 : -1;
            return 0;
        });

        itemGrid.innerHTML = '';
        items.forEach(item => itemGrid.appendChild(createGridItemElement(item)));

        itemListBody.innerHTML = '';
        items.forEach(item => itemListBody.appendChild(createListItemElement(item)));
        
        if(items.length === 0) {
            itemGrid.innerHTML = '<div class="empty-folder">此文件夹为空</div>';
            itemListBody.innerHTML = '<div class="empty-folder">此文件夹为空</div>';
        }
    }

    function createGridItemElement(item) {
        const div = document.createElement('div');
        div.className = 'grid-item';
        div.dataset.id = item.id || item.message_id;
        div.dataset.type = item.type;
        div.dataset.name = item.name || item.fileName;
        if (item.encrypted_id) div.dataset.encryptedId = item.encrypted_id;
        
        if (selectedItems.has(getUniqueId(item))) div.classList.add('selected');

        let iconClass = 'fa-file';
        if (item.type === 'folder') {
            iconClass = item.is_locked ? 'fa-folder-open' : 'fa-folder';
            if(item.is_locked) div.classList.add('locked');
        } else {
            iconClass = getFileIconClass(item.name || item.fileName);
        }

        let iconHtml = `<i class="fas ${iconClass}"></i>`;
        if (item.type === 'file' && isImage(item.name) && item.storage_type === 'telegram' && item.thumb_file_id) {
             div.classList.add('has-thumbnail');
             iconHtml = `<img src="/thumbnail/${item.message_id}" loading="lazy" alt="${item.name}">`;
        }

        div.innerHTML = `
            <div class="item-icon">${iconHtml}</div>
            <div class="item-name">${escapeHtml(item.name || item.fileName)}</div>
            ${item.is_locked ? '<i class="fas fa-lock item-lock-indicator"></i>' : ''}
        `;

        addItemEventListeners(div, item);
        return div;
    }

    function createListItemElement(item) {
        const div = document.createElement('div');
        div.className = 'list-item';
        div.dataset.id = item.id || item.message_id;
        div.dataset.type = item.type;
        div.dataset.name = item.name || item.fileName;
        if (item.encrypted_id) div.dataset.encryptedId = item.encrypted_id;

        if (selectedItems.has(getUniqueId(item))) div.classList.add('selected');

        let iconClass = item.type === 'folder' ? (item.is_locked ? 'fa-lock' : 'fa-folder') : getFileIconClass(item.name);
        const dateStr = item.date ? new Date(item.date).toLocaleString() : '-';
        const sizeStr = item.size ? formatBytes(item.size) : '-';

        div.innerHTML = `
            <div class="list-col-icon"><i class="fas ${iconClass}"></i></div>
            <div class="list-col-name">${escapeHtml(item.name || item.fileName)}</div>
            <div class="list-col-size">${item.type === 'folder' ? '-' : sizeStr}</div>
            <div class="list-col-date">${dateStr}</div>
        `;

        addItemEventListeners(div, item);
        return div;
    }
    
    function addItemEventListeners(element, item) {
        element.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.ctrlKey || e.metaKey || isMultiSelectMode) {
                toggleSelection(item, element);
            } else if (e.shiftKey && lastClickedItemId) {
                selectRange(lastClickedItemId, getUniqueId(item));
            } else {
                clearSelection();
                selectItem(item, element);
            }
            lastClickedItemId = getUniqueId(item);
        });

        element.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (item.type === 'folder') {
                if (item.is_locked) promptForPassword(item.encrypted_id, 'unlock');
                else loadFolderContents(item.encrypted_id);
            } else {
                previewFile(item);
            }
        });

        element.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!selectedItems.has(getUniqueId(item))) {
                clearSelection();
                selectItem(item, element);
            }
            showContextMenu(e.pageX, e.pageY);
        });
    }

    function renderBreadcrumb() {
        breadcrumb.innerHTML = '';
        const homeLink = document.createElement('a');
        homeLink.href = '#';
        homeLink.innerHTML = '<i class="fas fa-home"></i>';
        homeLink.addEventListener('click', (e) => { e.preventDefault(); window.location.href = '/'; });
        breadcrumb.appendChild(homeLink);

        currentPath.forEach((folder, index) => {
            const separator = document.createElement('span');
            separator.className = 'separator';
            separator.textContent = '/';
            breadcrumb.appendChild(separator);

            if (index === currentPath.length - 1) {
                const span = document.createElement('span');
                span.className = 'current';
                span.textContent = folder.name;
                breadcrumb.appendChild(span);
            } else {
                const a = document.createElement('a');
                a.href = '#';
                a.textContent = folder.name;
                a.addEventListener('click', (e) => { e.preventDefault(); loadFolderContents(folder.encrypted_id); });
                breadcrumb.appendChild(a);
            }
        });
    }

    // --- 选择逻辑 ---
    function getUniqueId(item) { return `${item.type}-${item.id || item.message_id}`; }

    function selectItem(item, element) {
        selectedItems.set(getUniqueId(item), { ...item, element });
        updateElementSelectionVisuals();
        updateContextMenuButtons();
    }

    function toggleSelection(item, element) {
        const uid = getUniqueId(item);
        if (selectedItems.has(uid)) selectedItems.delete(uid);
        else selectedItems.set(uid, { ...item, element });
        updateElementSelectionVisuals();
        updateContextMenuButtons();
    }

    function clearSelection() {
        selectedItems.clear();
        updateElementSelectionVisuals();
        updateContextMenuButtons();
    }
    
    function selectRange(startUid, endUid) {
        const startIndex = allItems.findIndex(i => getUniqueId(i) === startUid);
        const endIndex = allItems.findIndex(i => getUniqueId(i) === endUid);
        if (startIndex === -1 || endIndex === -1) return;
        const min = Math.min(startIndex, endIndex);
        const max = Math.max(startIndex, endIndex);
        for (let i = min; i <= max; i++) {
            const item = allItems[i];
            selectedItems.set(getUniqueId(item), item);
        }
        updateElementSelectionVisuals();
        updateContextMenuButtons();
    }

    function updateElementSelectionVisuals() {
        document.querySelectorAll('.grid-item.selected, .list-item.selected').forEach(el => el.classList.remove('selected'));
        selectedItems.forEach((val, key) => {
            const [type, id] = key.split('-');
            const selector = `[data-id="${id}"][data-type="${type}"]`;
            document.querySelectorAll(selector).forEach(el => el.classList.add('selected'));
        });
        if (isMultiSelectMode) multiSelectToggleBtn.classList.add('active');
        else multiSelectToggleBtn.classList.remove('active');
    }

    function showContextMenu(x, y) {
        const winWidth = window.innerWidth;
        const winHeight = window.innerHeight;
        const menuWidth = contextMenu.offsetWidth;
        const menuHeight = contextMenu.offsetHeight;
        if (x + menuWidth > winWidth) x = winWidth - menuWidth - 10;
        if (y + menuHeight > winHeight) y = winHeight - menuHeight - 10;
        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
        contextMenu.classList.add('visible');
        updateContextMenuButtons();
    }

    function hideContextMenu() { contextMenu.classList.remove('visible'); }

    function updateContextMenuButtons() {
        const count = selectedItems.size;
        const firstItem = count > 0 ? selectedItems.values().next().value : null;
        document.getElementById('selectionInfo').textContent = count > 0 ? `已选择 ${count} 个项目` : '';
        
        openBtn.disabled = count !== 1 || firstItem.type !== 'folder';
        previewBtnContext.disabled = count !== 1 || firstItem.type !== 'file';
        copyBtn.disabled = count === 0;
        lockBtn.disabled = count !== 1 || firstItem.type !== 'folder';
        if (count === 1 && firstItem.type === 'folder') {
             lockBtn.querySelector('.button-text').textContent = firstItem.is_locked ? '解锁/修改密码' : '加密';
        }
        moveBtn.disabled = count === 0;
        shareBtn.disabled = count !== 1;
        renameBtn.disabled = count !== 1;
        downloadBtn.disabled = count === 0;
        deleteBtn.disabled = count === 0;
        selectAllBtn.querySelector('.button-text').textContent = (count === allItems.length && count > 0) ? '取消全选' : '全选';
    }

    // --- 事件监听器 ---
    function setupEventListeners() {
        dropZone.addEventListener('click', (e) => {
            if (!e.target.closest('.grid-item') && !e.target.closest('.list-item')) {
                 clearSelection();
                 hideContextMenu();
            }
        });
        
        dropZone.addEventListener('contextmenu', (e) => {
             e.preventDefault();
             if (!e.target.closest('.grid-item') && !e.target.closest('.list-item')) {
                 clearSelection();
                 showContextMenu(e.pageX, e.pageY);
             }
        });

        document.addEventListener('click', hideContextMenu);
        
        viewSwitchBtn.addEventListener('click', () => {
            currentViewMode = currentViewMode === 'grid' ? 'list' : 'grid';
            localStorage.setItem('viewMode', currentViewMode);
            updateViewModeUI();
        });
        
        document.querySelectorAll('.list-header div[data-sort]').forEach(header => {
            header.addEventListener('click', () => {
                const field = header.dataset.sort;
                if (currentSort.field === field) currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
                else { currentSort.field = field; currentSort.direction = 'asc'; }
                renderItems(allItems);
            });
        });

        searchForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const query = searchInput.value.trim();
            if (!query) return;
            try {
                const res = await axios.get(`/api/search?q=${encodeURIComponent(query)}`);
                currentPath = res.data.path;
                allItems = [...res.data.contents.folders, ...res.data.contents.files];
                renderBreadcrumb();
                renderItems(allItems);
                clearSelection();
            } catch (err) { alert('搜寻失败'); }
        });

        createFolderBtn.addEventListener('click', createFolder);
        textEditBtn.addEventListener('click', () => window.open('/editor', '_blank'));
        openBtn.addEventListener('click', () => {
             const item = selectedItems.values().next().value;
             if(item) loadFolderContents(item.encrypted_id);
        });
        previewBtnContext.addEventListener('click', () => previewFile(selectedItems.values().next().value));
        copyBtn.addEventListener('click', () => { if (selectedItems.size > 0) openMoveCopyModal(true); });
        moveBtn.addEventListener('click', () => { if (selectedItems.size > 0) openMoveCopyModal(false); });
        lockBtn.addEventListener('click', () => {
             const item = selectedItems.values().next().value;
             if (item.is_locked) promptForPassword(item.id, 'lock_settings');
             else promptForPassword(item.id, 'set_lock');
        });
        shareBtn.addEventListener('click', () => openShareModal(selectedItems.values().next().value));
        renameBtn.addEventListener('click', () => {
            const item = selectedItems.values().next().value;
            const newName = prompt('请输入新名称:', item.name || item.fileName);
            if (newName && newName !== (item.name || item.fileName)) renameItem(item, newName);
        });
        downloadBtn.addEventListener('click', downloadSelected);
        deleteBtn.addEventListener('click', deleteSelected);
        selectAllBtn.addEventListener('click', () => {
            if (selectedItems.size === allItems.length) clearSelection();
            else { allItems.forEach(item => selectedItems.set(getUniqueId(item), item)); updateElementSelectionVisuals(); updateContextMenuButtons(); }
        });
        multiSelectToggleBtn.addEventListener('click', () => { isMultiSelectMode = !isMultiSelectMode; updateElementSelectionVisuals(); });

        closePreviewBtn.addEventListener('click', () => { previewModal.style.display = 'none'; previewModalContent.innerHTML = ''; });
        window.addEventListener('click', (e) => {
            if (e.target === previewModal) { previewModal.style.display = 'none'; previewModalContent.innerHTML = ''; }
            if (e.target === uploadModal) uploadModal.style.display = 'none';
            if (e.target === moveModal) moveModal.style.display = 'none';
            if (e.target === shareModal) shareModal.style.display = 'none';
            if (e.target === passwordModal) passwordModal.style.display = 'none';
            if (e.target === conflictModal) abortConflictResolution();
            if (e.target === folderConflictModal) abortConflictResolution();
        });

        showUploadModalBtn.addEventListener('click', () => {
             loadFolderOptions();
             uploadModal.style.display = 'block';
        });
        closeUploadModalBtn.addEventListener('click', () => uploadModal.style.display = 'none');
        
        fileInput.addEventListener('change', handleFileSelect);
        folderInput.addEventListener('change', handleFileSelect);
        uploadForm.addEventListener('submit', (e) => { e.preventDefault(); initiateUploadProcess(); });

        cancelMoveBtn.addEventListener('click', () => moveModal.style.display = 'none');
        confirmMoveBtn.addEventListener('click', initiateMoveCopyProcess);
        
        passwordCancelBtn.addEventListener('click', () => { passwordModal.style.display = 'none'; passwordCallback = null; });
        passwordForm.addEventListener('submit', (e) => { e.preventDefault(); if (passwordCallback) passwordCallback(); });
        
        expiresInSelect.addEventListener('change', () => { customExpiresInput.style.display = expiresInSelect.value === 'custom' ? 'block' : 'none'; });
        cancelShareBtn.addEventListener('click', () => shareModal.style.display = 'none');
        closeShareModalBtn.addEventListener('click', () => shareModal.style.display = 'none');
        confirmShareBtn.addEventListener('click', generateShareLink);
        copyLinkBtn.addEventListener('click', () => navigator.clipboard.writeText(shareLinkContainer.textContent).then(() => alert('已复制')));
        
        logoutBtn.addEventListener('click', () => window.location.href = '/logout');
        changePasswordBtn.addEventListener('click', changeUserPassword);
        
        // 冲突模态框按钮事件代理
        conflictOptions.addEventListener('click', (e) => {
            if(e.target.tagName === 'BUTTON') resolveConflict(e.target.dataset.action);
        });
        folderConflictOptions.addEventListener('click', (e) => {
            if(e.target.tagName === 'BUTTON') resolveConflict(e.target.dataset.action);
        });
    }

    function updateViewModeUI() {
        if (currentViewMode === 'grid') {
            itemGrid.style.display = 'grid';
            itemListView.style.display = 'none';
            viewSwitchBtn.innerHTML = '<i class="fas fa-list"></i>';
            viewSwitchBtn.title = '切换至列表视图';
        } else {
            itemGrid.style.display = 'none';
            itemListView.style.display = 'block';
            viewSwitchBtn.innerHTML = '<i class="fas fa-th"></i>';
            viewSwitchBtn.title = '切换至网格视图';
        }
    }

    function setupDragAndDrop() {
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, preventDefaults, false);
            document.body.addEventListener(eventName, preventDefaults, false);
        });
        dropZone.addEventListener('dragenter', highlight, false);
        dropZone.addEventListener('dragover', highlight, false);
        dropZone.addEventListener('dragleave', unhighlight, false);
        dropZone.addEventListener('drop', handleDrop, false);
    }

    function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
    function highlight() { dropZoneOverlay.classList.add('active'); }
    function unhighlight() { dropZoneOverlay.classList.remove('active'); }

    function handleDrop(e) {
        unhighlight();
        const files = e.dataTransfer.files;
        if (files.length > 0) {
            fileInput.files = files; 
            handleFileSelect({ target: { files: files } });
            uploadModal.style.display = 'block';
            loadFolderOptions();
        }
    }

    // --- 文件操作逻辑 ---
    async function createFolder() {
        const name = prompt('请输入文件夹名称:');
        if (!name) return;
        let parentId = currentPath.length > 0 ? currentPath[currentPath.length - 1].id : 1;
        try {
            await axios.post('/api/folder', { name, parentId });
            loadFolderContents(currentEncryptedFolderId);
        } catch (err) { alert(err.response?.data?.message || '建立失败'); }
    }

    async function renameItem(item, newName) {
        try {
            await axios.post('/rename', { id: item.id || item.message_id, type: item.type, newName });
            loadFolderContents(currentEncryptedFolderId);
        } catch (err) { alert(err.response?.data?.message || '重命名失败'); }
    }

    async function deleteSelected() {
        if (!confirm(`确定要删除选中的 ${selectedItems.size} 个项目吗？`)) return;
        const messageIds = [];
        const folderIds = [];
        selectedItems.forEach(item => {
            if (item.type === 'file') messageIds.push(item.message_id);
            else folderIds.push(item.id);
        });
        try {
            await axios.post('/delete-multiple', { messageIds, folderIds });
            loadFolderContents(currentEncryptedFolderId);
            updateQuota();
        } catch (err) { alert(err.response?.data?.message || '删除失败'); }
    }

    async function downloadSelected() {
        const items = Array.from(selectedItems.values());
        if (items.length === 0) return;
        if (items.length === 1 && items[0].type === 'file') {
            window.location.href = `/download/proxy/${items[0].message_id}`;
        } else {
            const messageIds = items.filter(i => i.type === 'file').map(i => i.message_id);
            const folderIds = items.filter(i => i.type === 'folder').map(i => i.id);
            try {
                const response = await axios.post('/api/download-archive', { messageIds, folderIds }, { responseType: 'blob' });
                const url = window.URL.createObjectURL(new Blob([response.data]));
                const link = document.createElement('a');
                link.href = url;
                link.setAttribute('download', 'download.zip');
                document.body.appendChild(link);
                link.click();
                link.remove();
            } catch (err) { alert('打包下载失败'); }
        }
    }

    function previewFile(item) {
        if (!item || item.type !== 'file') return;
        const fileExt = item.fileName.split('.').pop().toLowerCase();
        const mime = item.mimetype || '';
        previewModalContent.innerHTML = '<div class="loading">加载预览...</div>';
        previewModal.style.display = 'block';

        if (isImage(item.fileName)) {
            previewModalContent.innerHTML = `<img src="/download/proxy/${item.message_id}" class="preview-image" alt="${item.fileName}">`;
        } else if (mime.startsWith('video/')) {
            previewModalContent.innerHTML = `
                <video controls autoplay class="preview-video">
                    <source src="/download/proxy/${item.message_id}" type="${mime}">
                    您的浏览器不支持视频播放。
                </video>`;
        } else if (mime.startsWith('text/') || ['js','css','html','json','md','txt'].includes(fileExt)) {
             axios.get(`/file/content/${item.message_id}`).then(res => {
                 previewModalContent.innerHTML = `<pre class="preview-text">${escapeHtml(res.data)}</pre>`;
             }).catch(err => {
                 previewModalContent.innerHTML = '<div class="error">无法加载预览</div>';
             });
        } else if (mime === 'application/pdf') {
             previewModalContent.innerHTML = `<iframe src="/download/proxy/${item.message_id}" class="preview-iframe"></iframe>`;
        } else {
             previewModalContent.innerHTML = `
                <div class="no-preview">
                    <i class="fas fa-file fa-4x"></i>
                    <p>此文件类型不支持预览</p>
                    <a href="/download/proxy/${item.message_id}" class="primary-btn">下载文件</a>
                </div>
             `;
        }
    }

    // --- 移动/复制 逻辑 (含冲突处理) ---
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
            folderTree.innerHTML = buildTreeHtml(folders, root.id);
            folderTree.querySelectorAll('.folder-tree-item').forEach(el => {
                el.addEventListener('click', () => {
                    folderTree.querySelectorAll('.folder-tree-item').forEach(e => e.classList.remove('selected'));
                    el.classList.add('selected');
                    moveTargetFolderId = el.dataset.id;
                    confirmMoveBtn.disabled = false;
                });
            });
        } catch (err) { folderTree.innerHTML = '<div class="error">加载失败</div>'; }
    }
    
    function buildTreeHtml(folders, parentId, level = 0) {
        const children = folders.filter(f => f.parent_id === parentId);
        let html = '';
        if (level === 0) {
            const root = folders.find(f => f.id === parentId);
            if (root) html += `<div class="folder-tree-item" style="padding-left: ${level * 20}px" data-id="${root.id}"><i class="fas fa-folder"></i> ${root.name}</div>`;
        }
        children.forEach(child => {
             html += `<div class="folder-tree-item" style="padding-left: ${(level + 1) * 20}px" data-id="${child.id}"><i class="fas fa-folder"></i> ${child.name}</div>`;
             html += buildTreeHtml(folders, child.id, level + 1);
        });
        return html;
    }

    // 触发移动/复制流程
    async function initiateMoveCopyProcess() {
        if (!moveTargetFolderId) return;
        confirmMoveBtn.disabled = true;
        
        const itemIds = Array.from(selectedItems.values()).map(item => item.id || item.message_id);
        
        try {
            // 1. 检查冲突
            const checkRes = await axios.post('/api/check-move-conflict', { itemIds, targetFolderId: moveTargetFolderId });
            const { fileConflicts, folderConflicts } = checkRes.data;
            
            conflictQueue = [];
            currentConflictResolutions = {};
            
            // 将冲突加入队列
            if (fileConflicts && fileConflicts.length > 0) {
                fileConflicts.forEach(name => conflictQueue.push({ type: 'file', name, relativePath: name }));
            }
            if (folderConflicts && folderConflicts.length > 0) {
                folderConflicts.forEach(name => conflictQueue.push({ type: 'folder', name, relativePath: name }));
            }

            // 开始处理冲突队列
            processConflictQueue(() => {
                // 所有冲突解决后，执行实际操作
                executeMoveOrCopyFinal(itemIds);
            });
            
        } catch (err) {
            alert('检查冲突失败: ' + err.message);
            confirmMoveBtn.disabled = false;
        }
    }
    
    // 执行最终的 API 调用
    async function executeMoveOrCopyFinal(itemIds) {
        const endpoint = isCopyOperation ? '/api/copy' : '/api/move';
        const payload = { 
            itemIds, 
            targetFolderId: moveTargetFolderId,
            resolutions: currentConflictResolutions 
        };
        
        try {
            confirmMoveBtn.textContent = "处理中...";
            await axios.post(endpoint, payload);
            
            moveModal.style.display = 'none';
            loadFolderContents(currentEncryptedFolderId);
            updateQuota();
            showNotification(isCopyOperation ? '复制成功' : '移动成功', 'success');
        } catch (err) {
            alert((isCopyOperation ? '复制' : '移动') + '失败: ' + (err.response?.data?.message || err.message));
        } finally {
            confirmMoveBtn.textContent = isCopyOperation ? "确定复制" : "确定移动";
            confirmMoveBtn.disabled = false;
        }
    }

    // --- 上传逻辑 (含冲突处理) ---
    function handleFileSelect(e) {
        const files = e.target.files;
        fileSelectionList.innerHTML = '';
        if (files.length === 0) {
            fileSelectionList.innerHTML = '<li>未选择文件</li>';
            return;
        }
        for (let i = 0; i < Math.min(files.length, 10); i++) {
            const li = document.createElement('li');
            li.textContent = files[i].name;
            fileSelectionList.appendChild(li);
        }
        if (files.length > 10) {
            const li = document.createElement('li');
            li.textContent = `... 以及其他 ${files.length - 10} 个文件`;
            fileSelectionList.appendChild(li);
        }
    }
    
    async function loadFolderOptions() {
        let currentId = currentPath.length > 0 ? currentPath[currentPath.length - 1].id : 1;
        folderSelect.innerHTML = '';
        const currentOption = document.createElement('option');
        currentOption.value = currentId;
        currentOption.textContent = '当前目录';
        currentOption.selected = true;
        folderSelect.appendChild(currentOption);
    }
    
    // 触发上传流程
    async function initiateUploadProcess() {
        const files = fileInput.files;
        const folderFiles = folderInput.files;
        const targetFolderId = folderSelect.value;
        const caption = document.getElementById('uploadCaption').value;
        
        let allFiles = [];
        if (files.length > 0) allFiles = [...files];
        if (folderFiles.length > 0) allFiles = [...allFiles, ...folderFiles];
        
        if (allFiles.length === 0) { alert('请选择要上传的文件'); return; }

        uploadSubmitBtn.disabled = true;
        uploadSubmitBtn.textContent = "检查冲突...";

        // 构造检查列表
        const filesToCheck = allFiles.map(f => ({
            name: f.name,
            relativePath: f.webkitRelativePath || f.name
        }));

        try {
            // 1. 检查冲突
            const checkRes = await axios.post('/api/check-existence', { files: filesToCheck, folderId: targetFolderId });
            const existingFiles = checkRes.data.files.filter(f => f.exists);
            
            conflictQueue = [];
            currentConflictResolutions = {};
            
            existingFiles.forEach(f => {
                conflictQueue.push({ type: 'file', name: f.name, relativePath: f.relativePath });
            });

            // 开始处理冲突
            processConflictQueue(() => {
                executeUploadFinal(allFiles, targetFolderId, caption);
            });

        } catch (err) {
            alert('检查上传冲突失败: ' + err.message);
            uploadSubmitBtn.disabled = false;
            uploadSubmitBtn.textContent = "上传";
        }
    }

    async function executeUploadFinal(allFiles, targetFolderId, caption) {
        uploadForm.style.display = 'none';
        progressArea.style.display = 'block';
        uploadNotificationArea.innerHTML = '';

        const formData = new FormData();
        allFiles.forEach(file => {
            const path = file.webkitRelativePath || file.name;
            // 如果被跳过，则不添加到 FormData (节省带宽)
            // 注意：Busboy 是流式处理，如果全量上传但 resolutions 说 skip，服务器会丢弃。
            // 简单起见，这里全部上传，由服务器根据 query params 决定。
            formData.append(path, file);
        });
        
        const resolutionsJson = JSON.stringify(currentConflictResolutions);
        
        try {
            const res = await axios.post(`/upload?folderId=${targetFolderId}&caption=${encodeURIComponent(caption)}&resolutions=${encodeURIComponent(resolutionsJson)}`, formData, {
                headers: { 'Content-Type': 'multipart/form-data' },
                onUploadProgress: (progressEvent) => {
                    const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                    progressBar.style.width = percentCompleted + '%';
                    progressBar.textContent = percentCompleted + '%';
                }
            });
            
            if (res.data.success) {
                uploadNotificationArea.innerHTML = '<div class="success-message">上传成功!</div>';
                setTimeout(() => {
                    uploadModal.style.display = 'none';
                    uploadForm.reset();
                    uploadForm.style.display = 'block';
                    progressArea.style.display = 'none';
                    progressBar.style.width = '0%';
                    fileSelectionList.innerHTML = '';
                    uploadSubmitBtn.disabled = false;
                    uploadSubmitBtn.textContent = "上传";
                    loadFolderContents(currentEncryptedFolderId);
                }, 1000);
            } else { throw new Error(res.data.message); }
        } catch (err) {
            uploadNotificationArea.innerHTML = `<div class="error-message">上传失败: ${err.message || '未知错误'}</div>`;
            uploadForm.style.display = 'block';
            progressArea.style.display = 'none';
            uploadSubmitBtn.disabled = false;
            uploadSubmitBtn.textContent = "上传";
        }
    }

    // --- 通用冲突处理队列逻辑 ---
    function processConflictQueue(onComplete) {
        if (conflictQueue.length === 0) {
            onComplete();
            return;
        }

        const conflict = conflictQueue[0];
        
        // 设置回调：当用户选择操作后，处理下一个或完成
        currentConflictCallback = (action, applyToAll) => {
            if (action === 'abort') {
                abortConflictResolution();
                return;
            }

            // 记录决议
            currentConflictResolutions[conflict.relativePath] = action;
            
            // 处理 "应用到所有"
            if (applyToAll) {
                for (let i = 1; i < conflictQueue.length; i++) {
                    const next = conflictQueue[i];
                    // 只对同类型的冲突应用
                    if (next.type === conflict.type) {
                        currentConflictResolutions[next.relativePath] = action;
                    }
                }
                // 过滤掉已处理的同类型冲突
                conflictQueue = conflictQueue.filter(c => c.type !== conflict.type);
                // 当前这个也处理完了，虽然已经在队列头
            } else {
                conflictQueue.shift(); // 移除当前已解决的
            }
            
            // 关闭当前模态框
            conflictModal.style.display = 'none';
            folderConflictModal.style.display = 'none';
            applyToAllCheckbox.checked = false;
            applyToAllFoldersCheckbox.checked = false;

            // 递归处理下一个
            processConflictQueue(onComplete);
        };

        // 显示对应的模态框
        if (conflict.type === 'file') {
            conflictFileName.textContent = conflict.name;
            conflictModal.style.display = 'block';
        } else {
            folderConflictName.textContent = conflict.name;
            folderConflictModal.style.display = 'block';
        }
    }

    function resolveConflict(action) {
        if (!currentConflictCallback) return;
        // 检查是哪个模态框的 "应用到所有" 被选中了
        let applyToAll = false;
        if (conflictModal.style.display === 'block') applyToAll = applyToAllCheckbox.checked;
        if (folderConflictModal.style.display === 'block') applyToAll = applyToAllFoldersCheckbox.checked;
        
        currentConflictCallback(action, applyToAll);
    }
    
    function abortConflictResolution() {
        conflictQueue = [];
        currentConflictResolutions = {};
        conflictModal.style.display = 'none';
        folderConflictModal.style.display = 'none';
        confirmMoveBtn.disabled = false;
        confirmMoveBtn.textContent = isCopyOperation ? "确定复制" : "确定移动";
        uploadSubmitBtn.disabled = false;
        uploadSubmitBtn.textContent = "上传";
    }

    // --- 密码/锁/其他 ---
    function promptForPassword(itemId, action) { 
        passwordModal.style.display = 'block';
        passwordForm.reset();
        oldPasswordContainer.style.display = 'none';
        confirmPasswordContainer.style.display = 'none';
        
        if (action === 'unlock') {
            passwordModalTitle.textContent = '输入密码解锁';
            passwordPromptText.textContent = '此文件夹受密码保护。';
            passwordCallback = async () => {
                const pwd = passwordInput.value;
                try {
                    await axios.post(`/api/folder/${itemId}/verify`, { password: pwd });
                    passwordModal.style.display = 'none';
                    loadFolderContents(itemId); 
                } catch(e) { alert('密码错误'); }
            };
        } else if (action === 'set_lock') {
            passwordModalTitle.textContent = '设置密码';
            passwordPromptText.textContent = '为文件夹设置新密码。';
            confirmPasswordContainer.style.display = 'block';
            passwordCallback = async () => {
                const pwd = passwordInput.value;
                const confirm = confirmPasswordInput.value;
                if (pwd !== confirm) { alert('两次输入密码不一致'); return; }
                try {
                    await axios.post(`/api/folder/${itemId}/lock`, { password: pwd }); 
                    passwordModal.style.display = 'none';
                    alert('密码已设置');
                    loadFolderContents(currentEncryptedFolderId);
                } catch(e) { alert(e.response?.data?.message || '设置失败'); }
            };
        } else if (action === 'lock_settings') {
             passwordModalTitle.textContent = '管理密码';
             passwordPromptText.textContent = '修改或移除密码。';
             oldPasswordContainer.style.display = 'block';
             confirmPasswordContainer.style.display = 'block';
             passwordCallback = async () => {
                 const old = oldPasswordInput.value;
                 const pwd = passwordInput.value;
                 const confirm = confirmPasswordInput.value;
                 
                 // 如果新密码为空，视为解锁（移除密码）
                 if (!pwd) {
                     if (!confirm("新密码留空将移除文件夹锁，确定吗？")) return;
                     try {
                         await axios.post(`/api/folder/${itemId}/unlock`, { password: old });
                         passwordModal.style.display = 'none';
                         alert('密码已移除');
                         loadFolderContents(currentEncryptedFolderId);
                     } catch(e) { alert(e.response?.data?.message || '移除失败'); }
                     return;
                 }
                 
                 if (pwd !== confirm) { alert('两次输入密码不一致'); return; }
                 try {
                     await axios.post(`/api/folder/${itemId}/lock`, { password: pwd, oldPassword: old });
                     passwordModal.style.display = 'none';
                     alert('密码已修改');
                 } catch(e) { alert(e.response?.data?.message || '修改失败'); }
             };
        }
    }
    
    // --- Share Logic ---
    function openShareModal(item) {
        shareModal.style.display = 'block';
        shareOptions.style.display = 'block';
        shareResult.style.display = 'none';
        shareModal.dataset.itemId = item.id || item.message_id;
        shareModal.dataset.itemType = item.type;
    }
    
    async function generateShareLink() {
        const itemId = shareModal.dataset.itemId;
        const itemType = shareModal.dataset.itemType;
        const expiresIn = expiresInSelect.value;
        const password = sharePasswordInput.value;
        let customExpiresAt = null;
        if (expiresIn === 'custom') {
            const dateVal = new Date(customExpiresInput.value).getTime();
            if (isNaN(dateVal)) { alert('无效时间'); return; }
            customExpiresAt = dateVal;
        }
        try {
            const res = await axios.post('/share', { itemId, itemType, expiresIn, password, customExpiresAt });
            shareOptions.style.display = 'none';
            shareResult.style.display = 'block';
            shareLinkContainer.textContent = res.data.url;
        } catch(e) { alert('生成失败'); }
    }

    async function changeUserPassword() {
        const oldP = prompt('旧密码:');
        if(!oldP) return;
        const newP = prompt('新密码:');
        if(!newP) return;
        try {
            await axios.post('/api/user/change-password', { oldPassword: oldP, newPassword: newP });
            alert('修改成功');
        } catch(e) { alert('修改失败'); }
    }

    // --- 辅助函数 ---
    function escapeHtml(text) {
        if (!text) return text;
        return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
    }

    function formatBytes(bytes, decimals = 2) {
        if (!+bytes) return '0 Bytes';
        const k = 1024;
        const dm = decimals < 0 ? 0 : decimals;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
    }

    function getFileIconClass(filename) {
        if (!filename) return 'fa-file';
        const ext = filename.split('.').pop().toLowerCase();
        const icons = {
            'pdf': 'fa-file-pdf', 'doc': 'fa-file-word', 'docx': 'fa-file-word',
            'xls': 'fa-file-excel', 'xlsx': 'fa-file-excel', 'ppt': 'fa-file-powerpoint', 'pptx': 'fa-file-powerpoint',
            'jpg': 'fa-file-image', 'jpeg': 'fa-file-image', 'png': 'fa-file-image', 'gif': 'fa-file-image',
            'mp4': 'fa-file-video', 'mkv': 'fa-file-video', 'avi': 'fa-file-video',
            'mp3': 'fa-file-audio', 'wav': 'fa-file-audio', 'zip': 'fa-file-archive', 'rar': 'fa-file-archive', '7z': 'fa-file-archive',
            'txt': 'fa-file-alt', 'js': 'fa-file-code', 'html': 'fa-file-code', 'css': 'fa-file-code'
        };
        return icons[ext] || 'fa-file';
    }

    function isImage(filename) {
        if (!filename) return false;
        const ext = filename.split('.').pop().toLowerCase();
        return ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
    }
    
    function showNotification(message, type = 'info') {
        const div = document.createElement('div');
        div.className = `notification ${type}`;
        div.textContent = message;
        div.style.position = 'fixed';
        div.style.bottom = '20px';
        div.style.right = '20px';
        div.style.backgroundColor = type === 'success' ? '#28a745' : '#17a2b8';
        div.style.color = '#fff';
        div.style.padding = '10px 20px';
        div.style.borderRadius = '5px';
        div.style.zIndex = '9999';
        document.body.appendChild(div);
        setTimeout(() => div.remove(), 3000);
    }

    init();
});
