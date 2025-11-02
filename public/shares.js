document.addEventListener('DOMContentLoaded', () => {
    const tableBody = document.getElementById('sharesTableBody');
    const table = document.getElementById('sharesTable');
    const loadingMessage = document.getElementById('loading-message');

    const loadSharedFiles = async () => {
        try {
            const response = await axios.get('/api/shares');
            const shares = response.data;

            loadingMessage.style.display = 'none';
            table.style.display = 'table';
            tableBody.innerHTML = '';

            if (shares.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="4" style="text-align:center;">目前没有任何分享中的项目。</td></tr>';
                return;
            }

            shares.forEach(item => {
                const expires = item.share_expires_at 
                    ? new Date(item.share_expires_at).toLocaleString() 
                    : '永久';
                
                const row = document.createElement('tr');
                row.dataset.itemId = item.id;
                row.dataset.itemType = item.type;
                
                const icon = item.type === 'folder' ? 'fa-folder' : 'fa-file';
                
                // --- 修改开始: 在 "操作" 栏中添加 "定位" 按钮 ---
                row.innerHTML = `
                    <td class="file-name" title="${item.name}"><i class="fas ${icon}" style="margin-right: 8px;"></i>${item.name}</td>
                    <td>
                        <div class="share-link">
                            <input type="text" value="${item.share_url}" readonly>
                            <button class="copy-btn" title="复制连结"><i class="fas fa-copy"></i></button>
                        </div>
                    </td>
                    <td>${expires}</td>
                    <td class="actions">
                        <button class="locate-btn" title="定位文件"><i class="fas fa-search-location"></i></button>
                        <button class="cancel-btn" title="取消分享"><i class="fas fa-times"></i></button>
                    </td>
                `;
                // --- 修改结束 ---
                tableBody.appendChild(row);
            });
        } catch (error) {
            // --- 增加会话超时处理 ---
            if (error.response && error.response.status === 401) {
                window.location.href = '/login';
                return;
            }
            loadingMessage.textContent = '加载失败，请稍后重试。';
        }
    };

    tableBody.addEventListener('click', async (e) => {
        const copyBtn = e.target.closest('.copy-btn');
        const cancelBtn = e.target.closest('.cancel-btn');
        const locateBtn = e.target.closest('.locate-btn'); // --- 新增 ---

        if (copyBtn) {
            const input = copyBtn.previousElementSibling;
            navigator.clipboard.writeText(input.value).then(() => {
                const originalIcon = copyBtn.innerHTML;
                copyBtn.innerHTML = '<i class="fas fa-check"></i>';
                setTimeout(() => { copyBtn.innerHTML = originalIcon; }, 2000);
            });
        }

        if (cancelBtn) {
            if (!confirm('确定要取消这个项目的分享吗？')) return;
            
            const row = cancelBtn.closest('tr');
            const itemId = row.dataset.itemId;
            const itemType = row.dataset.itemType;
            
            try {
                await axios.post('/api/cancel-share', { itemId, itemType });
                row.remove();
            } catch (error) {
                alert('取消分享失败，请重试。');
            }
        }
        
        // --- 新增： “定位”按钮的事件处理 ---
        if (locateBtn) {
            const row = locateBtn.closest('tr');
            const itemId = row.dataset.itemId;
            const itemType = row.dataset.itemType;

            try {
                const res = await axios.get(`/api/locate-item?id=${itemId}&type=${itemType}`);
                if (res.data.success && res.data.encryptedFolderId) {
                    window.location.href = `/view/${res.data.encryptedFolderId}`;
                } else {
                    alert('找不到文件位置：' + (res.data.message || '无法定位此文件。'));
                }
            } catch (error) {
                if (error.response && error.response.status === 404) {
                    alert('找不到文件位置：该文件或其所在的文件夹可能已被移动或删除。');
                } else {
                    alert('定位时发生错误，请重试。');
                }
            }
        }
        // --- 事件处理结束 ---
    });

    loadSharedFiles();
});
