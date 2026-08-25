import { Module } from '@nestjs/common';
import { AppController } from './controller.js';
import { LiveService } from './service.js';

@Module({
  controllers: [AppController],
  providers: [LiveService],
})
export class AppModule {}

