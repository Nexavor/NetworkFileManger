// storage/s3.js
const { S3Client, DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, CopyObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const data = require('../data.js');
const crypto = require('crypto');
const path = require('path');

let s3Client = null;

function getS3Config() {
    const storageManager = require('./index');
    const config = storageManager.readConfig();
    const s3Conf = config.s3;
    if (!s3Conf || !s3Conf.bucket || !s3Conf.region || !s3Conf.accessKeyId || !s3Conf.secretAccessKey) {
        throw new Error('S3 设定不完整');
    }
    return s3Conf;
}

function getClient() {
    if (!s3Client) {
        const config = getS3Config();
        s3Client = new S3Client({
            region: config.region,
            endpoint: config.endpoint, // 可选，用于兼容 MinIO, R2 等
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey
            },
            forcePathStyle: true // 某些 S3 兼容服务需要
        });
    }
    return s3Client;
}

function resetClient() {
    s3Client = null;
}

async function upload(fileStreamOrBuffer, fileName, mimetype, userId, folderId, caption = '', existingItem = null) {
    const config = getS3Config();
    const client = getClient();
    const key = `uploads/${userId}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${fileName}`;

    const upload = new Upload({
        client: client,
        params: {
            Bucket: config.bucket,
            Key: key,
            Body: fileStreamOrBuffer,
            ContentType: mimetype
        }
    });

    try {
        const result = await upload.done();
        // 获取文件大小
        const headCmd = new HeadObjectCommand({ Bucket: config.bucket, Key: key });
        const head = await client.send(headCmd);
        const size = head.ContentLength;

        if (existingItem) {
            // 如果覆盖，删除旧的 S3 对象（可选，或者保留作为版本历史，这里选择删除以节省空间）
            try {
                await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: existingItem.file_id }));
            } catch(e) {}

            await data.updateFile(existingItem.message_id, {
                mimetype: mimetype,
                file_id: key,
                size: size,
                date: Date.now(),
            }, userId);
            return { success: true, message: '覆盖成功', fileId: existingItem.message_id };
        } else {
            const messageId = BigInt(Date.now()) * 1000000n + BigInt(crypto.randomInt(1000000));
            const dbResult = await data.addFile({
                message_id: messageId,
                fileName,
                mimetype,
                size: size,
                file_id: key,
                date: Date.now(),
            }, folderId, userId, 's3');
            return { success: true, message: '上传成功', fileId: dbResult.fileId };
        }
    } catch (error) {
        throw new Error(`S3 上传失败: ${error.message}`);
    }
}

async function remove(files, folders, userId) {
    const config = getS3Config();
    const client = getClient();
    const results = { success: true, errors: [] };

    for (const file of files) {
        try {
            await client.send(new DeleteObjectCommand({
                Bucket: config.bucket,
                Key: file.file_id
            }));
        } catch (error) {
            results.errors.push(`S3 删除失败: ${error.message}`);
            results.success = false;
        }
    }
    // S3 没有文件夹的实体概念，通常不需要删除文件夹对象，除非有占位符
    return results;
}

async function getUrl(file_id) {
    // 对于私有桶，通常生成预签名 URL。这里简单起见，假设通过后端流式传输
    return null; 
}

async function stream(file_id, userId, options = {}) {
    const config = getS3Config();
    const client = getClient();
    const commandParams = {
        Bucket: config.bucket,
        Key: file_id
    };
    if (options.start !== undefined && options.end !== undefined) {
        commandParams.Range = `bytes=${options.start}-${options.end}`;
    }

    const command = new GetObjectCommand(commandParams);
    const response = await client.send(command);
    return response.Body; // 这是一个可读流
}

async function copy(file, newFileName, userId) {
    const config = getS3Config();
    const client = getClient();
    const newKey = `uploads/${userId}/${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${newFileName}`;

    try {
        await client.send(new CopyObjectCommand({
            Bucket: config.bucket,
            CopySource: encodeURI(`${config.bucket}/${file.file_id}`), // S3 CopySource 需要包含 Bucket
            Key: newKey
        }));
        return newKey; // 返回新的 file_id
    } catch (error) {
        throw new Error(`S3 复制失败: ${error.message}`);
    }
}

module.exports = { upload, remove, getUrl, stream, copy, resetClient, type: 's3' };
