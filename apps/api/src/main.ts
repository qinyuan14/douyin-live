import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './module.js';
import { configureLocalAccess, createRuntimeToken } from './runtime-auth.js';

const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
configureLocalAccess(app, createRuntimeToken());
app.setGlobalPrefix('api');
await app.listen(3188, '127.0.0.1');
