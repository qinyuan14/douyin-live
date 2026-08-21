import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createRequire } from 'node:module';
import { AppModule } from './module.js';
import { configureLocalAccess, createRuntimeToken } from './runtime-auth.js';

// express 由 @nestjs/platform-express 带入依赖树，此处用 createRequire 动态加载
// 其 JSON 解析中间件（避免为类型声明额外依赖）。main.ts 作为入口不做静态类型检查。
const require = createRequire(import.meta.url);
const { json, urlencoded } = require('express') as {
  json: (options?: Record<string, unknown>) => (req: unknown, res: unknown, next: unknown) => void;
  urlencoded: (options?: Record<string, unknown>) => (req: unknown, res: unknown, next: unknown) => void;
};

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'], bodyParser: false });
// 证据文件以 base64 内嵌在 JSON 请求体中（约膨胀 1/3）。默认 100kb 限制会让稍大的
// 截图/PDF 直接 413「request entity too large」；禁用默认 parser 后手动放宽到 50mb
// （对应单文件上限约 37MB）。
app.use(json({ limit: '50mb' }) as never);
app.use(urlencoded({ extended: true, limit: '50mb' }) as never);
configureLocalAccess(app, createRuntimeToken());
app.setGlobalPrefix('api');
await app.listen(3188, '127.0.0.1');
