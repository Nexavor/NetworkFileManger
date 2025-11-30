// storage/s3.js
const AWS = require('aws-sdk');
const data = require('../data.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const FILE_NAME = 'storage/s3.js';
let s3Client = null;

// --- 日志辅助函数 (带时间戳) ---
const log = (level, func, message, ...args) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [S3:${level}] [${func}] - ${message}`, ...args);
};

function getS3Config() {
    const storageManager = require('./index'); 
    const config = storageManager.readConfig();
    const s3Config = config.s3 || {};
    if (!s3Config.bucket || !s3Config.region) {
        throw new Error('S3 存储配置不完整 (缺少 Bucket 或 Region)');
    }
    return s3Config;
}

function getClient() {
    const s3Config = getS3Config();

    if (!s3Client || s3Client.config.region !== s3Config.region || s3Client.config.credentials.accessKeyId !== s3Config.accessKeyId || s3Client.config.endpoint !== s3Config.endpoint) {
        log('INFO', 'getClient', '创建新的 S3 客户端');
        
        const clientConfig = {
            apiVersion: '2006-03-01',
            region: s3Config.region,
            accessKeyId: s3Config.accessKeyId,
            secretAccessKey: s3Config.secretAccessKey
        };

        if (s3Config.endpoint) {
            clientConfig.endpoint = s3Config.endpoint;
            clientConfig.s3ForcePathStyle = true; // MinIO 等自定义 Endpoint 通常需要
        }

        AWS.config.update(clientConfig);
        s3Client = new AWS.S3(clientConfig);
    }
    return s3Client;
}

function resetClient() {
    s3Client = null;
}

async function getFolderPath(folderId, userId) {
    // data.js 中的 getFolderPath 返回的路径数组，第一个元素是根目录 '/'
    const pathParts = await data.getFolderPath(folderId, userId);
    // S3路径不以斜杠开头，且根目录应为空字符串
    return pathParts.slice(1).map(p => p.name).join('/');
}

async function upload(fileStreamOrBuffer, fileName, mimetype, userId, folderId, caption = '', existingItem = null) {
    const FUNC_NAME = 'upload';
    const s3Config = getS3Config();
    const client = getClient();
    
    // 构造 S3 存储桶中的路径： user_{userId}/folder/path/filename
    const folderPath = await getFolderPath(folderId, userId);
    const key = path.posix.join(`user_${userId}`, folderPath, fileName).replace(/\\/g, '/').replace(/^\//, '');

    log('INFO', FUNC_NAME, `上传到 S3 路径: s3://${s3Config.bucket}/${key}`);

    // 如果是 Buffer，则获取长度
    let contentLength = Buffer.isBuffer(fileStreamOrBuffer) ? fileStreamOrBuffer.length : undefined;

    const uploadParams = {
        Bucket: s3Config.bucket,
        Key: key,
        Body: fileStreamOrBuffer,
        ContentType: mimetype,
        Metadata: {
            'x-amz-meta-original-filename': encodeURIComponent(fileName),
            'x-amz-meta-user-id': String(userId)
        }
    };
    
    if (contentLength !== undefined) {
         uploadParams.ContentLength = contentLength;
    }

    // 使用 ManagedUploads 以处理大文件和流
    try {
        const managedUpload = client.upload(uploadParams, { 
             queueSize: 4, // 并发数
             partSize: 5 * 1024 * 1024 // 5MB 分块
        });

        const dataUpload = await managedUpload.promise();
        log('INFO', FUNC_NAME, `S3 上传成功: ETag=${dataUpload.ETag}`);

        const fileStats = await client.headObject({ Bucket: s3Config.bucket, Key: key }).promise();
        const size = fileStats.ContentLength;

        if (existingItem) {
            log('INFO', FUNC_NAME, `更新数据库 (覆盖): ${existingItem.id}`);
            await data.updateFile(existingItem.id, {
                mimetype: mimetype,
                file_id: key, // S3 的 Key 作为 file_id
                size: size,
                date: Date.now(),
            }, userId);
            return { success: true, message: '覆盖成功', fileId: existingItem.id };
        } else {
            const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
            log('INFO', FUNC_NAME, `写入数据库 (新增): ${messageId}`);
            const dbResult = await data.addFile({
                message_id: messageId,
                fileName,
                mimetype,
                size: size,
                file_id: key,
                thumb_file_id: null,
                date: Date.now(),
            }, folderId, userId, 's3');
            return { success: true, message: '上传成功', fileId: dbResult.fileId };
        }

    } catch (error) {
        log('ERROR', FUNC_NAME, `上传至 S3 失败 for "${fileName}": ${error.message}`);
        
        if (fileStreamOrBuffer && typeof fileStreamOrBuffer.resume === 'function') {
            fileStreamOrBuffer.resume();
        }
        throw new Error(`上传至 S3 失败: ${error.message}`);
    }
}

async function remove(files, folders, userId) {
    const FUNC_NAME = 'remove';
    const client = getClient();
    const s3Config = getS3Config();
    const objectsToDelete = [];
    
    // 1. 收集文件对象
    files.forEach(file => {
        // file.file_id 是 S3 Key
        if (file.file_id) {
            objectsToDelete.push({ Key: file.file_id });
        }
    });

    // 2. 收集文件夹对象
    for (const folder of folders) {
        // 安全检查：防止删除根目录
        if (!folder.path || folder.path === '/' || folder.path === '\\' || folder.path === '.') {
            log('WARN', FUNC_NAME, '阻止删除 S3 用户根前缀 (path 为 /)');
            continue;
        }

        // folder.path: e.g. 'folder1/subfolder'
        let prefix = path.posix.join(`user_${userId}`, folder.path).replace(/\\/g, '/').replace(/^\//, '');
        if (!prefix.endsWith('/')) prefix += '/'; 
        
        // 再次安全检查：确保 prefix 不仅仅是 user_{userId}/
        // 虽然这会删除用户的所有数据，但至少确保前缀是正确的格式
        // 如果业务需求是允许用户删除所有数据，则不应在此拦截，
        // 但鉴于此处的 bug 是意外触发，我们做一层保护
        if (prefix === `user_${userId}/`) {
             log('WARN', FUNC_NAME, '阻止通过文件夹路径删除整个用户前缀');
             continue;
        }

        log('INFO', FUNC_NAME, `准备删除 S3 文件夹前缀下的对象: ${prefix}`);

        let token = null;
        do {
            const listParams = {
                Bucket: s3Config.bucket,
                Prefix: prefix,
                MaxKeys: 1000,
                ContinuationToken: token
            };
            const listedObjects = await client.listObjectsV2(listParams).promise();

            if (listedObjects.Contents) {
                listedObjects.Contents.forEach(({ Key }) => objectsToDelete.push({ Key }));
            }
            token = listedObjects.NextContinuationToken;
        } while (token);
    }
    
    if (objectsToDelete.length === 0) {
        return { success: true, errors: [] };
    }

    // 3. 批量删除
    const deleteParams = {
        Bucket: s3Config.bucket,
        Delete: {
            Objects: objectsToDelete.filter((v,i,a)=>a.findIndex(t=>(t.Key===v.Key))===i), // 去重
            Quiet: true
        }
    };
    
    try {
        // S3 DeleteObjects 每次最多 1000 个
        const chunkSize = 1000;
        for (let i = 0; i < deleteParams.Delete.Objects.length; i += chunkSize) {
            const chunk = deleteParams.Delete.Objects.slice(i, i + chunkSize);
            const chunkParams = { ...deleteParams, Delete: { ...deleteParams.Delete, Objects: chunk } };
            
            const result = await client.deleteObjects(chunkParams).promise();
            if (result.Errors && result.Errors.length > 0) {
                log('ERROR', FUNC_NAME, `批量删除部分失败: ${JSON.stringify(result.Errors)}`);
            }
        }
        
        return { success: true, errors: [] };

    } catch (error) {
        log('ERROR', FUNC_NAME, `S3 批量删除请求失败: ${error.message}`);
        return { success: false, errors: [error.message] };
    }
}

async function stream(file_id, userId, options = {}) {
    const client = getClient();
    const s3Config = getS3Config();
    
    // 构建 Range 头
    let range = undefined;
    if (options.start !== undefined && options.end !== undefined) {
         range = `bytes=${options.start}-${options.end}`;
    }

    const downloadParams = {
        Bucket: s3Config.bucket,
        Key: file_id,
        Range: range
    };
    
    // createReadStream 返回的是 AWS.S3.ManagedUpload.body，它是一个可读流
    const objectStream = client.getObject(downloadParams).createReadStream();

    // 确保流错误能被捕获
    return new Promise((resolve, reject) => {
        objectStream.on('error', (err) => {
            log('ERROR', 'stream', `S3 流读取失败: ${err.message}`);
            reject(err);
        });
        resolve(objectStream);
    });
}

async function getUrl(file_id, userId) {
    const client = getClient();
    const s3Config = getS3Config();

    const urlParams = {
        Bucket: s3Config.bucket,
        Key: file_id,
        Expires: 60 * 5 // 5 分钟有效期
    };
    
    try {
        // 生成预签名 URL
        const url = client.getSignedUrl('getObject', urlParams);
        return url;
    } catch (error) {
        log('ERROR', 'getUrl', `生成预签名 URL 失败: ${error.message}`);
        return null;
    }
}

module.exports = { upload, remove, getUrl, stream, resetClient, getClient, type: 's3' };
