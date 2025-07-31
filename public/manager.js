// public/js/manager.js

// --- 全域变数和初始设定 ---
let currentFolderId = null;
let selectedItems = new Set();
let selectedItemDetails = new Map(); // 新增：储存项目的详细资讯
let currentPath = [];
const FOLDER_ID_REGEX = /folder\/(\d+)/;
const doubleClickThreshold = 300; // 300 毫秒
let lastClickTime = 0;
let clickTimeout = null;

// --- DOMContentLoaded 事件监听 ---
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    initializeFolderView();
    initializeContextMenu();
    initializeModals();
});


// --- 初始化函式 ---

function initializeFolderView() {
    const match = window.location.pathname.match(FOLDER_ID_REGEX);
    currentFolderId = match ? parseInt(match[1], 10) : 1; 
    loadFolderContents(currentFolderId);
}

function initializeContextMenu() {
    const contextMenu = document.getElementById('custom-context-menu');
    document.addEventListener('click', () => hideContextMenu());
    document.getElementById('file-list').addEventListener('contextmenu', showContextMenu);
}

function initializeModals() {
    ['new-folder-modal', 'rename-modal', 'share-modal', 'move-modal', 'delete-confirm-modal'].forEach(modalId => {
        const modal = document.getElementById(modalId);
        if (modal) {
            const closeButton = modal.querySelector('.close-button');
            if (closeButton) {
                closeButton.onclick = () => modal.style.display = 'none';
            }
        }
    });
    window.onclick = (event) => {
        if (event.target.classList.contains('modal')) {
            event.target.style.display = 'none';
        }
    };
}


// --- 事件监听设定 ---

function setupEventListeners() {
    // 导航和操作按钮
    document.getElementById('back-button').addEventListener('click', goBack);
    document.getElementById('new-folder-button').addEventListener('click', () => showModal('new-folder-modal'));
    document.getElementById('upload-button').addEventListener('click', () => document.getElementById('file-upload-input').click());
    document.getElementById('create-text-file-button').addEventListener('click', () => openEditor('create'));
    document.getElementById('download-archive-button').addEventListener('click', downloadSelectedArchive);
    document.getElementById('refresh-button').addEventListener('click', () => loadFolderContents(currentFolderId));

    // 拖放上传
    setupDragAndDrop();

    // 表单提交
    document.getElementById('new-folder-form').addEventListener('submit', createNewFolder);
    document.getElementById('rename-form').addEventListener('submit', renameSelectedItem);
    document.getElementById('share-form').addEventListener('submit', createShareLink);
    document.getElementById('delete-confirm-button').addEventListener('click', deleteSelectedItems);
    document.getElementById('file-upload-input').addEventListener('change', (event) => {
        if (event.target.files.length > 0) {
            uploadFiles(event.target.files);
        }
    });
    
    // 搜寻
    const searchInput = document.getElementById('search-input');
    searchInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            searchFiles(searchInput.value);
        }
    });

    // 全选
    document.getElementById('select-all-header').addEventListener('click', toggleSelectAll);
}

function setupDragAndDrop() {
    const dropZone = document.body;
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });
    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });
    dropZone.addEventListener('drop', handleDrop, false);
}


// --- 核心功能函式 (API 呼叫与处理) ---

function loadFolderContents(folderId, isSearch = false, query = '') {
    const url = isSearch 
        ? `/api/search?q=${encodeURIComponent(query)}`
        : `/api/folder/${folderId}`;

    showLoading(true);
    fetch(url)
        .then(res => res.json())
        .then(data => {
            if (data.success === false) {
                alert(data.message);
                if (!isSearch) window.location.href = '/';
                return;
            }
            if (!isSearch) {
                currentFolderId = folderId;
                window.history.pushState({ folderId }, '', `/folder/${folderId}`);
            }
            updateBreadcrumbs(data.path);
            renderItems(data.contents);
            clearSelection();
            
            // 更新返回按钮的状态
            const backButton = document.getElementById('back-button');
            backButton.disabled = currentPath.length <= 1 && !isSearch;

        })
        .catch(error => {
            console.error('载入资料夹内容时发生错误:', error);
            alert('载入失败，请检查网路连线。');
        })
        .finally(() => showLoading(false));
}

function searchFiles(query) {
    if (!query.trim()) {
        loadFolderContents(currentFolderId);
        return;
    }
    loadFolderContents(null, true, query);
}

async function uploadFiles(files, directoryHandle = null) {
    const fileList = Array.from(files);
    const initialFolderId = currentFolderId;

    const filesWithRelativePaths = fileList.map(file => ({
        file,
        relativePath: file.webkitRelativePath || file.name
    }));

    // 1. 检查服务器上是否存在这些文件
    const filesToCheck = filesWithRelativePaths.map(f => ({ relativePath: f.relativePath }));
    const existenceResponse = await fetch('/api/check-existence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: filesToCheck, folderId: initialFolderId })
    });
    const existenceResult = await existenceResponse.json();
    if (!existenceResult.success) {
        alert('检查档案是否存在时发生错误：' + existenceResult.message);
        return;
    }

    const existingFiles = existenceResult.files.filter(f => f.exists);
    const overwritePaths = [];

    if (existingFiles.length > 0) {
        const fileNames = existingFiles.map(f => f.relativePath).join('\n');
        if (!confirm(`以下档案已存在，是否要覆盖？\n\n${fileNames}`)) {
            // 如果用户选择不覆盖，可以选择完全取消或只上传新文件
            const uploadOnlyNew = confirm('是否只上传新档案？（选择「取消」将不会上传任何档案）');
            if (!uploadOnlyNew) {
                console.log('用户取消了上传。');
                return;
            }
        } else {
            // 用户选择覆盖
            overwritePaths.push(...existingFiles.map(f => f.relativePath));
        }
    }


    // 2. 准备上传
    const formData = new FormData();
    formData.append('folderId', initialFolderId);

    const filesToUpload = filesWithRelativePaths.filter(f => 
        !existingFiles.some(ef => ef.relativePath === f.relativePath) || 
        overwritePaths.includes(f.relativePath)
    );
    
    if (filesToUpload.length === 0 && overwritePaths.length === 0) {
        alert("没有新档案需要上传。");
        return;
    }
    
    // 如果用户选择不覆盖，但又没有新档案，那么什么都不做
    if (filesToUpload.length === 0 && existingFiles.length > 0 && overwritePaths.length === 0) {
        alert("没有选择覆盖，且没有新档案，故不执行上传。");
        return;
    }


    filesToUpload.forEach(item => {
        formData.append('files', item.file);
        formData.append('relativePaths', item.relativePath);
    });

    formData.append('overwritePaths', JSON.stringify(overwritePaths));
    
    showLoading(true, "上传中...");

    // 3. 执行上传
    fetch('/upload', { method: 'POST', body: formData })
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => {
                    throw new Error(err.message || `HTTP 错误! 状态: ${response.status}`);
                });
            }
            return response.json();
        })
        .then(data => {
            if (data.success) {
                loadFolderContents(currentFolderId);
            } else {
                throw new Error(data.message || "上传失败，但未提供具体错误信息。");
            }
        })
        .catch(error => {
            console.error('上传失败:', error);
            alert('上传失败：' + error.message);
        })
        .finally(() => showLoading(false));
}


function createNewFolder(event) {
    event.preventDefault();
    const folderName = document.getElementById('new-folder-name').value;
    if (!folderName) {
        alert("资料夹名称不能为空。");
        return;
    }
    fetch('/api/folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: folderName, parentId: currentFolderId })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            hideModal('new-folder-modal');
            document.getElementById('new-folder-form').reset();
            loadFolderContents(currentFolderId);
        } else {
            alert('建立资料夹失败: ' + data.message);
        }
    })
    .catch(error => alert('请求失败: ' + error));
}

function renameSelectedItem(event) {
    event.preventDefault();
    const newName = document.getElementById('rename-input').value;
    const { id, type } = JSON.parse(document.getElementById('rename-id-type').value);

    if (!newName) {
        alert("新名称不能为空。");
        return;
    }

    fetch('/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, newName, type })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            hideModal('rename-modal');
            loadFolderContents(currentFolderId);
        } else {
            alert('重命名失败: ' + data.message);
        }
    })
    .catch(error => alert('请求失败: ' + error));
}


// **核心修正点**：这是重构后的移动函数
async function moveSelectedItems() {
    const targetFolderId = document.getElementById('folder-tree').dataset.selectedFolderId;
    if (!targetFolderId) {
        alert('请选择一个目标资料夹。');
        return;
    }

    // 从 selectedItemDetails Map 中获取完整的项目信息
    const itemsToMove = Array.from(selectedItems).map(itemId => selectedItemDetails.get(itemId));

    if (itemsToMove.some(item => !item)) {
        alert("发生内部错误：部分选中项目的详细资讯丢失。请刷新页面后重试。");
        console.error("丢失详细信息的项目ID:", Array.from(selectedItems).filter(id => !selectedItemDetails.has(id)));
        return;
    }

    // 检查是否有项目被移动到当前所在的文件夹
    if (itemsToMove.every(item => item.parent_id == targetFolderId)) {
        alert('所有选中的项目已在目标资料夹中。');
        hideModal('move-modal');
        return;
    }
    
    showLoading(true, "正在移动...");

    try {
        // 后端现在期望一个包含 {id, name, type} 的对象数组
        const response = await fetch('/api/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: itemsToMove, targetFolderId: parseInt(targetFolderId) })
        });

        const data = await response.json();
        if (response.ok && data.success) {
            hideModal('move-modal');
            loadFolderContents(currentFolderId);
        } else {
            throw new Error(data.message || "未知的移动错误。");
        }
    } catch (error) {
        console.error('移动失败:', error);
        alert('移动失败: ' + error.message);
    } finally {
        showLoading(false);
    }
}


function deleteSelectedItems() {
    hideModal('delete-confirm-modal');
    const { fileIds, folderIds } = getSelectedIdsByType();

    showLoading(true, "删除中...");

    fetch('/delete-multiple', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIds: fileIds, folderIds: folderIds })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            loadFolderContents(currentFolderId);
        } else {
            alert('删除失败: ' + data.message);
        }
    })
    .catch(error => alert('请求失败: ' + error))
    .finally(() => showLoading(false));
}


function createShareLink(event) {
    event.preventDefault();
    const { itemId, itemType } = JSON.parse(document.getElementById('share-id-type').value);
    const expiresIn = document.getElementById('share-expires-in').value;
    
    fetch('/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, itemType, expiresIn })
    })
    .then(res => res.json())
    .then(data => {
        if (data.success) {
            hideModal('share-modal');
            const shareUrlInput = document.getElementById('share-url');
            shareUrlInput.value = data.url;
            showModal('share-link-modal');
        } else {
            alert('建立分享连结失败: ' + data.message);
        }
    })
    .catch(error => alert('请求失败: ' + error));

    document.getElementById('copy-share-url').onclick = () => {
        const shareUrlInput = document.getElementById('share-url');
        shareUrlInput.select();
        document.execCommand('copy');
        alert('连结已复制！');
    };
}

async function downloadSelectedArchive() {
    if (selectedItems.size === 0) {
        alert('请至少选择一个档案或资料夹。');
        return;
    }
    const { fileIds, folderIds } = getSelectedIdsByType();
    showLoading(true, '准备下载中...');
    
    try {
        const response = await fetch('/api/download-archive', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageIds: fileIds, folderIds: folderIds })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(errorText || `伺服器错误: ${response.status}`);
        }

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `download-${currentFolderId}-${Date.now()}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
        clearSelection();
    } catch (error) {
        console.error('下载压缩档失败:', error);
        alert('下载失败: ' + error.message);
    } finally {
        showLoading(false);
    }
}


// --- 介面渲染与更新 (UI) ---

function renderItems({ folders = [], files = [] }) {
    const fileList = document.getElementById('file-list');
    fileList.innerHTML = ''; 

    folders.forEach(folder => fileList.appendChild(createItemElement(folder, 'folder')));
    files.forEach(file => fileList.appendChild(createItemElement(file, 'file')));
    updateSelectionInfo();
}


function createItemElement(item, type) {
    const isFolder = type === 'folder';
    const row = document.createElement('tr');
    row.dataset.id = item.id;
    row.dataset.type = type;
    row.dataset.name = item.name;
    // **核心修正点**: 存储移动操作所需要的所有信息
    row.dataset.details = JSON.stringify({
        id: item.id,
        name: item.name,
        type: type,
        parent_id: isFolder ? item.parent_id : item.folder_id
    });

    // 单击和双击处理
    row.addEventListener('click', (event) => {
        const currentTime = new Date().getTime();
        if (currentTime - lastClickTime < doubleClickThreshold) {
            clearTimeout(clickTimeout);
            handleDoubleClick(item, type);
        } else {
            clearTimeout(clickTimeout);
            clickTimeout = setTimeout(() => {
                handleSingleClick(event, row, item.id);
            }, doubleClickThreshold);
        }
        lastClickTime = currentTime;
    });

    // 勾选框
    const selectCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.addEventListener('click', e => e.stopPropagation()); // 防止事件冒泡
    checkbox.onchange = () => toggleSelection(item.id, row);
    selectCell.appendChild(checkbox);

    // 图标和名称
    const nameCell = document.createElement('td');
    nameCell.innerHTML = `
        <i class="fas ${isFolder ? 'fa-folder' : getFileIcon(item.fileName || item.name)}"></i>
        <span>${item.name}</span>
    `;

    // 档案大小
    const sizeCell = document.createElement('td');
    sizeCell.textContent = isFolder ? '--' : formatBytes(item.size);

    // 日期
    const dateCell = document.createElement('td');
    dateCell.textContent = item.date ? new Date(item.date * 1000).toLocaleString() : '--';
    
    row.append(selectCell, nameCell, sizeCell, dateCell);
    return row;
}


function updateBreadcrumbs(path) {
    currentPath = path;
    const breadcrumbs = document.getElementById('breadcrumbs');
    breadcrumbs.innerHTML = '';
    path.forEach((segment, index) => {
        const li = document.createElement('li');
        if (index < path.length - 1) {
            const a = document.createElement('a');
            a.href = '#';
            a.textContent = segment.name;
            a.onclick = (e) => {
                e.preventDefault();
                loadFolderContents(segment.id);
            };
            li.appendChild(a);
        } else {
            li.textContent = segment.name;
        }
        breadcrumbs.appendChild(li);
    });
}

function updateSelectionInfo() {
    const selectionInfo = document.getElementById('selection-info');
    const count = selectedItems.size;
    selectionInfo.textContent = count > 0 ? `已选择 ${count} 个项目` : '';
    
    // 更新全选框状态
    const selectAllCheckbox = document.querySelector('#select-all-header input');
    const totalItems = document.querySelectorAll('#file-list tr').length;
    if (selectAllCheckbox) {
       selectAllCheckbox.checked = totalItems > 0 && count === totalItems;
    }
}


function showLoading(show, text = '载入中...') {
    const loader = document.getElementById('loader');
    const loaderText = document.getElementById('loader-text');
    if (show) {
        loader.style.display = 'flex';
        loaderText.textContent = text;
    } else {
        loader.style.display = 'none';
    }
}


// --- 选择与上下文选单 ---

function handleSingleClick(event, row, itemId) {
    if (event.ctrlKey || event.metaKey) {
        toggleSelection(itemId, row);
    } else if (event.shiftKey) {
        selectRange(row);
    } else {
        clearSelection();
        toggleSelection(itemId, row);
    }
}

function handleDoubleClick(item, type) {
    if (type === 'folder') {
        loadFolderContents(item.id);
    } else {
        // 对于文件，可以实现预览功能
        previewFile(item);
    }
}

function toggleSelection(itemId, row) {
    const checkbox = row.querySelector('input[type="checkbox"]');
    if (selectedItems.has(itemId)) {
        selectedItems.delete(itemId);
        selectedItemDetails.delete(itemId); // 从 Map 中移除
        row.classList.remove('selected');
        checkbox.checked = false;
    } else {
        selectedItems.add(itemId);
        // **核心修正点**: 将项目的详细信息存入 Map
        selectedItemDetails.set(itemId, JSON.parse(row.dataset.details));
        row.classList.add('selected');
        checkbox.checked = true;
    }
    updateSelectionInfo();
}

function toggleSelectAll(event) {
    const isChecked = event.target.checked;
    const rows = document.querySelectorAll('#file-list tr');
    rows.forEach(row => {
        const id = row.dataset.id;
        // 确保状态一致
        if ((isChecked && !selectedItems.has(id)) || (!isChecked && selectedItems.has(id))) {
            toggleSelection(id, row);
        }
    });
}


function clearSelection() {
    selectedItems.clear();
    selectedItemDetails.clear(); // 清空 Map
    document.querySelectorAll('#file-list tr.selected').forEach(row => {
        row.classList.remove('selected');
        row.querySelector('input[type="checkbox"]').checked = false;
    });
    updateSelectionInfo();
}

let lastSelectedRow = null;
function selectRange(targetRow) {
    if (!lastSelectedRow) {
        lastSelectedRow = targetRow;
        toggleSelection(targetRow.dataset.id, targetRow);
        return;
    }

    const rows = Array.from(document.querySelectorAll('#file-list tr'));
    const lastIndex = rows.indexOf(lastSelectedRow);
    const currentIndex = rows.indexOf(targetRow);
    
    const [start, end] = [lastIndex, currentIndex].sort((a, b) => a - b);

    for (let i = start; i <= end; i++) {
        const rowToSelect = rows[i];
        if (!selectedItems.has(rowToSelect.dataset.id)) {
            toggleSelection(rowToSelect.dataset.id, rowToSelect);
        }
    }
    lastSelectedRow = targetRow;
}


function showContextMenu(e) {
    e.preventDefault();
    const targetRow = e.target.closest('tr');
    if (!targetRow) return;

    const itemId = targetRow.dataset.id;
    // 如果右键点击的项目未被选中，则先清空其他选择，并选中当前项目
    if (!selectedItems.has(itemId)) {
        clearSelection();
        toggleSelection(itemId, targetRow);
    }

    const menu = document.getElementById('custom-context-menu');
    updateContextMenuOptions(menu);
    
    menu.style.top = `${e.clientY}px`;
    menu.style.left = `${e.clientX}px`;
    menu.style.display = 'block';
}

function hideContextMenu() {
    document.getElementById('custom-context-menu').style.display = 'none';
}

function updateContextMenuOptions(menu) {
    const count = selectedItems.size;
    const isSingleSelection = count === 1;
    const { fileIds, folderIds } = getSelectedIdsByType();

    // 根据选择数量和类型显示/隐藏选项
    menu.querySelector('[data-action="open"]').style.display = isSingleSelection && folderIds.length === 1 ? 'block' : 'none';
    menu.querySelector('[data-action="preview"]').style.display = isSingleSelection && fileIds.length === 1 ? 'block' : 'none';
    menu.querySelector('[data-action="edit"]').style.display = isSingleSelection && fileIds.length === 1 && selectedItemDetails.get(fileIds[0]).name.endsWith('.txt') ? 'block' : 'none';
    menu.querySelector('[data-action="rename"]').style.display = isSingleSelection ? 'block' : 'none';
    menu.querySelector('[data-action="share"]').style.display = isSingleSelection ? 'block' : 'none';
    menu.querySelector('[data-action="move"]').style.display = count > 0 ? 'block' : 'none';
    menu.querySelector('[data-action="download"]').style.display = count > 0 ? 'block' : 'none';
    menu.querySelector('[data-action="delete"]').style.display = count > 0 ? 'block' : 'none';
    
    // 移除旧的事件监听器以防止重复绑定
    const newMenu = menu.cloneNode(true);
    menu.parentNode.replaceChild(newMenu, menu);
    newMenu.addEventListener('click', handleContextMenuClick);
    document.getElementById('file-list').addEventListener('contextmenu', showContextMenu); // 重新绑定主事件
}

function handleContextMenuClick(e) {
    e.stopPropagation();
    const action = e.target.closest('li').dataset.action;
    const { id, type, name } = getFirstSelectedItemDetails();
    
    switch (action) {
        case 'open':
            if (type === 'folder') loadFolderContents(id);
            break;
        case 'preview':
            previewFile({ id, name, type });
            break;
        case 'edit':
            openEditor('edit', id);
            break;
        case 'rename':
            showRenameModal(id, name, type);
            break;
        case 'share':
            showShareModal(id, type);
            break;
        case 'move':
            showMoveModal();
            break;
        case 'download':
            downloadSelectedArchive();
            break;
        case 'delete':
            showDeleteConfirmModal();
            break;
    }
    hideContextMenu();
}

// --- 弹窗 (Modal) 管理 ---

function showModal(modalId) {
    document.getElementById(modalId).style.display = 'block';
}

function hideModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
}

function showRenameModal(id, name, type) {
    document.getElementById('rename-input').value = name;
    document.getElementById('rename-id-type').value = JSON.stringify({ id, type });
    showModal('rename-modal');
}

function showShareModal(itemId, itemType) {
    document.getElementById('share-id-type').value = JSON.stringify({ itemId, itemType });
    showModal('share-modal');
}

function showDeleteConfirmModal() {
    const count = selectedItems.size;
    const message = `您确定要删除这 ${count} 个项目吗？此操作无法复原。`;
    document.getElementById('delete-confirm-message').textContent = message;
    showModal('delete-confirm-modal');
}

function showMoveModal() {
    showModal('move-modal');
    loadFolderTree();
}

async function loadFolderTree() {
    const treeContainer = document.getElementById('folder-tree');
    treeContainer.innerHTML = '载入中...';
    try {
        const response = await fetch('/api/folders');
        const folders = await response.json();
        const treeHtml = buildTree(folders, null); // 从根目录开始建构
        treeContainer.innerHTML = treeHtml;
        
        // 为资料夹树添加点击事件
        treeContainer.querySelectorAll('.folder-node').forEach(node => {
            node.addEventListener('click', (e) => {
                e.stopPropagation();
                treeContainer.querySelectorAll('.folder-node').forEach(n => n.classList.remove('selected'));
                node.classList.add('selected');
                treeContainer.dataset.selectedFolderId = node.dataset.folderId;
            });
        });
        
        // 为移动按钮添加事件
        const moveConfirmBtn = document.getElementById('move-confirm-button');
        // 先移除旧的监听器
        const newBtn = moveConfirmBtn.cloneNode(true);
        moveConfirmBtn.parentNode.replaceChild(newBtn, moveConfirmBtn);
        newBtn.addEventListener('click', moveSelectedItems);

    } catch (error) {
        treeContainer.innerHTML = '载入资料夹树失败。';
        console.error('载入资料夹树失败:', error);
    }
}

function buildTree(folders, parentId) {
    const children = folders.filter(f => f.parent_id === parentId);
    if (children.length === 0) return '';
    
    let html = '<ul>';
    children.forEach(folder => {
        // 根目录名称特殊处理
        const folderName = folder.parent_id === null ? '根目录' : folder.name;
        html += `<li><span class="folder-node" data-folder-id="${folder.id}">${folderName}</span>`;
        html += buildTree(folders, folder.id);
        html += '</li>';
    });
    html += '</ul>';
    return html;
}



// --- 辅助与工具函式 ---

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

function handleDrop(e) {
    const dt = e.dataTransfer;
    const items = dt.items;

    if (items && items.length > 0 && items[0].webkitGetAsEntry) {
        // 使用 Directory/File Entry API
        const entries = Array.from(items).map(item => item.webkitGetAsEntry());
        processEntries(entries);
    } else {
         // Fallback for browsers that don't support it
        const files = dt.files;
        if (files && files.length > 0) {
            uploadFiles(files);
        }
    }
}

async function processEntries(entries) {
    const allFiles = [];

    async function traverseEntry(entry) {
        if (entry.isFile) {
            return new Promise((resolve, reject) => {
                entry.file(file => {
                     // 为文件添加 webkitRelativePath 属性
                    Object.defineProperty(file, 'webkitRelativePath', {
                        value: entry.fullPath.substring(1), // 移除开头的 '/'
                        writable: true,
                        enumerable: true,
                        configurable: true
                    });
                    allFiles.push(file);
                    resolve();
                }, reject);
            });
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
            for (const subEntry of entries) {
                await traverseEntry(subEntry);
            }
        }
    }

    for (const entry of entries) {
        await traverseEntry(entry);
    }

    if (allFiles.length > 0) {
        uploadFiles(allFiles);
    }
}


function goBack() {
    if (currentPath.length > 1) {
        const parent = currentPath[currentPath.length - 2];
        loadFolderContents(parent.id);
    } else {
        console.log("已在根目录，无法后退。");
    }
}


function getSelectedIdsByType() {
    const fileIds = [];
    const folderIds = [];
    for (const itemId of selectedItems) {
        const item = selectedItemDetails.get(itemId);
        if (item) {
            if (item.type === 'file') {
                fileIds.push(item.id);
            } else if (item.type === 'folder') {
                folderIds.push(item.id);
            }
        }
    }
    return { fileIds, folderIds };
}

function getFirstSelectedItemDetails() {
    if (selectedItems.size === 0) return {};
    const firstId = selectedItems.values().next().value;
    return selectedItemDetails.get(firstId);
}


function previewFile(file) {
    const previewModal = document.getElementById('preview-modal');
    const previewContent = document.getElementById('preview-content');
    const previewTitle = document.getElementById('preview-title');
    const downloadLink = document.getElementById('preview-download-link');

    previewTitle.textContent = file.name;
    previewContent.innerHTML = '<div class="loader-small"></div>'; // Loading indicator
    showModal('preview-modal');

    // Set download link
    downloadLink.href = `/download/proxy/${file.id}`;
    downloadLink.download = file.name;

    const fileExtension = file.name.split('.').pop().toLowerCase();
    const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(fileExtension);
    const isVideo = ['mp4', 'webm', 'ogv'].includes(fileExtension);
    const isAudio = ['mp3', 'wav', 'ogg'].includes(fileExtension);
    const isText = ['txt', 'md', 'json', 'xml', 'html', 'css', 'js', 'log'].includes(fileExtension);

    const fileUrl = `/download/proxy/${file.id}`;

    if (isImage) {
        previewContent.innerHTML = `<img src="${fileUrl}" alt="${file.name}">`;
    } else if (isVideo) {
        previewContent.innerHTML = `<video controls src="${fileUrl}"></video>`;
    } else if (isAudio) {
        previewContent.innerHTML = `<audio controls src="${fileUrl}"></audio>`;
    } else if (isText) {
         fetch(`/file/content/${file.id}`)
            .then(res => {
                if (!res.ok) throw new Error('无法载入文字内容');
                return res.text();
            })
            .then(text => {
                previewContent.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
            })
            .catch(err => {
                previewContent.textContent = '预览文字档案失败。';
            });
    } else {
        previewContent.textContent = '此档案类型不支援预览。';
    }
}

function openEditor(mode, fileId = null) {
    let url = `/editor?mode=${mode}`;
    if (fileId) {
        url += `&fileId=${fileId}`;
    }
    window.open(url, '_blank');
}

// --- 格式化与辅助工具 ---
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0 || !bytes) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function getFileIcon(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const iconMap = {
        'pdf': 'fa-file-pdf', 'doc': 'fa-file-word', 'docx': 'fa-file-word',
        'xls': 'fa-file-excel', 'xlsx': 'fa-file-excel', 'ppt': 'fa-file-powerpoint',
        'pptx': 'fa-file-powerpoint', 'zip': 'fa-file-archive', 'rar': 'fa-file-archive',
        '7z': 'fa-file-archive', 'jpg': 'fa-file-image', 'jpeg': 'fa-file-image',
        'png': 'fa-file-image', 'gif': 'fa-file-image', 'mp3': 'fa-file-audio',
        'wav': 'fa-file-audio', 'mp4': 'fa-file-video', 'mov': 'fa-file-video',
        'avi': 'fa-file-video', 'txt': 'fa-file-alt', 'md': 'fa-file-alt',
    };
    return iconMap[ext] || 'fa-file';
}

function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}
