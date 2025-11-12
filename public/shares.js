document.addEventListener('DOMContentLoaded', () => {
    
    // --- *** 关键修正：新增 Axios 全局拦截器 *** ---
    axios.interceptors.response.use(
        (response) => response,
        (error) => {
            if (error.response && error.response.status === 401) {
                // alert('您的登入会话已过期，将自动跳转到登入页面。');
                window.location.href = '/login';
                return new Promise(() => {});
            }
            if (!error.response && error.request) {
                // alert('无法连接到伺服器，可能已经断线。将自动跳转到登入页面。');
                window.location.href = '/login';
                return new Promise(() => {});
            }
            return Promise.reject(error);
        }
    );
    // --- *** 修正结束 *** ---
    
    const sharesList = document.getElementById('sharesList');
    const loadingIndicator = document.getElementById('loadingIndicator');
    const noSharesMessage = document.getElementById('noSharesMessage');
    const homeLink = document.getElementById('homeLink');

    if (homeLink) {
        homeLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.history.pushState(null, '', '/');
            window.location.href = '/';
        });
    }

    const formatDateTime = (timestamp) => {
        if (!timestamp) return '永不过期';
        return new Date(timestamp).toLocaleString('zh-CN', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).replace(/\//g, '-');
    };
    
    const getFileIconClass = (fileName, itemType) => {
        if (itemType === 'folder') return 'fa-folder';
        if (!fileName) return 'fa-file';
        
        const lowerFileName = fileName.toLowerCase();
        const archiveExtensions = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'dmg'];
        const imageExtensions = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tiff'];
        const videoExtensions = ['mp4', 'mkv', 'avi', 'mov', 'wmv'];
        const audioExtensions = ['mp3', 'wav', 'ogg', 'flac'];
        const textExtensions = ['txt', 'md', 'json', 'js', 'css', 'html', 'xml', 'log'];

        for (const ext of archiveExtensions) if (lowerFileName.endsWith('.' + ext)) return 'fa-file-archive';
        for (const ext of imageExtensions) if (lowerFileName.endsWith('.' + ext)) return 'fa-file-image';
        for (const ext of videoExtensions) if (lowerFileName.endsWith('.' + ext)) return 'fa-file-video';
        for (const ext of audioExtensions) if (lowerFileName.endsWith('.' + ext)) return 'fa-file-audio';
        for (const ext of textExtensions) if (lowerFileName.endsWith('.' + ext)) return 'fa-file-alt';
        if (lowerFileName.endsWith('.pdf')) return 'fa-file-pdf';
        
        return 'fa-file';
    };

    async function loadShares() {
        loadingIndicator.style.display = 'block';
        noSharesMessage.style.display = 'none';
        sharesList.innerHTML = '';
        
        try {
            const res = await axios.get('/api/shares');
            const shares = res.data;
            
            if (shares.length === 0) {
                noSharesMessage.style.display = 'block';
            } else {
                shares.forEach(item => {
                    const li = document.createElement('li');
                    li.className = 'share-item';
                    
                    const iconClass = getFileIconClass(item.name, item.type);
                    
                    li.innerHTML = `
                        <div class="share-icon"><i class="fas ${iconClass}"></i></div>
                        <div class="share-info">
                            <span class="share-name" title="${item.name}">${item.name}</span>
                            <input class="share-url" type="text" value="${item.share_url}" readonly>
                            <span class="share-expires">到期时间: ${formatDateTime(item.share_expires_at)}</span>
                        </div>
                        <div class="share-actions">
                            <button class="action-btn copy-btn" title="复制链接"><i class="fas fa-copy"></i></button>
                            <button class="action-btn cancel-btn" data-id="${item.id}" data-type="${item.type}" title="取消分享"><i class="fas fa-times"></i></button>
                        </div>
                    `;
                    sharesList.appendChild(li);
                });
            }
        } catch (error) {
            noSharesMessage.textContent = '载入分享列表失败。';
            noSharesMessage.style.display = 'block';
        } finally {
            loadingIndicator.style.display = 'none';
        }
    }

    sharesList.addEventListener('click', async (e) => {
        const copyBtn = e.target.closest('.copy-btn');
        if (copyBtn) {
            const input = copyBtn.closest('.share-item').querySelector('.share-url');
            input.select();
            document.execCommand('copy');
            const icon = copyBtn.querySelector('i');
            icon.classList.remove('fa-copy');
            icon.classList.add('fa-check');
            setTimeout(() => {
                icon.classList.remove('fa-check');
                icon.classList.add('fa-copy');
            }, 1500);
            return;
        }

        const cancelBtn = e.target.closest('.cancel-btn');
        if (cancelBtn) {
            if (!confirm('您确定要取消这个分享连结吗？')) {
                return;
            }
            
            const itemType = cancelBtn.dataset.type;
            
            // --- *** 最终修正：移除 parseInt，因为文件 ID 可能是 BigInt string *** ---
            // 资料夹 ID (type=folder) 是安全的 int，但文件 ID (type=file) 必须是 string
            const itemId = (itemType === 'file') ? cancelBtn.dataset.id : parseInt(cancelBtn.dataset.id, 10);
            // --- *** 修正结束 *** ---

            try {
                const res = await axios.post('/api/cancel-share', { itemId, itemType });
                if (res.data.success) {
                    // alert('分享已取消');
                    loadShares();
                } else {
                    alert('取消分享失败: ' + res.data.message);
                }
            } catch (error) {
                alert('取消分享时发生错误: ' + (error.response?.data?.message || '伺服器错误'));
            }
            return;
        }
    });

    loadShares();
});
