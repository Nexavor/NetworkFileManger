document.addEventListener('DOMContentLoaded', () => {
    const userSelect = document.getElementById('user-select');
    const scanLocalBtn = document.getElementById('scan-local-btn');
    // *** 修改：改为获取按钮的容器 ***
    const webdavButtonsContainer = document.getElementById('webdav-scan-buttons');
    const scanLog = document.getElementById('scan-log');

    // 加载所有使用者到下拉选单
    async function loadUsers() {
        try {
            const response = await axios.get('/api/admin/all-users');
            userSelect.innerHTML = '<option value="" disabled selected>-- 请选择一个使用者 --</option>';
            response.data.forEach(user => {
                const option = document.createElement('option');
                option.value = user.id;
                option.textContent = user.username;
                userSelect.appendChild(option);
            });
        } catch (error) {
            logMessage('无法加载使用者列表: ' + (error.response?.data?.message || error.message), 'error');
        }
    }

    // *** 新生：加载 WebDAV 设定并渲染扫描按钮 ***
    async function loadWebdavConfigs() {
        try {
            const response = await axios.get('/api/admin/webdav');
            webdavButtonsContainer.innerHTML = ''; // 清空容器
            if (response.data.length === 0) {
                webdavButtonsContainer.innerHTML = '<p>尚未设定任何 WebDAV 伺服器。</p>';
            } else {
                response.data.forEach(config => {
                    const button = document.createElement('button');
                    button.className = 'upload-link-btn scan-webdav-btn';
                    button.style.backgroundColor = '#17a2b8';
                    button.dataset.configId = config.id;
                    button.innerHTML = `<i class="fas fa-server"></i> 扫描 ${config.url}`;
                    webdavButtonsContainer.appendChild(button);
                });
            }
        } catch (error) {
             webdavButtonsContainer.innerHTML = '<p>加载 WebDAV 设定失败。</p>';
        }
    }

    function logMessage(message, type = 'info') {
        const line = document.createElement('div');
        line.className = `log-${type}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        scanLog.appendChild(line);
        scanLog.scrollTop = scanLog.scrollHeight;
    }

    function disableButtons(disabled) {
        scanLocalBtn.disabled = disabled;
        document.querySelectorAll('.scan-webdav-btn').forEach(btn => btn.disabled = disabled);
        userSelect.disabled = disabled;
    }

    // *** 修改：startScan 函数现在接受 configId ***
    async function startScan(storageType, configId = null) {
        const userId = userSelect.value;
        if (!userId) {
            alert('请先选择一个要汇入的使用者！');
            return;
        }
        
        scanLog.innerHTML = '';
        let scanTarget = storageType.toUpperCase();
        if (storageType === 'webdav' && configId) {
            const btn = document.querySelector(`.scan-webdav-btn[data-config-id='${configId}']`);
            scanTarget = `WebDAV (ID: ${configId}, URL: ${btn.textContent.replace('扫描 ', '')})`;
        }
        logMessage(`开始扫描 ${scanTarget}，为使用者 ID: ${userId}`, 'info');
        disableButtons(true);

        try {
            // *** 修改：API 请求现在包含 configId (如果适用) ***
            const payload = { userId };
            if (configId) {
                payload.webdavConfigId = configId;
            }
            const response = await axios.post(`/api/scan/${storageType}`, payload);
            
            const logs = response.data.log;
            if (logs && Array.isArray(logs)) {
                logs.forEach(log => logMessage(log.message, log.type));
            }
            logMessage('扫描完成！', 'success');

        } catch (error) {
            logMessage('扫描时发生严重错误: ' + (error.response?.data?.message || error.message), 'error');
            const logs = error.response?.data?.log;
             if (logs && Array.isArray(logs)) {
                logs.forEach(log => logMessage(log.message, log.type));
            }
        } finally {
            disableButtons(false);
        }
    }

    scanLocalBtn.addEventListener('click', () => startScan('local'));
    
    // *** 修改：为动态按钮容器添加事件委托 ***
    webdavButtonsContainer.addEventListener('click', (e) => {
        const target = e.target.closest('.scan-webdav-btn');
        if (target) {
            const configId = target.dataset.configId;
            startScan('webdav', configId);
        }
    });

    loadUsers();
    loadWebdavConfigs(); // 页面加载时执行
});
