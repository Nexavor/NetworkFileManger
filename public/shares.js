document.addEventListener('DOMContentLoaded', () => {
    
    // --- *** 关键修正：新增 Axios 全局拦截器 *** ---
    axios.interceptors.response.use(
        (response) => {
            // 对成功的响应不执行任何操作，直接返回
            return response;
        },
        (error) => {
            // 检查是否是 401 未授权错误
            if (error.response && error.response.status === 401) {
                window.location.href = '/login';
                // 返回一个永远不会 resolved 的 Promise，以中断当前的 .then() 链
                return new Promise(() => {});
            }
            
            // 检查是否是网路错误（伺服器断线）
            if (!error.response && error.request) {
                window.location.href = '/login';
                // 返回一个永远不会 resolved 的 Promise
                return new Promise(() => {});
            }

            // 对于所有其他错误（如 404, 500 等），正常抛出
            return Promise.reject(error);
        }
    );
    // --- *** 修正结束 *** ---

    const tableBody = document.getElementById('sharesTableBody');
    const table = document.getElementById('sharesTable');
    const loadingMessage = document.getElementById('loading-message');

    const loadSharedFiles = async () => {
        try {
            loadingMessage.style.display = 'block'; // <-- 显示加载
            table.style.display = 'none';
            tableBody.innerHTML = '';

            const response = await axios.get('/api/shares');
            const shares = response.data;

            // --- *** 关键修正：隐藏加载讯息移到 finally 中 *** ---
            // loadingMessage.style.display = 'none'; // <-- 从这里移除

            table.style.display = 'table';

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
                tableBody.appendChild(row);
            });
        } catch (error) {
            // 拦截器会处理 401，这里只处理 500 等其他错误
            loadingMessage.textContent = '加载失败，请稍后重试。';
            loadingMessage.style.display = 'block'; // 确保错误讯息可见
            table.style.display = 'none';
        } finally {
            // --- *** 关键修正：新增 finally 区块 *** ---
            // 无论成功或失败 (非401/网路错误)，都隐藏 "正在加载..."
            // (如果载入失败, "加载失败" 的讯息会保留)
            if (loadingMessage.textContent === '正在加载分享列表...') {
                 loadingMessage.style.display = 'none';
            }
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
            const itemId = row.dataset.itemId; // <-- 这是 string (BigInt string 或 int string)
            const itemType = row.dataset.itemType;
            
            try {
                // (这个逻辑是正确的，因为 server.js 会正确处理 string ID)
                await axios.post('/api/cancel-share', { itemId, itemType });
                row.remove();
            } catch (error) {
                alert('取消分享失败，请重试。');
            }
        }
        
        if (locateBtn) {
            const row = locateBtn.closest('tr');
            const itemId = row.dataset.itemId;
            const itemType = row.dataset.itemType;

            try {
                // (这个逻辑是正确的，server.js 会正确处理 string ID)
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
    });

    loadSharedFiles();
});
