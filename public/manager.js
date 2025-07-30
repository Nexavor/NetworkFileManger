// nexavor/networkfilemanger/NetworkFileManger-ece0c16c1ce8238333a40fd0f76eda3f8fdfe55f/public/manager.js
document.addEventListener('DOMContentLoaded', function () {
    const fileList = document.getElementById('file-list');
    const breadcrumb = document.getElementById('breadcrumb');
    const newFolderBtn = document.getElementById('new-folder-btn');
    const newFileBtn = document.getElementById('new-file-btn');
    const uploadLinkBtn = document.getElementById('upload-link-btn');
    const searchInput = document.getElementById('search-input');
    const searchClear = document.getElementById('search-clear');
    const contextMenu = document.getElementById('context-menu');
    const multiSelectToolbar = document.getElementById('multi-select-toolbar');
    const selectionCount = document.getElementById('selection-count');
    
    let currentFolderId = null;
    let selectedItems = new Set();
    let fileDataCache = {}; 
    let ctrlPressed = false;

    // --- Modal Handling ---
    const modal = document.getElementById('modal');
    const modalTitle = document.getElementById('modal-title');
    const modalBody = document.getElementById('modal-body');
    const modalActionBtn = document.getElementById('modal-action-btn');
    const modalCancelBtn = document.getElementById('modal-cancel-btn');
    const modalCloseBtn = document.querySelector('.modal .close');

    function showModal(title, bodyContent, actionText, actionCallback, cancelText = '取消') {
        modalTitle.textContent = title;
        modalBody.innerHTML = ''; 
        if (typeof bodyContent === 'string') {
            modalBody.innerHTML = bodyContent;
        } else {
            modalBody.appendChild(bodyContent);
        }
        
        modalActionBtn.style.display = actionCallback ? 'inline-block' : 'none';
        modalActionBtn.textContent = actionText;
        modalActionBtn.onclick = () => {
             if(actionCallback) actionCallback();
             closeModal();
        };

        modalCancelBtn.textContent = cancelText;
        modal.style.display = 'block';
    }
    
    function closeModal() {
        modal.style.display = 'none';
    }

    modalCloseBtn.onclick = closeModal;
    modalCancelBtn.onclick = closeModal;
    window.onclick = function(event) {
        if (event.target == modal) {
            closeModal();
        }
    }

    async function loadFolder(folderId) {
        try {
            const response = await axios.get(`/api/folder/${folderId}`);
            const { contents, path } = response.data;
            fileDataCache = {};
            contents.forEach(item => fileDataCache[item.type === 'file' ? item.message_id : `folder-${item.id}`] = item);

            renderBreadcrumb(path);
            renderFileList(contents);
            currentFolderId = folderId;
            history.pushState({ folderId: folderId }, '', `/folder/${folderId}`);
        } catch (error) {
            console.error('无法加载资料夹:', error);
            alert('加载资料夹失败，请检查您的网路连线或权限。');
        }
    }
    
    async function loadSearchResults(query) {
        if (!query) return loadFolder(currentFolderId || 'root');
        try {
            const response = await axios.get(`/api/search?q=${query}`);
            const { contents, path } = response.data;
            renderBreadcrumb(path);
            renderFileList(contents);
        } catch (error) {
            console.error('搜寻失败:', error);
        }
    }

    function renderBreadcrumb(path) {
        breadcrumb.innerHTML = '';
        path.forEach((folder, index) => {
            const li = document.createElement('li');
            if (index < path.length - 1) {
                const a = document.createElement('a');
                a.href = '#';
                a.textContent = folder.name;
                a.dataset.folderId = folder.id;
                a.addEventListener('click', (e) => {
                    e.preventDefault();
                    loadFolder(folder.id);
                });
                li.appendChild(a);
            } else {
                li.textContent = folder.name;
            }
            breadcrumb.appendChild(li);
        });
    }

    function renderFileList(items) {
        fileList.innerHTML = '';
        if (items.length === 0) {
            fileList.innerHTML = '<p class="empty-folder-message">这个资料夹是空的</p>';
            return;
        }
        items.forEach(item => {
            const div = document.createElement('div');
            const itemId = item.type === 'file' ? item.message_id : `folder-${item.id}`;
            div.className = 'file-item';
            div.dataset.itemId = itemId;
            div.dataset.type = item.type;
            div.dataset.name = item.name;
            div.draggable = true;
            
            const isSelected = selectedItems.has(String(itemId));
            if(isSelected) div.classList.add('selected');

            const iconClass = item.type === 'folder' ? 'fa-folder' : getIconForMime(item.mimetype);
            let thumbnailHtml = `<i class="fas ${iconClass}"></i>`;
            if (item.type === 'file' && item.thumb_file_id) {
                 thumbnailHtml = `<img src="/thumbnail/${item.message_id}" alt="thumb" class="thumbnail-img" loading="lazy">`;
            }
            
            div.innerHTML = `
                <div class="item-icon">${thumbnailHtml}</div>
                <div class="item-name" title="${item.name}">${item.name}</div>
            `;

            div.addEventListener('click', (e) => handleItemClick(e, div, itemId));
            div.addEventListener('dblclick', () => handleItemDblClick(item));
            div.addEventListener('contextmenu', (e) => handleItemContextMenu(e, div, itemId));
            div.addEventListener('dragstart', (e) => handleDragStart(e, div, itemId));
            div.addEventListener('dragover', (e) => handleDragOver(e, div, item.type));
            div.addEventListener('dragleave', (e) => handleDragLeave(e, div));
            div.addEventListener('drop', (e) => handleDrop(e, div, itemId, item.type));

            fileList.appendChild(div);
        });
    }
    
    function getIconForMime(mime) {
        if (!mime) return 'fa-file';
        if (mime.startsWith('image/')) return 'fa-file-image';
        if (mime.startsWith('video/')) return 'fa-file-video';
        if (mime.startsWith('audio/')) return 'fa-file-audio';
        if (mime === 'application/pdf') return 'fa-file-pdf';
        if (mime.includes('zip') || mime.includes('rar') || mime.includes('7z')) return 'fa-file-archive';
        if (mime.startsWith('text/')) return 'fa-file-alt';
        return 'fa-file';
    }
    
    function handleItemClick(e, element, itemId) {
        e.stopPropagation();
        hideContextMenu();
        
        const wasSelected = selectedItems.has(String(itemId));

        if (!ctrlPressed) {
            clearSelection();
        }
        
        if (wasSelected && ctrlPressed) {
            selectedItems.delete(String(itemId));
            element.classList.remove('selected');
        } else {
            selectedItems.add(String(itemId));
            element.classList.add('selected');
        }
        updateMultiSelectToolbar();
    }
    
    function handleItemDblClick(item) {
        if (item.type === 'folder') {
            loadFolder(item.id);
        } else {
            previewFile(item);
        }
    }
    
    function handleItemContextMenu(e, element, itemId) {
        e.preventDefault();
        e.stopPropagation();
        if (!selectedItems.has(String(itemId))) {
            clearSelection();
            selectedItems.add(String(itemId));
            element.classList.add('selected');
        }
        updateMultiSelectToolbar();
        showContextMenu(e.clientX, e.clientY);
    }

    fileList.addEventListener('click', () => {
        clearSelection();
        hideContextMenu();
    });
    document.addEventListener('click', hideContextMenu);
    
    window.addEventListener('keydown', e => { ctrlPressed = e.ctrlKey; });
    window.addEventListener('keyup', e => { ctrlPressed = e.ctrlKey; });

    newFolderBtn.addEventListener('click', createNewFolder);
    newFileBtn.addEventListener('click', () => createOrEditTextFile('create'));
    uploadLinkBtn.addEventListener('click', () => document.getElementById('upload-input').click());
    
    document.getElementById('upload-input').addEventListener('change', function() {
        if (this.files.length > 0) {
            showUploadModal(this.files);
        }
    });

    function clearSelection() {
        document.querySelectorAll('.file-item.selected').forEach(el => el.classList.remove('selected'));
        selectedItems.clear();
        updateMultiSelectToolbar();
    }

    function updateMultiSelectToolbar() {
        if (selectedItems.size > 0) {
            selectionCount.textContent = `${selectedItems.size} 个项目已选择`;
            multiSelectToolbar.classList.add('visible');
        } else {
            multiSelectToolbar.classList.remove('visible');
        }
    }
    
    document.getElementById('deselect-btn').addEventListener('click', clearSelection);

    let searchTimeout;
    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
            const query = searchInput.value.trim();
            searchClear.style.display = query ? 'block' : 'none';
            loadSearchResults(query);
        }, 300);
    });
    
    searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchClear.style.display = 'none';
        loadFolder(currentFolderId);
    });

    function handleDragStart(e, element, itemId) {
        if (!selectedItems.has(String(itemId))) {
            clearSelection();
            selectedItems.add(String(itemId));
            element.classList.add('selected');
            updateMultiSelectToolbar();
        }
        e.dataTransfer.setData('text/plain', JSON.stringify(Array.from(selectedItems)));
        e.dataTransfer.effectAllowed = 'move';
    }
    
    function handleDragOver(e, element, itemType) {
        if (itemType === 'folder') {
            e.preventDefault();
            element.classList.add('drag-over');
        }
    }

    function handleDragLeave(e, element) {
        element.classList.remove('drag-over');
    }

    async function handleDrop(e, element, targetItemId, targetItemType) {
        e.preventDefault();
        e.stopPropagation();
        element.classList.remove('drag-over');
        if (targetItemType !== 'folder') return;
        
        const sourceItemIds = JSON.parse(e.dataTransfer.getData('text/plain'));
        const targetFolderId = parseInt(targetItemId.replace('folder-', ''), 10);

        if (sourceItemIds.includes(`folder-${targetFolderId}`)) return;

        await processMove(sourceItemIds, targetFolderId);
    }

    fileList.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
    });
    
    fileList.addEventListener('drop', async e => {
        e.preventDefault();
        e.stopPropagation();
        
        if (e.target === fileList) {
            if(searchInput.value.trim()) return;
            
            // *** 整合：处理从外部拖入的档案 ***
            const files = e.dataTransfer.files;
            if (files && files.length > 0) {
                showUploadModal(files);
            } else {
                const sourceItemIds = JSON.parse(e.dataTransfer.getData('text/plain'));
                if(currentFolderId && !sourceItemIds.includes(`folder-${currentFolderId}`)) {
                    await processMove(sourceItemIds, currentFolderId);
                }
            }
        }
    });
    
    async function processMove(itemIds, targetFolderId) {
        try {
            const conflictRes = await axios.post('/api/check-move-conflict', { itemIds, targetFolderId });
            const { fileConflicts, folderConflicts, isCrossWebdavMove } = conflictRes.data;

            if (isCrossWebdavMove) {
                showModal(
                    '操作不允许',
                    '系统不支持在不同的 WebDAV 伺服器之间直接移动档案。请在同一个 WebDAV 伺服器内进行操作。',
                    null,
                    null,
                    '知道了'
                );
                clearSelection();
                return;
            }

            if (fileConflicts.length > 0 || folderConflicts.length > 0) {
                showMergeOverwriteModal(itemIds, targetFolderId, fileConflicts, folderConflicts);
            } else {
                // *** 修正：呼叫时不带额外参数 ***
                await performMove(itemIds, targetFolderId);
                await loadFolder(currentFolderId);
            }
        } catch (error) {
            console.error("检查移动冲突时出错:", error);
            alert('移动失败：' + (error.response?.data?.message || '伺服器错误'));
        }
    }

    async function performMove(itemIds, targetFolderId, mergeList = [], overwriteList = []) {
         try {
            await axios.post('/api/move', { 
                itemIds: itemIds, 
                targetFolderId,
                mergeList,
                overwriteList
            });
        } catch (error) {
            console.error('移动项目时出错:', error);
            alert('移动失败：' + (error.response?.data?.message || '伺服器错误'));
        }
    }
    
    function showContextMenu(x, y) {
        const isSingleSelection = selectedItems.size === 1;
        const [firstItemId] = selectedItems;
        const itemData = isSingleSelection ? fileDataCache[firstItemId] : null;

        document.getElementById('cm-rename').style.display = isSingleSelection ? 'block' : 'none';
        document.getElementById('cm-preview').style.display = (isSingleSelection && itemData.type === 'file') ? 'block' : 'none';
        document.getElementById('cm-edit').style.display = (isSingleSelection && itemData.type === 'file' && itemData.name.endsWith('.txt')) ? 'block' : 'none';
        
        contextMenu.style.left = `${x}px`;
        contextMenu.style.top = `${y}px`;
        contextMenu.style.display = 'block';
    }
    
    function hideContextMenu() {
        if (contextMenu.style.display === 'block') {
            contextMenu.style.display = 'none';
        }
    }
    
    document.getElementById('cm-share').addEventListener('click', showShareModal);
    document.getElementById('cm-download').addEventListener('click', downloadSelected);
    document.getElementById('cm-delete').addEventListener('click', deleteSelected);
    document.getElementById('cm-rename').addEventListener('click', renameSelectedItem);
    document.getElementById('cm-preview').addEventListener('click', () => previewFile(fileDataCache[selectedItems.values().next().value]));
    document.getElementById('cm-edit').addEventListener('click', () => createOrEditTextFile('edit', fileDataCache[selectedItems.values().next().value]));
    document.getElementById('cm-move').addEventListener('click', showMoveModal);

    async function createNewFolder() {
        const folderName = prompt('请输入新资料夹的名称:');
        if (folderName) {
            try {
                await axios.post('/api/folder', { name: folderName, parentId: currentFolderId });
                loadFolder(currentFolderId);
            } catch (error) {
                alert('建立资料夹失败：' + (error.response?.data?.message || '伺服器错误'));
            }
        }
    }

    async function createOrEditTextFile(mode, item = null) {
        let fileId = null, fileName = '', content = '';

        if (mode === 'edit' && item) {
            try {
                const response = await axios.get(`/file/content/${item.message_id}`);
                content = response.data;
                fileName = item.name;
                fileId = item.message_id;
            } catch (error) {
                alert('读取档案内容失败');
                return;
            }
        }

        const bodyDiv = document.createElement('div');
        const nameLabel = document.createElement('label');
        nameLabel.textContent = '档案名称:';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.style.cssText = 'width: 100%; margin-bottom: 10px;';
        nameInput.value = fileName;
        if (mode === 'edit') nameInput.disabled = true;

        const contentLabel = document.createElement('label');
        contentLabel.textContent = '档案内容:';
        const contentArea = document.createElement('textarea');
        contentArea.style.cssText = 'width: 100%; height: 300px;';
        contentArea.value = content;
        
        bodyDiv.appendChild(nameLabel);
        bodyDiv.appendChild(nameInput);
        bodyDiv.appendChild(contentLabel);
        bodyDiv.appendChild(contentArea);

        showModal(
            mode === 'edit' ? '编辑文字档' : '建立新文字档',
            bodyDiv,
            '储存',
            async () => {
                const newFileName = nameInput.value;
                const newContent = contentArea.value;
                if (!newFileName.endsWith('.txt')) {
                    alert('档名必须以 .txt 结尾。');
                    return;
                }
                try {
                    await axios.post('/api/text-file', {
                        mode,
                        fileId,
                        folderId: currentFolderId,
                        fileName: newFileName,
                        content: newContent
                    });
                    loadFolder(currentFolderId);
                } catch(error) {
                     alert('储存失败：' + (error.response?.data?.message || '伺服器错误'));
                }
            }
        );
    }


    async function renameSelectedItem() {
        if (selectedItems.size !== 1) return;
        const [itemId] = selectedItems;
        const item = fileDataCache[itemId];
        const newName = prompt(`请为 "${item.name}" 输入新名称:`, item.name);
        if (newName && newName !== item.name) {
            try {
                await axios.post('/rename', { id: item.type === 'file' ? item.message_id : item.id, newName, type: item.type });
                loadFolder(currentFolderId);
            } catch (error) {
                alert('重命名失败');
            }
        }
    }
    
    function showShareModal() {
        if (selectedItems.size === 0) return;
        const bodyDiv = document.createElement('div');
        const label = document.createElement('p');
        label.textContent = `为 ${selectedItems.size} 个项目建立分享连结，连结将在多少天后过期？`;
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.value = '7';
        bodyDiv.appendChild(label);
        bodyDiv.appendChild(input);

        showModal('建立分享连结', bodyDiv, '建立', async () => {
            const expiresIn = parseInt(input.value);
            if (isNaN(expiresIn) || expiresIn <= 0) {
                alert('请输入有效的天数');
                return;
            }
            try {
                const links = [];
                for(const itemId of selectedItems) {
                    const item = fileDataCache[itemId];
                     const response = await axios.post('/share', { 
                        itemId: item.type === 'file' ? item.message_id : item.id,
                        itemType: item.type,
                        expiresIn: expiresIn 
                    });
                    if (response.data.success) {
                        links.push(`<b>${item.name}:</b> ${response.data.url}`);
                    }
                }
                showModal('分享连结', links.join('<br>'), null, null, '关闭');
            } catch(error) {
                alert('建立分享连结失败');
            }
        });
    }

    async function downloadSelected() {
        if (selectedItems.size === 0) return;
        const messageIds = [];
        const folderIds = [];
        selectedItems.forEach(id => {
            const item = fileDataCache[id];
            if (item.type === 'file') messageIds.push(item.message_id);
            else folderIds.push(item.id);
        });

        if (selectedItems.size === 1 && messageIds.length === 1) {
            window.location.href = `/download/proxy/${messageIds[0]}`;
        } else {
            try {
                const response = await axios.post('/api/download-archive', { messageIds, folderIds }, { responseType: 'blob' });
                const url = window.URL.createObjectURL(new Blob([response.data]));
                const link = document.createElement('a');
                link.href = url;
                link.setAttribute('download', 'download.zip');
                document.body.appendChild(link);
                link.click();
                link.remove();
            } catch(error) {
                alert('打包下载失败');
            }
        }
    }

    async function deleteSelected() {
        if (selectedItems.size === 0) return;
        if (!confirm(`确定要删除选择的 ${selectedItems.size} 个项目吗？此操作无法复原！`)) return;
        try {
            const messageIds = [];
            const folderIds = [];
            selectedItems.forEach(id => {
                const item = fileDataCache[id];
                if (item.type === 'file') messageIds.push(item.message_id);
                else folderIds.push(item.id);
            });
            await axios.post('/delete-multiple', { messageIds, folderIds });
            loadFolder(currentFolderId);
        } catch (error) {
            alert('删除失败');
        }
    }

    function showUploadModal(files) {
        const bodyDiv = document.createElement('div');
        const fileListDiv = document.createElement('div');
        fileListDiv.style.maxHeight = '300px';
        fileListDiv.style.overflowY = 'auto';
        
        Array.from(files).forEach(file => {
            const fileDiv = document.createElement('p');
            fileDiv.textContent = file.webkitRelativePath || file.name;
            fileListDiv.appendChild(fileDiv);
        });
        
        bodyDiv.appendChild(fileListDiv);

        showModal(
            `上传 ${files.length} 个档案`,
            bodyDiv,
            '开始上传',
            async () => {
                const formData = new FormData();
                formData.append('folderId', currentFolderId);
                
                const relativePaths = [];
                for (let i = 0; i < files.length; i++) {
                    formData.append('files', files[i]);
                    relativePaths.push(files[i].webkitRelativePath || files[i].name);
                }
                
                const existenceRes = await axios.post('/api/check-existence', { files: relativePaths.map(p => ({ relativePath: p })), folderId: currentFolderId });
                const existingFiles = existenceRes.data.files.filter(f => f.exists);
                
                let overwritePaths = [];
                if (existingFiles.length > 0) {
                     if (!confirm(`发现 ${existingFiles.length} 个同名档案。要覆盖它们吗？`)) {
                        closeModal();
                        return;
                    }
                    overwritePaths = existingFiles.map(f => f.relativePath);
                }
                formData.append('overwritePaths', JSON.stringify(overwritePaths));
                formData.append('relativePaths', JSON.stringify(relativePaths));

                try {
                    const uploadModalBody = document.createElement('div');
                    const progressBar = document.createElement('progress');
                    progressBar.style.width = '100%';
                    progressBar.value = 0;
                    progressBar.max = 100;
                    const progressText = document.createElement('p');
                    progressText.textContent = '正在上传...';
                    uploadModalBody.appendChild(progressBar);
                    uploadModalBody.appendChild(progressText);
                    
                    showModal('上传中', uploadModalBody, null, null, '后台执行');
                    
                    await axios.post('/upload', formData, {
                        onUploadProgress: progressEvent => {
                            const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
                            progressBar.value = percentCompleted;
                            progressText.textContent = `正在上传... ${percentCompleted}%`;
                        }
                    });

                    showModal('上传完成', '所有档案已成功上传。', null, null, '关闭');
                    loadFolder(currentFolderId);

                } catch (error) {
                    showModal('上传失败', '上传过程中发生错误：' + (error.response?.data?.message || error.message), null, null, '关闭');
                }
            }
        );
    }
    
    function previewFile(item) {
        let content;
        if (item.mimetype.startsWith('image/')) {
            content = `<img src="/download/proxy/${item.message_id}" style="max-width: 100%; max-height: 80vh;">`;
        } else if (item.mimetype.startsWith('video/')) {
            content = `<video src="/download/proxy/${item.message_id}" controls style="max-width: 100%;"></video>`;
        } else if (item.mimetype.startsWith('audio/')) {
             content = `<audio src="/download/proxy/${item.message_id}" controls></audio>`;
        } else if (item.mimetype.startsWith('text/') || item.mimetype === 'application/json') {
             content = `<iframe src="/file/content/${item.message_id}" style="width:100%; height: 70vh; border: 1px solid #ccc;"></iframe>`;
        } else {
            content = `<p>不支援预览此档案类型。</p><a href="/download/proxy/${item.message_id}" class="upload-link-btn" download>点击下载</a>`;
        }
        showModal(item.name, content, null, null, '关闭');
    }
    
    async function showMoveModal() {
        if(selectedItems.size === 0) return;
        
        try {
            const res = await axios.get('/api/folders');
            const folders = res.data;
            const tree = buildTree(folders);

            const bodyDiv = document.createElement('div');
            bodyDiv.className = 'folder-tree';
            bodyDiv.innerHTML = renderTree(tree);
            
            showModal('移动到...', bodyDiv, '移动到此处', () => {
                const selectedRadio = document.querySelector('input[name="folder-dest"]:checked');
                if(selectedRadio) {
                    const targetFolderId = parseInt(selectedRadio.value);
                    if(!selectedItems.has(`folder-${targetFolderId}`)) {
                         processMove(Array.from(selectedItems), targetFolderId);
                    }
                }
            });

            bodyDiv.querySelectorAll('.toggle').forEach(toggle => {
                toggle.addEventListener('click', function() {
                    this.parentElement.parentElement.classList.toggle('collapsed');
                    this.classList.toggle('fa-plus-square');
                    this.classList.toggle('fa-minus-square');
                });
            });

        } catch(error) {
            alert('加载资料夹列表失败');
        }
    }
    
    function buildTree(folders, parentId = null) {
        return folders
            .filter(folder => folder.parent_id === parentId)
            .map(folder => ({ ...folder, children: buildTree(folders, folder.id) }));
    }
    
    function renderTree(nodes) {
        let html = '<ul>';
        for(const node of nodes) {
            const hasChildren = node.children.length > 0;
            html += `<li class="${hasChildren ? 'collapsed' : ''}">`;
            html += '<div class="tree-item">';
            if(hasChildren) {
                html += '<i class="fas fa-plus-square toggle"></i>';
            } else {
                 html += '<i class="fas fa-square" style="color: transparent;"></i>';
            }
            html += `<input type="radio" name="folder-dest" id="dest-${node.id}" value="${node.id}">`;
            html += `<label for="dest-${node.id}"><i class="fas fa-folder"></i> ${node.name}</label>`;
            html += '</div>';

            if(hasChildren) {
                html += renderTree(node.children);
            }
            html += '</li>';
        }
        html += '</ul>';
        return html;
    }
    
    function showMergeOverwriteModal(itemIds, targetFolderId, fileConflicts, folderConflicts) {
        const bodyDiv = document.createElement('div');
        bodyDiv.innerHTML = '<p>目标资料夹中存在同名项目。请选择如何处理：</p>';
        const form = document.createElement('form');
        form.id = 'conflict-form';

        if(folderConflicts.length > 0) {
            const folderHeader = document.createElement('h4');
            folderHeader.textContent = '资料夹冲突:';
            form.appendChild(folderHeader);
            folderConflicts.forEach(name => {
                form.innerHTML += `
                    <div>
                        <strong>${name}</strong>:
                        <label><input type="radio" name="folder-${name}" value="merge" checked> 合并</label>
                        <label><input type="radio" name="folder-${name}" value="overwrite"> 覆盖</label>
                    </div>
                `;
            });
        }
        
        if(fileConflicts.length > 0) {
            const fileHeader = document.createElement('h4');
            fileHeader.textContent = '档案冲突:';
            form.appendChild(fileHeader);
            fileConflicts.forEach(name => {
                form.innerHTML += `<p><strong>${name}</strong>: 将被覆盖。</p>`;
            });
        }
        bodyDiv.appendChild(form);

        showModal('解决移动冲突', bodyDiv, '确定', async () => {
            const mergeList = [];
            const overwriteFolders = [];
            
            folderConflicts.forEach(name => {
                const choice = document.querySelector(`input[name="folder-${name}"]:checked`).value;
                if(choice === 'merge') mergeList.push(name);
                else overwriteFolders.push(name);
            });
            
            const overwriteList = [...fileConflicts, ...overwriteFolders];
            
            await performMove(itemIds, targetFolderId, mergeList, overwriteList);
            await loadFolder(currentFolderId);
        });
    }

    const initialFolderId = window.location.pathname.split('/folder/')[1] || 'root';
    loadFolder(initialFolderId);
    
    window.onpopstate = function(event) {
        if (event.state && event.state.folderId) {
            loadFolder(event.state.folderId);
        }
    };
});
